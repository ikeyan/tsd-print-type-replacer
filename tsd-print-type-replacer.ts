#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * tsd-print-type-replacer
 *
 * Reads tsd's `printType` warnings from stdin, then rewrites the matching
 * `{} as T` type assertions in the source files to use the type tsd reported.
 *
 * Usage:
 *   tsd | deno run --allow-read --allow-write=. tsd-print-type-replacer.ts [options] [target-dir]
 */

import ts from "npm:typescript@5.6.3";
import parseArgs from "npm:minimist@1.2.8";
import * as path from "node:path";

const HELP = `tsd-print-type-replacer - rewrite \`{} as T\` assertions from tsd printType output

USAGE
  tsd 2>&1 | deno run --allow-read --allow-write=. tsd-print-type-replacer.ts [options] [target-dir]

  Note: tsd writes its formatted diagnostics to stderr, so remember to redirect
  stderr into the pipe with \`2>&1\`.

ARGUMENTS
  target-dir  Base directory for resolving tsd file paths (default: ".")

OPTIONS
  -n, --next-statement-only   Only rewrite the statement immediately after each
                              printType call. By default, every matching
                              expression in the file is rewritten.
      --dry-run               Show planned edits without writing files.
  -h, --help                  Show this help.

INPUT
  The output of \`tsd\` on stdin. Each printType diagnostic has the form
    ⚠  LINE:COL  Type for expression EXPR is: TYPE
  When EXPR is a type assertion (\`X as T\`), the tool rewrites the \`T\` part
  to the reported TYPE. Matching ignores whitespace and comments (token-based).
`;

// ---------------------------------------------------------------------------
// tsd output parsing
// ---------------------------------------------------------------------------

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface TsdDiag {
  filePath: string;
  line: number; // 1-based
  column: number; // 0-based (as tsd emits)
  expression: string;
  type: string;
}

function parseTsdOutput(raw: string): TsdDiag[] {
  const text = raw.replace(ANSI_RE, "");
  const lines = text.split(/\r?\n/);
  const results: TsdDiag[] = [];
  let currentFile: string | null = null;

  // eslint-formatter-pretty file header: "  <relative path>:<line>:<col>"
  const headerRe = /^\s+(\S.*?):(\d+):(\d+)\s*$/;
  // Message line: "  <symbol>  <line>:<col>  Type for expression ... is: ..."
  // The leading symbol may be unicode (⚠ / ✖) or missing. We anchor on the
  // "Type for expression" sentinel instead.
  const msgRe = /^\s*\S?\s*(\d+):(\d+)\s+Type for expression\s+(.+?)\s+is:\s+(.+?)\s*$/u;

  for (const line of lines) {
    const m = line.match(msgRe);
    if (m && currentFile) {
      results.push({
        filePath: currentFile,
        line: parseInt(m[1], 10),
        column: parseInt(m[2], 10),
        expression: m[3],
        type: m[4],
      });
      continue;
    }

    if (line.includes("Type for expression")) continue;

    const h = line.match(headerRe);
    if (h) {
      const candidate = h[1];
      // Heuristic: looks like a path (contains '.' or '/')
      if (/[./\\]/.test(candidate)) currentFile = candidate;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Token-based normalization (whitespace + comments agnostic)
// ---------------------------------------------------------------------------

interface Tok {
  kind: ts.SyntaxKind;
  text: string;
}

function tokenize(text: string): Tok[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens: Tok[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push({ kind, text: scanner.getTokenText() });
    kind = scanner.scan();
  }
  return tokens;
}

function tokensEqual(a: Tok[], b: Tok[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind) return false;
    if (a[i].text !== b[i].text) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function findCallAtPosition(
  sf: ts.SourceFile,
  line: number, // 1-based
  column: number, // 0-based
): ts.CallExpression | null {
  let target: number;
  try {
    target = sf.getPositionOfLineAndCharacter(line - 1, column);
  } catch {
    return null;
  }

  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && node.getStart(sf) === target) {
      found = node;
      return;
    }
    if (node.getStart(sf) <= target && node.getEnd() >= target) {
      node.forEachChild(visit);
    }
  };
  sf.forEachChild(visit);
  return found;
}

function containingStatement(node: ts.Node): ts.Statement | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isStatement(cur) && cur.parent) return cur as ts.Statement;
    cur = cur.parent;
  }
  return null;
}

function nextSiblingStatement(stmt: ts.Statement): ts.Statement | null {
  const parent = stmt.parent as ts.Node & {
    statements?: ts.NodeArray<ts.Statement>;
  };
  const list = parent?.statements;
  if (!list) return null;
  const idx = list.indexOf(stmt);
  if (idx < 0 || idx >= list.length - 1) return null;
  return list[idx + 1];
}

function collectAsExpressions(root: ts.Node): ts.AsExpression[] {
  const out: ts.AsExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isAsExpression(n)) out.push(n);
    n.forEachChild(visit);
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
  newText: string;
  note: string;
}

