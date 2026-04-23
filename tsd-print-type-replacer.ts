#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-sys=cpus
/**
 * tsd-print-type-replacer
 *
 * Runs tsd to collect `printType` warnings, then rewrites the matching
 * `{} as T` type assertions in the source files to use the type tsd reported.
 *
 * Usage:
 *   deno run --allow-read --allow-write=. --allow-env --allow-sys=cpus tsd-print-type-replacer.ts [options] [target-dir]
 */

import ts from "npm:typescript@5.6.3";
import parseArgs from "npm:minimist@1.2.8";
import * as path from "node:path";
import { styleText } from "node:util";

const HELP = `tsd-print-type-replacer - rewrite \`{} as T\` assertions from tsd printType output

USAGE
  deno run --allow-read --allow-write=. --allow-env --allow-sys=cpus tsd-print-type-replacer.ts [options] [target-dir]
  tsd 2>&1 | deno run --allow-read --allow-write=. tsd-print-type-replacer.ts --stdin [options] [target-dir]

  By default, runs tsd directly via its programmatic API to obtain accurate
  diagnostic messages (avoids eslint-formatter-pretty mangling backticks in
  template literal types).

  With --stdin, reads tsd's formatted text output from stdin instead (legacy
  mode — subject to formatter quirks with backticks and multiline expressions).

ARGUMENTS
  target-dir  Project root directory (default: ".")
              In default mode, this is the cwd passed to tsd (must contain
              package.json). In --stdin mode, it resolves relative file paths
              from tsd output.

OPTIONS
  -n, --next-statement-only   Only rewrite the statement immediately after each
                              printType call. By default, every matching
                              expression in the file is rewritten.
      --dry-run               Show a unified diff of planned edits without
                              writing files. Colors the output on a TTY.
      --stdin                 Read tsd's formatted output from stdin instead of
                              running tsd directly.
  -h, --help                  Show this help.
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
// tsd programmatic API
// ---------------------------------------------------------------------------

/**
 * Parse a raw tsd diagnostic message of the form:
 *   Type for expression `EXPR` is: `TYPE`
 * Returns the expression and type strings, or null if the message doesn't match.
 */
function parsePrintTypeDiagnostic(
  message: string,
): { expression: string; type: string } | null {
  const prefix = "Type for expression `";
  if (!message.startsWith(prefix) || !message.endsWith("`")) return null;

  const inner = message.slice(prefix.length, -1);
  const sep = "` is: `";
  const sepIdx = inner.indexOf(sep);
  if (sepIdx < 0) return null;

  return {
    expression: inner.slice(0, sepIdx),
    type: inner.slice(sepIdx + sep.length),
  };
}

interface TsdApiDiagnostic {
  fileName: string;
  message: string;
  severity: string;
  line?: number;
  column?: number;
}

let tsdRunPromise:
  | Promise<(options: { cwd: string }) => Promise<TsdApiDiagnostic[]>>
  | null = null;

async function loadTsdRun(): Promise<
  (options: { cwd: string }) => Promise<TsdApiDiagnostic[]>
> {
  if (!tsdRunPromise) {
    tsdRunPromise = import("npm:tsd@0.33.0").then((mod) => {
      // tsd is CJS; its default export (the runner function) is nested under .default
      // deno-lint-ignore no-explicit-any
      return ((mod as any).default.default) as (
        options: { cwd: string },
      ) => Promise<TsdApiDiagnostic[]>;
    });
  }
  return await tsdRunPromise;
}

async function runTsdDirect(cwd: string): Promise<TsdDiag[]> {
  const absDir = path.resolve(cwd);
  console.error(`tsd-print-type-replacer: running tsd in ${absDir}…`);

  let rawDiagnostics: TsdApiDiagnostic[];
  try {
    const tsdRun = await loadTsdRun();
    rawDiagnostics = await tsdRun({ cwd: absDir });
  } catch (err) {
    console.error(
      `tsd-print-type-replacer: tsd failed: ${(err as Error).message}`,
    );
    Deno.exit(1);
  }

  const results: TsdDiag[] = [];
  for (const diag of rawDiagnostics) {
    if (diag.severity !== "warning") continue;

    const parsed = parsePrintTypeDiagnostic(diag.message);
    if (!parsed) continue;

    results.push({
      filePath: diag.fileName,
      line: diag.line ?? 0,
      column: diag.column ?? 0,
      expression: parsed.expression,
      type: parsed.type,
    });
  }

  console.error(
    `tsd-print-type-replacer: found ${results.length} printType diagnostic(s) from tsd`,
  );
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

function isPrintTypeCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "printType") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "printType")
  );
}

