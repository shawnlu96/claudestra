import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { receiptOf, appendReceipt } from "../src/lib/lend-receipts.js";
import { archiveSession } from "../src/lib/session-archive.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import { readWorkerArchiveBackup } from "../src/lib/lend-worker-registry-archive-files.js";
import { workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { archiveWorkerRegistry, previewWorkerRegistryArchive, rollbackWorkerRegistryArchive, type WorkerArchiveDeps } from "../src/manager/lend-worker-archive-cmds.js";
import type { AgentInfo, Registry } from "../src/manager/core.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function world() {
  const dir = mkdtempSync(join(root, "w-"));
  const journal = join(dir, "journal.sqlite");
  const db = openLendJournal(journal);
  recordAsked(db, { orderId: "order-1", peer: "A", fp: "fp", family: "claude", preview: {} });
  advance(db, "order-1", "asked", "claimed", { leaseGen: 1 });
  advance(db, "order-1", "claimed", "cloned", { agent: workerName("order-1"), dir: "/clone" });
  advance(db, "order-1", "cloned", "started", { sessionId: "session-1" });
  const row = advance(db, "order-1", "started", "cancelled", { settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(row)!;
  const registryPath = join(dir, "registry.json");
  const archiveRoot = join(dir, "archive");
  const receiptsPath = join(dir, "receipts.jsonl");
  const info: AgentInfo = { project: "/clone", purpose: "lend", created: "now", status: "stopped", channelId: "local:test",
    notes: "original", cwd: "/clone", kind: "worker", sessionId: id.sessionId };
  const registry: Registry = { socket: "/test.sock", agents: { [id.agent]: info, "agent-other": { ...info, status: "active" } } };
  writeJsonAtomicSync(registryPath, registry);
  appendReceipt(receiptOf(row, "未知"), receiptsPath);
  const src = join(dir, "session-1.jsonl");
  writeFileSync(src, '{"type":"user","message":{"content":"history retained"}}\n');
  mkdirSync(join(dir, "session-1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "session-1", "subagents", "sub.jsonl"), '{"child":true}\n');
  let calls = 0;
  const d: WorkerArchiveDeps = {
    db, registryPath, archiveRoot, receiptsPath, backupRoot: join(dir, "backups"), retired: async () => true, check: () => {},
    archive: async (name) => { calls++; return archiveSession(name, "/clone", id.sessionId, { srcPath: src, archiveRoot, kind: "worker" }); },
    save: async (reg, expected, check) => writeJsonAtomicSync(registryPath, reg, { commitIf: () => {
      check();
      return readFileSync(registryPath, "utf8") === expected;
    } }),
  };
  const read = () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const backup = () => {
    const key = readdirSync(d.backupRoot)[0];
    return join(d.backupRoot, key, readdirSync(join(d.backupRoot, key))[0]);
  };
  return { dir, journal, d, id, src, row, registry, read, backup, calls: () => calls };
}

test("dry-run is metadata only and creates no plans/backups", () => {
  const w = world();
  expect(previewWorkerRegistryArchive([w.id], w.d).entries[0].reason).toBeNull();
  expect(existsSync(w.d.backupRoot)).toBe(false);
  expect(w.d.db.query("SELECT * FROM lend_meta").all()).toHaveLength(0);
  w.d.db.close();
});

test("archive copies canonical history/subagents, removes exact record, and retry is idempotent across restart", async () => {
  const w = world();
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.read().agents[w.id.agent]).toBeUndefined();
  expect(w.read().agents["agent-other"]).toEqual(w.registry.agents["agent-other"]);
  expect(readFileSync(join(w.d.archiveRoot, w.id.agent, "session-1.jsonl"), "utf8")).toContain("history retained");
  expect(readFileSync(join(w.d.archiveRoot, w.id.agent, "session-1", "subagents", "sub.jsonl"), "utf8")).toContain("child");
  expect(readFileSync(w.src, "utf8")).toContain("history retained");
  expect(readFileSync(w.d.receiptsPath, "utf8")).toContain("order-1");
  expect(JSON.parse(readFileSync(join(w.backup(), "registry-before.json"), "utf8"))).toEqual(w.registry);
  expect(statSync(join(w.backup(), "registry-before.json")).mode & 0o777).toBe(0o600);
  w.d.db.close();
  w.d.db = openLendJournal(w.journal);
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(1);
  await rollbackWorkerRegistryArchive(w.backup(), w.d);
  expect(w.read()).toEqual(w.registry);
  await expect(rollbackWorkerRegistryArchive(w.backup(), w.d)).rejects.toThrow("已有记录");
  w.d.db.close();
});

test("existing archives are fully backed up before canonical copying", async () => {
  const w = world();
  const archive = join(w.d.archiveRoot, w.id.agent);
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "prior.jsonl"), "old history");
  await archiveWorkerRegistry(w.id, w.d);
  expect(readFileSync(join(w.backup(), "archive", "prior.jsonl"), "utf8")).toBe("old history");
  expect(readWorkerArchiveBackup(w.backup()).files.some((f) => f.path === "archive/prior.jsonl")).toBe(true);
  w.d.db.close();
});

test.each(["active", "unknown"])("%s liveness retains the exact registry", async () => {
  const w = world();
  w.d.retired = async () => false;
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("存活 / 未知");
  expect(w.read()).toEqual(w.registry);
  expect(w.calls()).toBe(0);
  w.d.db.close();
});

test("archive failure is recoverable using the persistent prepared plan", async () => {
  const w = world();
  const archive = w.d.archive;
  w.d.archive = async () => ({ ok: false, note: "disk full", archived: [] });
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("可恢复");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
  w.d.db = openLendJournal(w.journal);
  w.d.archive = archive;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  w.d.db.close();
});

test.each(["replacement", "concurrent", "late-result"])("rejects %s arriving during archive", async (change) => {
  const w = world();
  const archive = w.d.archive;
  w.d.archive = async (...args) => {
    const result = await archive(...args);
    if (change === "late-result") patchOrder(w.d.db, w.id.orderId, ["cancelled"], { payload: { late: true } });
    else {
      const current = w.read();
      if (change === "replacement") current.agents[w.id.agent].sessionId = "new-session";
      else current.agents["agent-new"] = { ...current.agents["agent-other"], notes: "concurrent" };
      writeJsonAtomicSync(w.d.registryPath, current);
    }
    return result;
  };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("已变");
  expect(w.read().agents[w.id.agent]).toBeDefined();
  if (change === "concurrent") expect(w.read().agents["agent-new"].notes).toBe("concurrent");
  if (change === "replacement") expect(w.read().agents[w.id.agent].sessionId).toBe("new-session");
  w.d.db.close();
});

test("bad/unreadable files retain registry; tampered backup refuses retry/rollback", async () => {
  const w = world();
  writeFileSync(w.d.receiptsPath, "broken json");
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
  expect(w.read()).toEqual(w.registry);
  rmSync(w.d.receiptsPath);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
  appendReceipt(receiptOf(w.row, "未知"), w.d.receiptsPath);
  await archiveWorkerRegistry(w.id, w.d);
  writeFileSync(join(w.backup(), "registry-before.json"), "{}");
  await expect(rollbackWorkerRegistryArchive(w.backup(), w.d)).rejects.toThrow("hash");
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("hash");
  w.d.db.close();
});

test("settled historical records require owner authorization", async () => {
  const w = world();
  patchOrder(w.d.db, w.id.orderId, ["cancelled"], { settle: null });
  expect((await archiveWorkerRegistry(w.id, w.d)).reason).toContain("B owner");
  expect(w.read()).toEqual(w.registry);
  expect(getOrder(w.d.db, w.id.orderId)?.settle).toBeNull();
  w.d.db.close();
});

test("finish history is reused after its source disappears, without a second archive", async () => {
  const w = world();
  await w.d.archive(w.id.agent, w.registry.agents[w.id.agent]);
  rmSync(w.src);
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(1);
  expect(readFileSync(join(w.backup(), "archive", "session-1.jsonl"), "utf8")).toContain("history retained");
  w.d.db.close();
});

test("a partial failed copy is retried, never mistaken for finish history", async () => {
  const w = world();
  const archive = w.d.archive;
  w.d.archive = async (...args) => { await archive(...args); return { ok: false, note: "subagent copy failed", archived: [] }; };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("未完成");
  expect(w.read()).toEqual(w.registry);
  w.d.archive = archive;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(2);
  w.d.db.close();
});

test("corrupt or wrong-session canonical history retains registry", async () => {
  const w = world();
  const dir = join(w.d.archiveRoot, w.id.agent);
  mkdirSync(dir, { recursive: true });
  for (const history of ["broken json", '{"sessionId":"replacement"}\n', ""]) {
    writeFileSync(join(dir, "session-1.jsonl"), history);
    await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
    expect(w.read()).toEqual(w.registry);
  }
  expect(w.calls()).toBe(0);
  w.d.db.close();
});

test("registry corruption and missing registry never become an empty registry write", async () => {
  const w = world();
  writeFileSync(w.d.registryPath, "{broken");
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
  expect(readFileSync(w.d.registryPath, "utf8")).toBe("{broken");
  rmSync(w.d.registryPath);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
  expect(existsSync(w.d.registryPath)).toBe(false);
  expect(w.calls()).toBe(0);
  w.d.db.close();
});

test("restart recovers a published registry removal whose journal commit was lost", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async (...args) => { await save(...args); throw new Error("crash after rename"); };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("crash");
  expect(w.read().agents[w.id.agent]).toBeUndefined();
  w.d.db.close();
  w.d.db = openLendJournal(w.journal);
  w.d.save = save;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(1);
  w.d.db.close();
});

