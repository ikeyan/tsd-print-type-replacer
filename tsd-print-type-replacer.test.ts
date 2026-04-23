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

function assertIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    const header = msg ? `${msg}\n` : "";
    throw new Error(
      `${header}assertIncludes failed:\n--- expected substring ---\n${expected}\n--- actual ---\n${actual}\n`,
    );
  }
}

const MOD = new URL("./tsd-print-type-replacer.ts", import.meta.url).pathname;

function makeTsdOutput(
  relFile: string,
  line: number,
  column: number,
  expression: string,
  type: string,
): string {
  return `
  ${relFile}:${line}:${column}

  ⚠  ${line}:${column}  Type for expression ${expression} is: ${type}
`;
}

async function runCli(
  args: string[],
  stdin: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      MOD,
      "--stdin",
      ...args,
    ],
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

Deno.test(
  "replaces matching target assertion and deletes source printType statement",
  async () => {
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

    const tsdOutput = makeTsdOutput(
      relFile,
      5,
      0,
      "{} as ObjectMerge<{'0': number; '1': number}, {0: string}>",
      "{ 0: string; '1': number; }",
    );

    const res = await runCli([tmp], tsdOutput, tmp);
    assertEquals(res.code, 0);

    const after = await Deno.readTextFile(file);
    const expected = `import {expectType, printType} from 'tsd';

type ObjectMerge<A, B> = Omit<A, keyof B> & B;

expectType<{0: string; '1': number}>(
\t{} as { 0: string; '1': number; });
`;
    assertEquals(after, expected);

    await Deno.remove(tmp, { recursive: true });
  },
);

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

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    0,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli(["--next-statement-only", tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {expectType, printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

expectType<{a: 2}>({} as { a: 2; });
// a later use of the same assertion should NOT be touched
const x = {} as M<{a: 1}, {a: 2}>;
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("whitespace and comments are ignored when matching replacement targets", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({}   as   M<{a: 1}, /* inline */ {a: 2}>);
const x = {} as M<{a: 1}, {a: 2}>;
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    0,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = {} as { a: 2; };
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

  const tsdOutput = makeTsdOutput(relFile, 3, 0, "x", "1");

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  assertEquals(after, before);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("warns when no matching target exists outside the source printType call", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

printType({} as M<{a: 1}, {a: 2}>);
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    0,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);
  assertIncludes(
    res.stderr,
    "no matching `as` expression found outside source printType call",
  );

  const after = await Deno.readTextFile(file);
  assertEquals(after, before);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("deletes the source printType call when it is a middle comma operand", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (side(), printType({} as M<{a: 1}, {a: 2}>), use({} as M<{a: 1}, {a: 2}>));
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    19,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (side(), use({} as { a: 2; }));
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("deletes the source printType call when it is the first comma operand", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (printType({} as M<{a: 1}, {a: 2}>), use({} as M<{a: 1}, {a: 2}>));
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    11,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (use({} as { a: 2; }));
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("replaces a trailing comma source printType call with a void expression", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (side(), printType({} as M<{a: 1}, {a: 2}>));
const y = {} as M<{a: 1}, {a: 2}>;
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    19,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = (void (side()));
const y = {} as { a: 2; };
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("replaces the source printType call with void 0 in other expression positions", async () => {
  const tmp = await Deno.makeTempDir();
  const relFile = "test-d/sample.ts";
  const file = path.join(tmp, relFile);
  await Deno.mkdir(path.dirname(file), { recursive: true });

  const before = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = f(printType({} as M<{a: 1}, {a: 2}>));
const y = {} as M<{a: 1}, {a: 2}>;
`;
  await Deno.writeTextFile(file, before);

  const tsdOutput = makeTsdOutput(
    relFile,
    5,
    12,
    "{} as M<{a: 1}, {a: 2}>",
    "{ a: 2; }",
  );

  const res = await runCli([tmp], tsdOutput, tmp);
  assertEquals(res.code, 0);

  const after = await Deno.readTextFile(file);
  const expected = `import {printType} from 'tsd';

type M<A, B> = Omit<A, keyof B> & B;

const x = f(void 0);
const y = {} as { a: 2; };
`;
  assertEquals(after, expected);

  await Deno.remove(tmp, { recursive: true });
});
