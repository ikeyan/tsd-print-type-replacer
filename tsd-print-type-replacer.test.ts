import * as path from "node:path";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const b = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a !== b) {
    const header = msg ? `${msg}\n` : "";
    throw new Error(
      `${header}assertEquals failed:\n--- expected ---\n${b}\n--- actual ---\n${a}\n`,
    );
  }
}

const MOD = new URL("./tsd-print-type-replacer.ts", import.meta.url).pathname;

async function runCli(
  args: string[],
  stdin: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", "--allow-env", MOD, ...args],
    cwd,
    env: {
      ...Deno.env.toObject(),
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const w = proc.stdin.getWriter();
  await w.write(new TextEncoder().encode(stdin));
  await w.close();
  const { code, stdout, stderr } = await proc.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("parses tsd warning and replaces matching `as` assertion", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {expectType, printType} from 'tsd';

type ObjectMerge<A, B> = Omit<A, keyof B> & B;

printType({} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
expectType<{0: string; '1': number}>(
\t{} as ObjectMerge<{'0': number; '1': number}, {0: string}>);
`;
  await Deno.writeTextFile(file, before);

  // The printType line is line 5 (1-based), col 0 (the call itself starts at col 0).
  const tsdOutput = `
  ${relFile}:5:0

  ⚠  5:0  Type for expression {} as ObjectMerge<{'0': number; '1': number}, {0: string}> is: { 0: string; '1': number; }

  1 warning
`;

  const res = await runCli([tmp], tsdOutput, tmp);
  if (res.code !== 0) {
    console.log("stdout:", res.stdout);
    console.log("stderr:", res.stderr);
  }
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  // Both occurrences should be rewritten (default: whole-file search).
  const expected = `import {expectType, printType} from 'tsd';

type ObjectMerge<A, B> = Omit<A, keyof B> & B;

printType({} as { 0: string; '1': number; });
expectType<{0: string; '1': number}>(
\t{} as { 0: string; '1': number; });
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("`--next-statement-only` rewrites only the following statement", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {expectType, printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({} as M<{a: 1}, {a: 2}>);
expectType<{a: 2}>({} as M<{a: 1}, {a: 2}>);
// a later use of the same assertion should NOT be touched
const x = {} as M<{a: 1}, {a: 2}>;
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = `
  ${relFile}:5:0

  ⚠  5:0  Type for expression {} as M<{a: 1}, {a: 2}> is: { a: 2; }
`;

  const res = await runCli(
    [
      "--next-statement-only",
      tmp,
    ],
    tsdOutput,
    tmp,
  );
  if (res.code !== 0) {
    console.log("stdout:", res.stdout);
    console.log("stderr:", res.stderr);
  }
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {expectType, printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({} as M<{a: 1}, {a: 2}>);
expectType<{a: 2}>({} as { a: 2; });
// a later use of the same assertion should NOT be touched
const x = {} as M<{a: 1}, {a: 2}>;
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("whitespace + comments inside the expression are ignored when matching", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  // Source contains extra whitespace and a comment inside the type arg list;
  // tsd's reported expression has neither.
  const before = `import {expectType, printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({}   as   M<{a: 1}, /* inline */ {a: 2}>);
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = `
  ${relFile}:5:0

  ⚠  5:0  Type for expression {} as M<{a: 1}, {a: 2}> is: { a: 2; }
`;

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {expectType, printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({}   as   { a: 2; });
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("skips expressions that are not type assertions", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';
const x = 1;
printType(x);
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = `
  ${relFile}:3:0

  ⚠  3:0  Type for expression x is: 1
`;

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  assertEquals(after, before);
  await Deno.remove(tmp, { recursive: true });
});
