import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendCheckPermit, type LendCheckConfig, type LendCheckResult } from "../src/lib/lend-check-permit.ts";
import { testChildEnv } from "./test-env.ts";

// FLK3: a concurrent COMMIT unlinks the rollback journal; lstat in that window sees a regular file with nlink=0.
// That is SQLite contention (retryable busy), not an aliased store. Real aliasing must still fail closed.
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(); await child.exited; }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root() { const dir = mkdtempSync(join(tmpdir(), "check-permit-race-")); roots.push(dir); return dir; }
const config: LendCheckConfig = { mode: "on", ownerApproval: { maxConcurrentFullChecks: 2, approvedBy: "fixture-owner", reference: "test-only" } };
const deps = { verifyOwnerApproval: () => true, observeCheckTree: () => "absent" as const };
const acquire = (directory: string, id: string) =>
  lendCheckPermit({ directory, request: { id, orderId: "o", workerId: "w", cost: "full" }, action: "acquire", config }, undefined, deps);

test("journal unlinked by a concurrent commit is retryable busy, never a non-retryable block or grant", async () => {
  const dir = root(), path = join(dir, "lend-check-permit.sqlite");
  expect(acquire(dir, "seed").status).toBe("granted");
  // A real separate process commits in a loop on an unrelated table of the same file, so its journal is created/unlinked.
  const home = join(dir, "writer"); for (const sub of ["home", "tmp"]) mkdirSync(join(home, sub), { recursive: true });
  const writer = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(path)}); db.exec("PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS churn (x)");
console.log("ready");
for (;;) {
  try { db.exec("BEGIN IMMEDIATE"); db.query("INSERT INTO churn VALUES (?)").run(Math.random()); db.exec("COMMIT"); }
  catch { try { db.exec("ROLLBACK"); } catch {} }
}`],
  { cwd: home, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    env: testChildEnv({ HOME: join(home, "home"), TMPDIR: join(home, "tmp") }) });
  children.push(writer);
  await writer.stdout.getReader().read();
  const seen: Record<string, number> = {};
  const unexpected: LendCheckResult[] = [];
  const end = Date.now() + 3000;
  for (let i = 0; Date.now() < end; i++) {
    const result = acquire(dir, `poll-${i % 4}`);
    const key = `${result.status}:${result.reasonCode ?? "-"}`; seen[key] = (seen[key] ?? 0) + 1;
    if (result.status !== "busy" && result.status !== "queued" && result.status !== "granted") unexpected.push(result);
    if (result.status === "busy") expect(result).toMatchObject({ retryable: true, allowed: false, reasonCode: "store_busy" });
  }
  writer.kill(); await writer.exited;
  expect(unexpected.map((result) => `${result.status} ${result.reasonCode} ${result.reason}`)).toEqual([]);
  expect(seen["busy:store_busy"] ?? 0).toBeGreaterThan(0);
  // Quiescent again: the seed plus exactly one FIFO poller hold the two slots; contended polls never over-granted.
  const settled = [0, 1, 2, 3].map((i) => acquire(dir, `poll-${i}`).status);
  expect(settled.filter((status) => status === "granted")).toHaveLength(1);
  expect(settled.filter((status) => status === "queued")).toHaveLength(3);
  const db = new Database(path);
  try {
    const body = JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body);
    expect(body.entries.filter((entry: { status: string }) => entry.status === "active")).toHaveLength(2);
  } finally { db.close(); }
}, 15000);

test("only an unlinked -journal is contention; aliased or non-regular sidecars and main store stay blocked with zero writes", () => {
  const cases: Array<[string, (path: string, dir: string) => void]> = [
    ["-journal hardlink", (path, dir) => { writeFileSync(join(dir, "j"), ""); linkSync(join(dir, "j"), path + "-journal"); }],
    ["-journal symlink", (path, dir) => { writeFileSync(join(dir, "j"), ""); symlinkSync(join(dir, "j"), path + "-journal"); }],
    ["-wal hardlink", (path, dir) => { writeFileSync(join(dir, "w"), ""); linkSync(join(dir, "w"), path + "-wal"); }],
    ["-shm symlink", (path, dir) => { writeFileSync(join(dir, "s"), ""); symlinkSync(join(dir, "s"), path + "-shm"); }],
    ["main hardlink", (path, dir) => linkSync(path, join(dir, "copy.sqlite"))],
  ];
  for (const [name, obstruct] of cases) {
    const dir = root(), path = join(dir, "lend-check-permit.sqlite");
    expect(acquire(dir, "seed").status).toBe("granted");
    obstruct(path, dir);
    const before = readFileSync(path);
    const result = acquire(dir, "next");
    expect({ name, result }).toMatchObject({ name, result: { status: "blocked", allowed: false, retryable: false, reasonCode: "store_or_identity" } });
    expect(readFileSync(path)).toEqual(before);
  }
});
