import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { testChildEnv } from "./test-env.ts";
import { createTestTmpRoot } from "./test-tmp-root.ts";

const preload = join(import.meta.dir, "preload.ts");
// Every case spawns nested bun processes; a loaded machine easily exceeds the default 5 s.
const SPAWN_TIMEOUT = 60_000;
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tmp-root-probe-"));
  fixtures.push(dir);
  const parent = join(dir, "original-tmp");
  mkdirSync(parent);
  writeFileSync(join(dir, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  return { dir, parent, env: testChildEnv({ TMPDIR: parent, TMP: parent, TEMP: parent }) };
}

function testFile(dir: string, body: string): string {
  const file = join(dir, "probe.test.ts");
  writeFileSync(file, `import { test } from "bun:test"; ${probeImports}\ntest("probe", async () => { ${body} });`);
  return file;
}

const probeImports = `
  import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join, dirname } from "node:path";
`;

for (const failing of [false, true]) {
  test(`bun test ${failing ? "failure" : "success"} leaves its original tmpdir empty, including child scratch/state`, () => {
    const f = fixture();
    writeFileSync(join(f.dir, "probe.test.ts"), `
      import { afterAll, expect, test } from "bun:test";
      ${probeImports}
      afterAll(() => mkdtempSync(join(tmpdir(), "late-hook-")));
      test("allocate", async () => {
        const root = tmpdir();
        expect(dirname(root)).toBe(${JSON.stringify(realpathSync(f.parent))});
        expect(root.split("/").pop().startsWith("cstra-test-run-" + process.pid + "-")).toBe(true);
        expect([process.env.TMP, process.env.TEMP]).toEqual([root, root]);
        expect(dirname(process.env.CLAUDESTRA_STATE_DIR)).toBe(root);
        mkdtempSync(join(root, "unremoved-"));
        const script = ${JSON.stringify(`${probeImports} console.log(mkdtempSync(join(tmpdir(), "child-")));`)};
        const inherited = Bun.spawnSync([process.execPath, "-e", script]);
        expect(inherited.exitCode).toBe(0);
        expect(dirname(inherited.stdout.toString().trim())).toBe(root);
        const objectForm = Bun.spawnSync({ cmd: [process.execPath, "-e", script] });
        expect(objectForm.exitCode).toBe(0);
        expect(dirname(objectForm.stdout.toString().trim())).toBe(root);
        const asyncChild = Bun.spawn([process.execPath, "-e", script]);
        expect(await asyncChild.exited).toBe(0);
        expect(dirname((await new Response(asyncChild.stdout).text()).trim())).toBe(root);
        const viaNode = require("node:child_process").execFileSync(process.execPath, ["-e", script]).toString().trim();
        expect(dirname(viaNode)).toBe(root);
        const explicit = join(root, "explicit");
        mkdirSync(explicit);
        const overridden = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, TMPDIR: explicit } });
        expect(overridden.exitCode).toBe(0);
        expect(dirname(overridden.stdout.toString().trim())).toBe(explicit);
        expect(${failing}).toBe(false);
      });
    `);
    writeFileSync(join(f.dir, "later.test.ts"), `import { test } from "bun:test"; ${probeImports}
      test("later file still has a usable root", () => { mkdtempSync(join(tmpdir(), "later-")); });`);
    const result = Bun.spawnSync([process.execPath, "test", "./probe.test.ts", "./later.test.ts"], { cwd: f.dir, env: f.env });
    expect(result.exitCode, result.stderr.toString()).toBe(failing ? 1 : 0);
    expect(result.stderr.toString()).toContain(failing ? "1 fail" : "2 pass");
    expect(readdirSync(f.parent)).toEqual([]);
  }, SPAWN_TIMEOUT);
}

test("uncaught exceptions keep the failure exit status and remove the root", () => {
  const f = fixture();
  const script = `${probeImports} mkdtempSync(join(tmpdir(), "uncaught-")); throw new Error("tmp-root-uncaught");`;
  const result = Bun.spawnSync([process.execPath, "--preload", preload, "-e", script], { cwd: f.dir, env: f.env });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("tmp-root-uncaught");
  expect(readdirSync(f.parent)).toEqual([]);
}, SPAWN_TIMEOUT);

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`${signal} exits with ${code} and removes the root`, async () => {
    const f = fixture();
    const file = testFile(f.dir, `mkdtempSync(join(tmpdir(), "signal-")); console.log("ready"); await new Promise(() => {});`);
    const child = Bun.spawn([process.execPath, "test", file], { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT / 2);
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("ready")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain("ready");
      child.kill(signal);
      expect(await child.exited).toBe(code);
      expect(readdirSync(f.parent)).toEqual([]);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, SPAWN_TIMEOUT);
}

test("startup reaps only old prefixed directories of dead owners, never symlinks, recent roots or other prefixes", async () => {
  const f = fixture();
  const old = join(f.parent, "cstra-test-run-old");
  const dead = Bun.spawnSync(["true"]).pid;
  const deadOwner = join(f.parent, `cstra-test-run-${dead}-gone`);
  // This runner is alive; its root must survive however old its mtime looks (e.g. a quiet `bun test --watch`).
  const liveOwner = join(f.parent, `cstra-test-run-${process.pid}-quiet`);
  const recent = join(f.parent, "cstra-test-run-recent");
  const unrelated = join(f.parent, "ledger-read-old");
  const outside = join(f.dir, "outside");
  for (const dir of [old, deadOwner, liveOwner, recent, unrelated, outside]) mkdirSync(dir);
  writeFileSync(join(outside, "keep"), "untouched");
  // A link inside an otherwise removable root must not cause its target to be traversed.
  symlinkSync(outside, join(old, "inner-link"));
  symlinkSync(outside, join(f.parent, "cstra-test-run-link"));
  symlinkSync(unrelated, join(f.parent, "cstra-test-run-local-link"));
  symlinkSync(join(outside, "missing"), join(f.parent, "cstra-test-run-dangling"));
  writeFileSync(join(f.parent, "cstra-test-run-file"), "keep");
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1_000);
  for (const dir of [old, deadOwner, liveOwner, unrelated, outside]) utimesSync(dir, stale, stale);
  // The sweep runs in the background; awaiting it makes the assertion below deterministic.
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const root = createTestTmpRoot(f.parent);
  let warnings: string;
  try {
    await root.swept;
  } finally {
    warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
  }
  root.cleanup();
  expect(readdirSync(f.parent).sort()).toEqual([
    "cstra-test-run-dangling", "cstra-test-run-file", "cstra-test-run-link", "cstra-test-run-local-link", "cstra-test-run-recent",
    basename(liveOwner), "ledger-read-old",
  ].sort());
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
  expect(warnings).toContain("not a real directory");
});