test("late generation after preparation refuses retry and preserves replacement", async () => {
  const w = world();
  w.d.archive = async () => ({ ok: false, note: "disk full", archived: [] });
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("可恢复");
  patchOrder(w.d.db, w.id.orderId, ["cancelled"], { leaseGen: 2 });
  expect((await archiveWorkerRegistry(w.id, w.d)).reason).toContain("不匹配");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("rollback refuses a later claim generation even when the registry name is absent", async () => {
  const w = world();
  await archiveWorkerRegistry(w.id, w.d);
  patchOrder(w.d.db, w.id.orderId, ["cancelled"], { leaseGen: 2 });
  await expect(rollbackWorkerRegistryArchive(w.backup(), w.d)).rejects.toThrow("身份已变");
  expect(w.read().agents[w.id.agent]).toBeUndefined();
  w.d.db.close();
});

test("recovery after publication protects a late result observed during the retirement probe", async () => {
  const w = world();
  await archiveWorkerRegistry(w.id, w.d);
  w.d.retired = async () => { patchOrder(w.d.db, w.id.orderId, ["cancelled"], { payload: { late: true } }); return true; };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("身份已变");
  expect(getOrder(w.d.db, w.id.orderId)?.payload).toEqual({ late: true });
  w.d.db.close();
});

test("prepared backup refuses late artifacts on restart", async () => {
  const w = world();
  w.d.archive = async () => ({ ok: false, archived: [], note: "copy failed" });
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("未完成");
  patchOrder(w.d.db, w.id.orderId, ["cancelled"], { work: { head: "late", summary: "pending", selfCheck: "pending" } });
  w.d.db.close();
  w.d.db = openLendJournal(w.journal);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("产物已变");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});