function liftThroughParentheses(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (cur.parent && ts.isParenthesizedExpression(cur.parent)) {
    cur = cur.parent;
  }
  return cur;
}

function isCommaBinaryExpression(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.CommaToken;
}

function flattenCommaOperands(expr: ts.Expression): ts.Expression[] {
  if (!isCommaBinaryExpression(expr)) return [expr];
  return [
    ...flattenCommaOperands(expr.left),
    ...flattenCommaOperands(expr.right),
  ];
}

function findCommaContext(
  expr: ts.Expression,
): {
  root: ts.BinaryExpression;
  operands: ts.Expression[];
  index: number;
} | null {
  let current: ts.Expression = expr;
  let root: ts.BinaryExpression | null = null;

  while (
    current.parent &&
    isCommaBinaryExpression(current.parent) &&
    (current.parent.left === current || current.parent.right === current)
  ) {
    root = current.parent;
    current = current.parent;
  }

  if (!root) return null;

  const operands = flattenCommaOperands(root);
  const index = operands.indexOf(expr);
  if (index < 0) return null;

  return { root, operands, index };
}

function lineStartPos(source: string, pos: number): number {
  let i = pos;
  while (i > 0 && source[i - 1] !== "\n" && source[i - 1] !== "\r") i--;
  return i;
}

function expandStatementDeletionRange(
  source: string,
  stmt: ts.Statement,
  sf: ts.SourceFile,
): { start: number; end: number } {
  let start = stmt.getStart(sf);
  const lineStart = lineStartPos(source, start);
  if (/^[\t ]*$/.test(source.slice(lineStart, start))) {
    start = lineStart;
  }

  let end = stmt.getEnd();
  let i = end;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  if (i >= source.length) {
    end = source.length;
  } else if (source[i] === "\r" && source[i + 1] === "\n") {
    end = i + 2;
  } else if (source[i] === "\n" || source[i] === "\r") {
    end = i + 1;
  }

  return { start, end };
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

function findSourceAsExpression(
  call: ts.CallExpression,
  exprTokens: Tok[],
  sf: ts.SourceFile,
): ts.AsExpression | null {
  for (const cand of collectAsExpressions(call)) {
    if (tokensEqual(tokenize(cand.getText(sf)), exprTokens)) {
      return cand;
    }
  }
  return null;
}

function buildDeleteSourceCallEdit(
  source: string,
  fileName: string,
  call: ts.CallExpression,
  sf: ts.SourceFile,
): Edit {
  const liftedCall = liftThroughParentheses(call);

  if (
    liftedCall.parent &&
    ts.isExpressionStatement(liftedCall.parent) &&
    liftedCall.parent.expression === liftedCall
  ) {
    const range = expandStatementDeletionRange(source, liftedCall.parent, sf);
    return {
      start: range.start,
      end: range.end,
      newText: "",
      note: `${fileName}: delete source printType statement at ${range.start}..${range.end}`,
    };
  }

  const comma = findCommaContext(liftedCall);
  if (comma) {
    if (comma.index < comma.operands.length - 1) {
      const nextOperand = comma.operands[comma.index + 1];
      return {
        start: liftedCall.getStart(sf),
        end: nextOperand.getStart(sf),
        newText: "",
        note: `${fileName}: remove source printType comma operand at ${liftedCall.getStart(sf)}..${
          nextOperand.getStart(sf)
        }`,
      };
    }

    const leftText = comma.root.left.getText(sf);
    return {
      start: comma.root.getStart(sf),
      end: comma.root.getEnd(),
      newText: `void (${leftText})`,
      note: `${fileName}: replace trailing source printType comma operand at ${
        comma.root.getStart(sf)
      }..${comma.root.getEnd()} with \`void (${leftText})\``,
    };
  }

  return {
    start: liftedCall.getStart(sf),
    end: liftedCall.getEnd(),
    newText: "void 0",
    note: `${fileName}: replace source printType call at ${
      liftedCall.getStart(sf)
    }..${liftedCall.getEnd()} with \`void 0\``,
  };
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

    const call = findCallAtPosition(sf, diag.line, diag.column);
    if (!call || !isPrintTypeCall(call)) {
      warnings.push(
        `${fileName}:${diag.line}:${diag.column}: could not locate source printType call; skipped`,
      );
      continue;
    }

    const sourceAsExpr = findSourceAsExpression(call, exprTokens, sf);
    if (!sourceAsExpr) {
      warnings.push(
        `${fileName}:${diag.line}:${diag.column}: source printType call does not contain matching \`as\` expression; skipped`,
      );
      continue;
    }

    let scope: ts.Node | null = sf;
    if (nextStatementOnly) {
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
      if (cand === sourceAsExpr) continue;

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
        `${fileName}:${diag.line}:${diag.column}: no matching \`as\` expression found outside source printType call for: ${diag.expression}`,
      );
      continue;
    }

    edits.push(buildDeleteSourceCallEdit(source, fileName, call, sf));
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
// Myers line diff (with prefix/suffix trimming + D-cap heuristic)
// ---------------------------------------------------------------------------

// Tuple shape matches node:util.diff: op is 0 (unchanged), 1 (only in `a`),
// or -1 (only in `b`).
type DiffOp = [0 | 1 | -1, string];

// If the edit distance exceeds this, we give up the optimal diff and just
// emit "remove everything / add everything" for the differing middle. Keeps
// memory bounded at ~O(D·(N+M)) without compromising typical source-file
// workloads, where D is tiny.
const MYERS_D_CAP = 4000;

function myersLineDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Heuristic 1: strip common prefix and suffix. Huge speedup for typical
  // "rewrite a few lines in a mostly identical file" diffs.
  const N0 = a.length;
  const M0 = b.length;
  let prefix = 0;
  while (prefix < N0 && prefix < M0 && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < N0 - prefix &&
    suffix < M0 - prefix &&
    a[N0 - 1 - suffix] === b[M0 - 1 - suffix]
  ) suffix++;

  const out: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) out.push([0, a[i]]);

  const aMid = a.slice(prefix, N0 - suffix);
  const bMid = b.slice(prefix, M0 - suffix);
  if (aMid.length === 0) {
    for (const s of bMid) out.push([-1, s]);
  } else if (bMid.length === 0) {
    for (const s of aMid) out.push([1, s]);
  } else {
    for (const op of myersCore(aMid, bMid)) out.push(op);
  }

  for (let i = 0; i < suffix; i++) out.push([0, a[N0 - suffix + i]]);
  return out;
}