function processFile(
  source: string,
  fileName: string,
  diagnostics: TsdDiag[],
  nextStatementOnly: boolean,
): { output: string; edits: Edit[]; warnings: string[] } {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const edits: Edit[] = [];
  const warnings: string[] = [];

  for (const diag of diagnostics) {
    const exprTokens = tokenize(diag.expression);
    if (exprTokens.length === 0) {
      warnings.push(
        `${fileName}:${diag.line}:${diag.column}: empty expression; skipped`,
      );
      continue;
    }

    // Only meaningful for AsExpression ("X as T") results.
    const isAsShape = exprTokens.some(
      (t) => t.kind === ts.SyntaxKind.AsKeyword,
    );
    if (!isAsShape) {
      warnings.push(
        `${fileName}:${diag.line}:${diag.column}: expression is not a type assertion (no \`as\`); skipped: ${diag.expression}`,
      );
      continue;
    }

    let scope: ts.Node | null = sf;
    if (nextStatementOnly) {
      const call = findCallAtPosition(sf, diag.line, diag.column);
      if (!call) {
        warnings.push(
          `${fileName}:${diag.line}:${diag.column}: could not locate printType call; skipped`,
        );
        continue;
      }
      const stmt = containingStatement(call);
      if (!stmt) {
        warnings.push(
          `${fileName}:${diag.line}:${diag.column}: no containing statement; skipped`,
        );
        continue;
      }
      const next = nextSiblingStatement(stmt);
      if (!next) {
        warnings.push(
          `${fileName}:${diag.line}:${diag.column}: no following statement; skipped`,
        );
        continue;
      }
      scope = next;
    }

    const candidates = collectAsExpressions(scope);
    let matched = 0;
    for (const cand of candidates) {
      const candText = cand.getText(sf);
      const candTokens = tokenize(candText);
      if (!tokensEqual(candTokens, exprTokens)) continue;

      const typeNode = cand.type;
      edits.push({
        start: typeNode.getStart(sf),
        end: typeNode.getEnd(),
        newText: diag.type,
        note: `${fileName}: replace type at ${
          typeNode.getStart(sf)
        }..${typeNode.getEnd()} with \`${diag.type}\``,
      });
      matched++;
    }

    if (matched === 0) {
      warnings.push(
        `${fileName}:${diag.line}:${diag.column}: no matching \`as\` expression found for: ${diag.expression}`,
      );
    }
  }

  // Dedupe identical edits (same start/end/newText)
  const seen = new Set<string>();
  const unique: Edit[] = [];
  for (const e of edits) {
    const key = `${e.start}:${e.end}:${e.newText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  // Apply edits from last to first so offsets stay valid.
  unique.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of unique) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }

  return { output: out, edits: unique, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf);
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["next-statement-only", "dry-run", "help"],
    alias: { n: "next-statement-only", h: "help" },
  });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const positional = args._ as Array<string | number>;
  const baseDir = positional.length > 0 ? String(positional[0]) : ".";
  const nextOnly = Boolean(args["next-statement-only"]);
  const dryRun = Boolean(args["dry-run"]);

  const raw = await readStdin();
  const diagnostics = parseTsdOutput(raw);

  if (diagnostics.length === 0) {
    console.error(
      "tsd-print-type-replacer: no `Type for expression ... is: ...` diagnostics found on stdin.",
    );
    return;
  }

  const byFile = new Map<string, TsdDiag[]>();
  for (const d of diagnostics) {
    const full = path.isAbsolute(d.filePath) ? d.filePath : path.resolve(baseDir, d.filePath);
    const list = byFile.get(full) ?? [];
    list.push(d);
    byFile.set(full, list);
  }

  let totalEdits = 0;
  let filesChanged = 0;
  for (const [filePath, diags] of byFile) {
    let source: string;
    try {
      source = await Deno.readTextFile(filePath);
    } catch (err) {
      console.error(
        `tsd-print-type-replacer: cannot read ${filePath}: ${(err as Error).message}`,
      );
      continue;
    }

    const { output, edits, warnings } = processFile(
      source,
      filePath,
      diags,
      nextOnly,
    );

    for (const w of warnings) console.error(`  warn: ${w}`);

    if (edits.length === 0) continue;
    totalEdits += edits.length;

    if (output === source) continue;

    if (dryRun) {
      console.log(`[dry-run] ${filePath}: ${edits.length} edit(s)`);
      for (const e of edits) console.log(`  ${e.note}`);
    } else {
      await Deno.writeTextFile(filePath, output);
      console.log(`updated ${filePath} (${edits.length} edit(s))`);
    }
    filesChanged++;
  }

  console.error(
    `tsd-print-type-replacer: ${totalEdits} edit(s) across ${filesChanged} file(s)${
      dryRun ? " (dry run)" : ""
    }`,
  );
}

if (import.meta.main) {
  await main();
}
