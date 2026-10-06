/** Isolated plans and preservation validation; no substitute registry removal or production retirement executor. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { receiptOf } from "../src/lib/lend-receipts.js";
import { readSessionHistory } from "../src/lib/session-history.js";
import { prepareWorkerArchiveBackup, readWorkerArchiveBackup } from "../src/lib/lend-worker-registry-archive-files.js";
import { workerArchiveIdentity, type WorkerArchiveFacts } from "../src/lib/lend-worker-registry-archive.js";
import { planWorkerRegistryArchive, previewWorkerRegistryArchive, verifyWorkerRegistryArchivePlan } from "../src/manager/lend-worker-archive-cmds.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function world() {
  const dir = mkdtempSync(join(root, "w-")), clone = join(dir, "clone");
  mkdirSync(clone);
  const init = Bun.spawnSync(["git", "init", "--quiet", clone], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode) throw new Error(init.stderr.toString());
  const artifact = join(clone, "result.txt");
  writeFileSync(artifact, "unreviewed original artifact\n", { mode: 0o640 });
  const journal = join(dir, "journal.sqlite"), writer = openLendJournal(journal);
  recordAsked(writer, { orderId: "order-1", peer: "A", fp: "fp", family: "claude", preview: {} });
  advance(writer, "order-1", "asked", "claimed", { leaseGen: 1 });
  advance(writer, "order-1", "claimed", "cloned", { agent: workerName("order-1"), dir: clone });
  advance(writer, "order-1", "cloned", "started", { sessionId: "session-1" });
  const row = advance(writer, "order-1", "started", "cancelled", { settle: { notify: null, removeDir: false } });
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.close();
  const db = new Database(journal, { readonly: true }), id = workerArchiveIdentity(row)!;
  const registryPath = join(dir, "registry.json"), archiveRoot = join(dir, "archive");
  const info = { sessionId: id.sessionId, cwd: clone, kind: "worker", status: "stopped" };
  writeFileSync(registryPath, JSON.stringify({ socket: "/test.sock", agents: { [id.agent]: info, other: { ...info, status: "active" } } }), { mode: 0o640 });
  const history = join(archiveRoot, id.agent, `${id.sessionId}.jsonl`);
  mkdirSync(join(archiveRoot, id.agent, id.sessionId, "subagents"), { recursive: true });
  writeFileSync(history, JSON.stringify({ type: "assistant", sessionId: id.sessionId,
    message: { content: [{ type: "text", text: "original readable history" }] } }) + "\n");
  const subagent = join(archiveRoot, id.agent, id.sessionId, "subagents", "child.jsonl");
  writeFileSync(subagent, '{"child":"retained"}\n');
  const receipts = JSON.stringify(receiptOf(row, "未知")) + "\n";
  const d = { db, registryPath, archiveRoot, backupRoot: join(dir, "backups") };
  const facts: WorkerArchiveFacts = { identity: id, journalAuthenticated: true, workerExited: true,
    preservationComplete: true, protected: false, pendingResult: false };
  const snapshot = () => [registryPath, journal, history, subagent, artifact].map((p) => ({ data: readFileSync(p).toString("base64"), mode: statSync(p).mode }));
  const bundle = () => prepareWorkerArchiveBackup(d.backupRoot, id, readFileSync(registryPath, "utf8"), join(archiveRoot, id.agent),
    { journal: JSON.stringify(row), receipts });
  return { dir, journal, d, id, row, facts, history, artifact, snapshot, bundle };
}

test("metadata plan creates no backup or journal entries and preserves a real temporary checkout", () => {
  const w = world(), before = w.snapshot();
  try {
    expect(previewWorkerRegistryArchive([w.id], w.d).entries[0].reason).toBeNull();
    expect(planWorkerRegistryArchive(w.id, w.d).identity).toEqual(w.id);
    expect(existsSync(w.d.backupRoot)).toBe(false);
    expect(w.d.db.query("SELECT * FROM lend_meta").all()).toHaveLength(0);
    expect(w.snapshot()).toEqual(before);
  } finally { w.d.db.close(); }
});

test("isolated verification survives restart, preserves readable history/subagents/receipts/permissions, and grants no execution", async () => {
  const w = world(), before = w.snapshot();
  try {
    const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle();
    expect(readWorkerArchiveBackup(backup).files.some((f) => f.path.endsWith("child.jsonl"))).toBe(true);
    expect(verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toEqual({ verified: true, capability: "blocked-capability" });
    w.d.db.close();
    w.d.db = new Database(w.journal, { readonly: true });
    expect(verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup).verified).toBe(true);
    expect(JSON.stringify(await readSessionHistory(w.history))).toContain("original readable history");
    expect(w.snapshot()).toEqual(before);
    expect(readFileSync(join(backup, "receipts.jsonl"), "utf8")).toContain("order-1");
  } finally { w.d.db.close(); }
});

test.each(["replacement", "concurrent", "late-result", "late-generation"])("read-only CAS validation refuses %s and preserves new data", (change) => {
  const w = world();
  try {
    const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle();
    if (change.startsWith("late-")) {
      const writer = openLendJournal(w.journal);
      patchOrder(writer, w.id.orderId, ["cancelled"], change === "late-result" ? { work: { head: "late", summary: "late", selfCheck: "late" } } : { leaseGen: 2 });
      writer.close();
    } else {
      const reg = JSON.parse(readFileSync(w.d.registryPath, "utf8"));
      if (change === "replacement") reg.agents[w.id.agent].sessionId = "new-session";
      else reg.agents.newAgent = { status: "active", notes: "concurrent" };
      writeFileSync(w.d.registryPath, JSON.stringify(reg));
    }
    const before = w.snapshot();
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow("已变");
    expect(w.snapshot()).toEqual(before);
    expect(getOrder(w.d.db, w.id.orderId)?.settle).not.toBeNull();
  } finally { w.d.db.close(); }
});

test.each(["journalAuthenticated", "workerExited", "preservationComplete", "protected", "pendingResult"] as const)
  ("unknown %s facts cannot authorize isolated verification", (key) => {
    const w = world(), before = w.snapshot();
    try {
      const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle();
      expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, { ...w.facts, [key]: null }, backup)).toThrow();
      expect(w.snapshot()).toEqual(before);
    } finally { w.d.db.close(); }
  });

test("corrupt, missing and symlinked files fail closed without overwriting originals", () => {
  const w = world();
  try {
    const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle();
    writeFileSync(w.history, "broken json");
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow();
    expect(readFileSync(w.history, "utf8")).toBe("broken json");
    rmSync(w.history);
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow();
    expect(existsSync(w.history)).toBe(false);
    symlinkSync(w.artifact, w.history);
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow("软链");
    expect(readFileSync(w.artifact, "utf8")).toContain("original artifact");
    writeFileSync(w.d.registryPath, "{broken");
    expect(() => planWorkerRegistryArchive(w.id, w.d)).toThrow();
    expect(readFileSync(w.d.registryPath, "utf8")).toBe("{broken");
  } finally { w.d.db.close(); }
});

test("unreadable preservation files retain their original permissions and registry", () => {
  const w = world();
  try {
    const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle();
    const saved = join(backup, "order.json"), registry = readFileSync(w.d.registryPath, "utf8");
    chmodSync(saved, 0);
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow();
    expect(statSync(saved).mode & 0o777).toBe(0);
    expect(readFileSync(w.d.registryPath, "utf8")).toBe(registry);
  } finally { w.d.db.close(); }
});

test("tampered backup refuses verification without a rollback/removal executor", () => {
  const w = world();
  try {
    const plan = planWorkerRegistryArchive(w.id, w.d), backup = w.bundle(), before = w.snapshot();
    writeFileSync(join(backup, "registry-before.json"), "{}");
    expect(() => verifyWorkerRegistryArchivePlan(plan, w.d, w.facts, backup)).toThrow("hash");
    expect(w.snapshot()).toEqual(before);
  } finally { w.d.db.close(); }
});