function myersCore(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Classic O((N+M)D) Myers: walk increasing edit distances d, track the
  // furthest-reaching x on each diagonal k = x - y in V[], snapshotting V
  // on each iteration so we can backtrack the edit script at the end.
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const offset = MAX;
  const V = new Int32Array(2 * MAX + 1);
  const trace: Int32Array[] = [];
  const dCap = Math.min(MAX, MYERS_D_CAP);

  let foundD = -1;
  outer: for (let d = 0; d <= dCap; d++) {
    trace.push(new Int32Array(V));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        x = V[offset + k + 1]; // insertion from b (down)
      } else {
        x = V[offset + k - 1] + 1; // deletion from a (right)
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      V[offset + k] = x;
      if (x >= N && y >= M) {
        foundD = d;
        break outer;
      }
    }
  }

  // Heuristic 2: cap on D. If the edit distance is pathologically large we
  // fall back to the trivial "remove a, add b" diff rather than blow memory.
  if (foundD < 0) {
    const fallback: DiffOp[] = [];
    for (const s of a) fallback.push([1, s]);
    for (const s of b) fallback.push([-1, s]);
    return fallback;
  }

  const ops: DiffOp[] = [];
  let x = N;
  let y = M;
  for (let d = foundD; d > 0; d--) {
    const Vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && Vd[offset + k - 1] < Vd[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = Vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([0, a[x - 1]]);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push([-1, b[y - 1]]);
      y--;
    } else {
      ops.push([1, a[x - 1]]);
      x--;
    }
  }
  // d=0: drain the remaining diagonal back to the origin.
  while (x > 0 && y > 0) {
    ops.push([0, a[x - 1]]);
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

// ---------------------------------------------------------------------------
// Unified diff rendering (for --dry-run)
// ---------------------------------------------------------------------------

type DiffLineKind = " " | "-" | "+";

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ kind: DiffLineKind; text: string }>;
}

