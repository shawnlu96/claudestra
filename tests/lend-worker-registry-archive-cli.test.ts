/** Exercises the actual leaf in a temporary state tree; capability refusals must not write even with an owner answer. */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { isWriteInvocation, needsWriteLock } from "../src/manager/write-commands.js";
import { testChildEnv } from "./test-env.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  const state = join(dir, "state");
  mkdirSync(state);
  const journalPath = join(state, "lend", "journal.sqlite");
  const journal = openLendJournal(journalPath);
  recordAsked(journal, { orderId: "cli-order", peer: "A", fp: "fp", family: "claude", preview: {} });
  advance(journal, "cli-order", "asked", "claimed", { leaseGen: 2, agent: workerName("cli-order"), dir: "/synthetic-clone" });
  advance(journal, "cli-order", "claimed", "cloned");
  advance(journal, "cli-order", "cloned", "started", { sessionId: "session-cli" });
  const row = advance(journal, "cli-order", "started", "cancelled", { settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(row)!;
  journal.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // Settle fixture WAL before comparing physical bytes across child exits.
  journal.close();
  const info = { project: "lend", purpose: "test", created: "now", channelId: "local:test", notes: "", cwd: row.dir,
    sessionId: row.sessionId, status: "stopped", kind: "worker" };
  const registryPath = join(state, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "fixture", agents: { [id.agent]: info, ordinary: { ...info, kind: "main" } } }), { mode: 0o640 });
  const history = join(state, "archive", id.agent, `${id.sessionId}.jsonl`);
  mkdirSync(join(state, "archive", id.agent), { recursive: true });
  writeFileSync(history, '{"message":"retained history"}\n');
  const env = testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime") });
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/manager.ts", "archive-workflows", "--lend-worker", ...args],
      { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code || !out.trim()) throw new Error(`manager failed: ${code} ${err}`);
    return JSON.parse(out);
  };
  const snapshot = () => [registryPath, journalPath, history].map((p) => ({ data: readFileSync(p).toString("base64"), mode: statSync(p).mode }));
  return { id, invoke, state, snapshot };
}

test("default dry-run reports metadata and the missing LIFE1 capability without mutation", async () => {
  const f = fixture(), before = f.snapshot();
  const result = await f.invoke([JSON.stringify(f.id)]);
  expect(result).toMatchObject({ ok: true, dryRun: true, capability: "blocked-capability" });
  expect(result.entries[0].reason).toBeNull();
  expect(result.bind.params.registryHash).toBe(result.registryHash);
  expect(f.snapshot()).toEqual(before);
  expect(existsSync(join(f.state, "backups"))).toBe(false);
});

test.each(["settle", "apply"])("%s fails with blocked-capability before any mutation", async (op) => {
  const f = fixture(), before = f.snapshot();
  const result = await f.invoke([op, JSON.stringify(f.id), ...(op === "apply" ? ["--ask", "owner-approved"] : [])]);
  expect(result).toMatchObject({ ok: false, recoverable: true, code: "blocked-capability" });
  expect(result.archived).not.toBe(true);
  expect(f.snapshot()).toEqual(before);
  expect(existsSync(join(f.state, "backups"))).toBe(false);
});

test("leaf classification preserves RLOCK defaults and uses no writer while capability is missing", () => {
  expect(isWriteInvocation("archive-workflows", [])).toBe(false);
  expect(needsWriteLock("archive-workflows", [])).toBe(false);
  for (const op of ["settle", "apply", "dry-run"]) {
    expect(isWriteInvocation("archive-workflows", ["--lend-worker", op])).toBe(false);
    expect(needsWriteLock("archive-workflows", ["--lend-worker", op])).toBe(false);
  }
  expect(needsWriteLock("create", [])).toBe(true);
});