test("a short bun test run finishes the background stale sweep before it exits", () => {
  const f = fixture();
  // Enough unrelated entries that listing them outlasts an empty test file (the review probe used 40k).
  for (let i = 0; i < 40_000; i++) writeFileSync(join(f.parent, `unrelated-${i}`), "");
  const stale = join(f.parent, `cstra-test-run-${Bun.spawnSync(["true"]).pid}-left`);
  mkdirSync(stale);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
  utimesSync(stale, old, old);
  const result = Bun.spawnSync([process.execPath, "test", testFile(f.dir, "void 0")], { cwd: f.dir, env: f.env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(existsSync(stale)).toBe(false);
  expect(readdirSync(f.parent)).toHaveLength(40_000);
}, SPAWN_TIMEOUT);

test("the stale sweep does not block root creation", async () => {
  const f = fixture();
  const root = createTestTmpRoot(f.parent);
  expect(existsSync(root.path)).toBe(true);
  await root.swept;
  root.cleanup();
  expect(readdirSync(f.parent)).toEqual([]);
});

test("cleanup checks the captured root identity, refuses replacement directories and symlinks", () => {
  const f = fixture();
  for (const replacement of ["directory", "symlink"] as const) {
    const root = createTestTmpRoot(f.parent);
    const original = join(f.dir, `${replacement}-original`);
    renameSync(root.path, original);
    if (replacement === "directory") mkdirSync(root.path);
    else symlinkSync(original, root.path);
    writeFileSync(join(root.path, "keep"), replacement);
    root.cleanup();
    expect(lstatSync(root.path).isSymbolicLink()).toBe(replacement === "symlink");
    expect(readFileSync(join(root.path, "keep"), "utf8")).toBe(replacement);
  }
});

test("canonical parent aliases work and cleanup is idempotent", () => {
  const f = fixture();
  const alias = join(f.dir, "parent-alias");
  symlinkSync(f.parent, alias);
  const root = createTestTmpRoot(alias);
  expect(basename(root.path)).toStartWith(`cstra-test-run-${process.pid}-`);
  expect(root.path).toStartWith(realpathSync(f.parent) + "/");
  root.cleanup();
  root.cleanup();
  expect(existsSync(root.path)).toBe(false);
  expect(existsSync(alias)).toBe(true);
});

test("cleanup refuses a parent replaced with a symlink", () => {
  const f = fixture();
  const root = createTestTmpRoot(f.parent);
  const moved = join(f.dir, "moved-parent");
  renameSync(f.parent, moved);
  symlinkSync(moved, f.parent);
  root.cleanup();
  expect(existsSync(root.path)).toBe(true);
  expect(lstatSync(f.parent).isSymbolicLink()).toBe(true);
});

test("nested bun test inherits the parent root and only removes its own subtree", () => {
  const f = fixture();
  const nested = join(f.dir, "nested.test.ts");
  writeFileSync(nested, `import { expect, test } from "bun:test"; ${probeImports}
    test("nested", () => {
      expect(dirname(tmpdir())).toBe(process.env.PARENT_TEST_TMP);
      mkdtempSync(join(tmpdir(), "nested-scratch-"));
    });`);
  const body = `
    process.env.PARENT_TEST_TMP = tmpdir();
    const result = Bun.spawnSync({ cmd: [process.execPath, "test", ${JSON.stringify(nested)}] });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    mkdtempSync(join(tmpdir(), "parent-still-present-"));
  `;
  const result = Bun.spawnSync([process.execPath, "test", testFile(f.dir, body)], { cwd: f.dir, env: f.env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readdirSync(f.parent)).toEqual([]);
}, SPAWN_TIMEOUT);

test("exit cleanup uses its captured root even if a test changes TMPDIR, and preserves explicit state", () => {
  const f = fixture();
  const explicit = join(f.dir, "explicit-state");
  mkdirSync(explicit);
  const script = `${probeImports}
    if (process.env.CLAUDESTRA_STATE_DIR !== ${JSON.stringify(explicit)}) throw new Error("state override lost");
    mkdtempSync(join(tmpdir(), "scratch-"));
    process.env.TMPDIR = ${JSON.stringify(explicit)};
    writeFileSync(join(tmpdir(), "keep"), "untouched");
  `;
  const result = Bun.spawnSync([process.execPath, "--preload", preload, "-e", script], {
    cwd: f.dir, env: testChildEnv({ ...f.env, CLAUDESTRA_STATE_DIR: explicit }),
  });
  expect(result.exitCode).toBe(0);
  expect(readdirSync(f.parent)).toEqual([]);
  expect(readFileSync(join(explicit, "keep"), "utf8")).toBe("untouched");
}, SPAWN_TIMEOUT);