function buildHunks(
  oldContent: string,
  newContent: string,
  context: number,
): DiffHunk[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // myersLineDiff(a, b) returns [op, value] tuples where
  //   op ===  0 → unchanged
  //   op ===  1 → only in `a` (old) → render as "-"
  //   op === -1 → only in `b` (new) → render as "+"
  const ops = myersLineDiff(oldLines, newLines);

  const lines: Array<{ kind: DiffLineKind; text: string }> = ops.map(
    ([op, text]) => ({
      kind: op === 0 ? " " : op === 1 ? "-" : "+",
      text,
    }),
  );

  const positions: Array<{ oldPos: number; newPos: number }> = [];
  {
    let oldPos = 1;
    let newPos = 1;
    for (const ln of lines) {
      positions.push({ oldPos, newPos });
      if (ln.kind !== "+") oldPos++;
      if (ln.kind !== "-") newPos++;
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === " ") {
      i++;
      continue;
    }

    let start = i;
    let back = 0;
    while (start > 0 && lines[start - 1].kind === " " && back < context) {
      start--;
      back++;
    }

    let end = i;
    while (end < lines.length) {
      while (end < lines.length && lines[end].kind !== " ") end++;
      let gap = 0;
      while (
        end + gap < lines.length &&
        lines[end + gap].kind === " " &&
        gap < context * 2
      ) gap++;
      if (end + gap < lines.length && lines[end + gap].kind !== " ") {
        end += gap;
        continue;
      }
      end += Math.min(context, gap);
      break;
    }

    const body = lines.slice(start, end);
    let oldCount = 0;
    let newCount = 0;
    for (const ln of body) {
      if (ln.kind !== "+") oldCount++;
      if (ln.kind !== "-") newCount++;
    }
    const anchor = positions[start] ?? { oldPos: 1, newPos: 1 };
    hunks.push({
      oldStart: oldCount === 0 ? anchor.oldPos - 1 : anchor.oldPos,
      oldCount,
      newStart: newCount === 0 ? anchor.newPos - 1 : anchor.newPos,
      newCount,
      lines: body,
    });

    i = end;
  }

  return hunks;
}

type StyleTextFormat = Parameters<typeof styleText>[0];

function renderUnifiedDiff(
  oldContent: string,
  newContent: string,
  displayPath: string,
  useColor: boolean,
): string {
  // Deno 2.7's styleText doesn't actually gate on the target stream, so we
  // keep our own `useColor` decision (set in main() from Deno.stdout.isTerminal)
  // and force styleText to apply the escape codes with validateStream:false.
  const paint = (format: StyleTextFormat, text: string) =>
    useColor ? styleText(format, text, { validateStream: false }) : text;

  const hunks = buildHunks(oldContent, newContent, 3);
  if (hunks.length === 0) return "";

  const out: string[] = [];
  out.push(paint("bold", `--- a/${displayPath}`));
  out.push(paint("bold", `+++ b/${displayPath}`));
  for (const h of hunks) {
    out.push(
      paint(
        "cyan",
        `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
      ),
    );
    for (const ln of h.lines) {
      if (ln.kind === "-") out.push(paint("red", `-${ln.text}`));
      else if (ln.kind === "+") out.push(paint("green", `+${ln.text}`));
      else out.push(` ${ln.text}`);
    }
  }
  return out.join("\n");
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
    boolean: ["next-statement-only", "dry-run", "help", "stdin"],
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
  const useStdin = Boolean(args.stdin);

  const useColor = dryRun && Deno.stdout.isTerminal();

  let diagnostics: TsdDiag[];
  if (useStdin) {
    const raw = await readStdin();
    diagnostics = parseTsdOutput(raw);
  } else {
    diagnostics = await runTsdDirect(baseDir);
  }

  if (diagnostics.length === 0) {
    console.error(
      useStdin
        ? "tsd-print-type-replacer: no `Type for expression ... is: ...` diagnostics found on stdin."
        : "tsd-print-type-replacer: no printType diagnostics found (tsd returned 0 matching warnings).",
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
      const displayPath = path.relative(Deno.cwd(), filePath) || filePath;
      const rendered = renderUnifiedDiff(source, output, displayPath, useColor);
      if (rendered) console.log(rendered);
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
