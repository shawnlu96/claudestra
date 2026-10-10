import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { receiptOf, appendReceipt } from "../src/lib/lend-receipts.js";
import { archiveSession } from "../src/lib/session-archive.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import { readWorkerArchiveBackup } from "../src/lib/lend-worker-registry-archive-files.js";
import { workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { archiveOnlyOps, archiveWorkerRegistry, previewWorkerRegistryArchive, rollbackWorkerRegistryArchive, type WorkerArchiveDeps } from "../src/manager/lend-worker-archive-cmds.js";
import type { AgentInfo, Registry } from "../src/manager/core.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function world(family = "codex") {
  const dir = mkdtempSync(join(root, "w-"));
  const journal = join(dir, "journal.sqlite");
  const db = openLendJournal(journal);
  recordAsked(db, { orderId: "order-1", peer: "A", fp: "fp", family, preview: {} });
  advance(db, "order-1", "asked", "claimed", { leaseGen: 1 });
  advance(db, "order-1", "claimed", "cloned", { agent: workerName("order-1"), dir: "/clone" });
  advance(db, "order-1", "cloned", "started", { sessionId: "session-1", startedAt: 1_000 });
  const row = advance(db, "order-1", "started", "cancelled", { settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(row)!;
  const registryPath = join(dir, "registry.json");
  const archiveRoot = join(dir, "archive");
  const receiptsPath = join(dir, "receipts.jsonl");
  const info: AgentInfo = { project: "/clone", purpose: "lend", created: "now", status: "stopped", channelId: "local:test",
    notes: "original", cwd: "/clone", kind: "worker", sessionId: id.sessionId, ...(family === "codex" ? { runtime: "codex" } : {}) };
  const registry: Registry = { socket: "/test.sock", agents: { [id.agent]: info, "agent-other": { ...info, status: "active" } } };
  writeJsonAtomicSync(registryPath, registry);
  appendReceipt(receiptOf(row, "未知"), receiptsPath);
  const src = join(dir, "session-1.jsonl");
  writeFileSync(src, '{"type":"user","message":{"content":"history retained"}}\n');
  mkdirSync(join(dir, "session-1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "session-1", "subagents", "sub.jsonl"), '{"child":true}\n');
  let calls = 0;
  const d: WorkerArchiveDeps = {
    db, registryPath, archiveRoot, receiptsPath, backupRoot: join(dir, "backups"), check: () => {},
    window: async () => "no_window", listWindows: async () => [], card: () => undefined, probe: () => "esrch",
    hostStart: (_name, a) => ({ pid: a.hostPid, startedAt: row.createdAt + 1 }), source: async () => src,
    activity: (name) => ({ v: 1, agent: name, sessionId: id.sessionId, hostPid: 4242, busy: false, turnAt: 2_000, updateAt: 2_000, writtenAt: row.createdAt + 2_000 }),
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

test.each(["running", "unknown", "no_host"] as const)("%s liveness retains the exact registry", async (live) => {
  const w = world();
  w.d.window = async () => live;
  expect((await archiveWorkerRegistry(w.id, w.d)).reason).toContain("不当已退出");
  expect(w.read()).toEqual(w.registry);
  expect(w.calls()).toBe(0);
  expect(existsSync(w.d.backupRoot)).toBe(false);
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

test("an early snapshot is never taken as the terminal archive: the canonical archive copies final history and subagents", async () => {
  const w = world();
  const dir = join(w.d.archiveRoot, w.id.agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-1.jsonl"), '{"type":"user"}\n'); // archive-sweeper style early copy, no final message / subagents
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(1);
  expect(readFileSync(join(dir, "session-1.jsonl"), "utf8")).toContain("history retained");
  expect(readFileSync(join(dir, "session-1", "subagents", "sub.jsonl"), "utf8")).toContain("child");
  expect(readFileSync(join(w.backup(), "archive", "session-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  w.d.db.close();
});

test("an early snapshot whose source is gone keeps the registry (no receipt, canonical archive refuses)", async () => {
  const w = world();
  await w.d.archive(w.id.agent, w.registry.agents[w.id.agent]);
  rmSync(w.src);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("归档没成");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("a receipted archive is not repeated on retry; a receipted file changed afterwards is archived again", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async () => { throw new Error("publish failed"); };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("publish failed");
  expect(existsSync(join(w.backup(), "archive-receipt.json"))).toBe(true);
  expect(statSync(join(w.backup(), "archive-receipt.json")).mode & 0o777).toBe(0o600);
  w.d.save = async () => { throw new Error("publish failed again"); };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("again");
  expect(w.calls()).toBe(1);
  writeFileSync(join(w.d.archiveRoot, w.id.agent, "session-1", "subagents", "sub.jsonl"), "{}\n");
  w.d.save = save;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(2);
  w.d.db.close();
});

test("a partial failed copy is retried, never mistaken for finish history", async () => {
  const w = world();
  const archive = w.d.archive;
  w.d.archive = async (...args) => { await archive(...args); return { ok: false, note: "subagent copy failed", archived: [] }; };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("归档没成");
  expect(w.read()).toEqual(w.registry);
  w.d.archive = archive;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(2);
  w.d.db.close();
});

test("corrupt or wrong-session canonical history the archive cannot replace retains registry", async () => {
  const w = world();
  const dir = join(w.d.archiveRoot, w.id.agent);
  mkdirSync(dir, { recursive: true });
  const pad = "x".repeat(200); // larger than the source: copyIfLarger keeps it, so the check after the archive must refuse
  for (const history of [`broken json ${pad}`, `{"sessionId":"replacement","pad":"${pad}"}\n`]) {
    writeFileSync(join(dir, "session-1.jsonl"), history);
    await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow();
    expect(w.read()).toEqual(w.registry);
  }
  w.d.db.close();
});

test("a card link that appears right before the registry rename keeps the record", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async (reg, expected, check) => {
    w.d.card = () => ({ taskId: "T9", role: "author", source: "worker_agents", links: [] });
    return save(reg, expected, check);
  };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("本机卡");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("an unreadable card ledger at the publish check keeps the record", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async (reg, expected, check) => {
    w.d.card = () => { throw new Error("台账读不到（EACCES）"); };
    return save(reg, expected, check);
  };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("台账读不到");
  expect(w.read()).toEqual(w.registry);
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
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  w.d.window = async () => { patchOrder(w.d.db, w.id.orderId, ["cancelled"], { payload: { late: true } }); return "no_window"; };
  // the facts are now read after the window probe, so the late result is seen as a refusal (no success either way)
  expect(await archiveWorkerRegistry(w.id, w.d)).toMatchObject({ archived: false, reason: expect.stringContaining("未确认结果") });
  expect(getOrder(w.d.db, w.id.orderId)?.payload).toEqual({ late: true });
  w.d.db.close();
});

test("recovery after publication re-checks the journal after the last fact read", async () => {
  const w = world();
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  w.d.probe = () => { patchOrder(w.d.db, w.id.orderId, ["cancelled"], { payload: { late: true } }); return "esrch"; };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("身份已变");
  w.d.db.close();
});

test("prepared backup refuses late artifacts on restart", async () => {
  const w = world();
  w.d.archive = async () => ({ ok: false, archived: [], note: "copy failed" });
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("归档没成");
  patchOrder(w.d.db, w.id.orderId, ["cancelled"], { work: { head: "late", summary: "pending", selfCheck: "pending" } });
  w.d.db.close();
  w.d.db = openLendJournal(w.journal);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("产物已变");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("immutable family set at create: a Claude order is blocked-capability, never archived", async () => {
  const w = world("claude");
  expect(await archiveWorkerRegistry(w.id, w.d)).toMatchObject({ archived: false, blocked: true });
  expect(w.read()).toEqual(w.registry);
  expect(w.calls()).toBe(0);
  expect(existsSync(w.d.backupRoot)).toBe(false);
  w.d.db.close();
});

test.each([
  ["no activity record", (w: ReturnType<typeof world>) => { w.d.activity = () => null; }, "没有 ACP 活动记录"],
  ["another session", (w: ReturnType<typeof world>) => { const a = w.d.activity; w.d.activity = (n) => ({ ...a(n)!, sessionId: "other" }); }, "不是本单"],
  ["written before the order started", (w: ReturnType<typeof world>) => { const a = w.d.activity; w.d.activity = (n) => ({ ...a(n)!, writtenAt: 10 }); }, "早于本单开跑"],
  ["host pid alive", (w: ReturnType<typeof world>) => { w.d.probe = () => "alive"; }, "严格 ESRCH"],
  ["host pid EPERM", (w: ReturnType<typeof world>) => { w.d.probe = () => "eperm"; }, "严格 ESRCH"],
  ["same-name local card worker", (w: ReturnType<typeof world>) => {
    w.d.card = () => ({ taskId: "T1", role: "author", source: "worker_agents", links: [] });
  }, "本机卡"],
] as const)("exit / ownership proof missing (%s) retains everything", async (_name, mutate, reason) => {
  const w = world();
  mutate(w);
  expect((await archiveWorkerRegistry(w.id, w.d)).reason).toContain(reason);
  expect(w.read()).toEqual(w.registry);
  expect(w.calls()).toBe(0);
  w.d.db.close();
});

test("archive-only remover refuses a window or a case-variant entry; no kill or other effect is ever reachable", async () => {
  const w = world();
  w.d.listWindows = async () => [w.id.agent];
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("窗口还在");
  expect(w.read()).toEqual(w.registry);
  w.d.listWindows = async () => [];
  const variant = { ...w.registry, agents: { ...w.registry.agents, [w.id.agent.toUpperCase()]: w.registry.agents["agent-other"] } };
  writeJsonAtomicSync(w.d.registryPath, variant);
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("大小写变体");
  expect(w.read()).toEqual(variant);
  const ops = archiveOnlyOps(w.d.registryPath, async () => []);
  for (const effect of [() => ops.killWindow("x"), () => ops.deleteChannel("c"), () => ops.agentCleanup("c", "x"), () => ops.archive("x", {}),
    () => ops.saveRegistry(variant), () => ops.rescan("remove", "x")]) await expect(effect()).rejects.toThrow("archive-only");
  w.d.db.close();
});

test("archive succeeded but remove failed: plan kept, retry finishes; originals, clone and permissions untouched", async () => {
  const w = world();
  const clone = join(w.dir, "clone-marker");
  writeFileSync(clone, "clone");
  chmodSync(w.src, 0o640);
  let fail = true;
  w.d.listWindows = async () => { if (fail) { fail = false; throw new Error("tmux 读不到"); } return []; };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("tmux 读不到");
  expect(w.read()).toEqual(w.registry);
  expect(w.calls()).toBe(1);
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.read().agents[w.id.agent]).toBeUndefined();
  expect(readFileSync(w.src, "utf8")).toContain("history retained");
  expect(statSync(w.src).mode & 0o777).toBe(0o640);
  expect(readFileSync(clone, "utf8")).toBe("clone");
  expect(readFileSync(join(w.d.archiveRoot, w.id.agent, "session-1.jsonl"), "utf8")).toContain("history retained");
  w.d.db.close();
});

test("lease / lock lost at the publish point leaves the registry and the plan un-done", async () => {
  const w = world();
  let armed = false;
  const save = w.d.save;
  w.d.save = async (reg, expected, check) => { armed = true; return save(reg, expected, check); };
  w.d.check = () => { if (armed) throw new Error("租约已失"); };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("租约已失");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("stale-history: a larger pre-existing same-session snapshot without the final source keeps registry and settle", async () => {
  const w = world();
  const archive = join(w.d.archiveRoot, w.id.agent);
  mkdirSync(archive, { recursive: true });
  const stale = `${JSON.stringify({ type: "user", sessionId: w.id.sessionId, message: { content: "early snapshot ".repeat(20) } })}\n`;
  writeFileSync(join(archive, "session-1.jsonl"), stale);
  writeFileSync(w.src, '{"type":"user","message":{"content":"final message"}}\n');
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("不含源的最终内容");
  expect(w.calls()).toBe(1);
  expect(w.read()).toEqual(w.registry);
  expect(getOrder(w.d.db, w.id.orderId)!.settle).not.toBeNull();
  expect(existsSync(join(w.backup(), "archive-receipt.json"))).toBe(false);
  expect(readFileSync(join(archive, "session-1.jsonl"), "utf8")).toBe(stale);
  w.d.db.close();
});

test("stale-history: a subagent archive copy missing the final source subagent keeps the record", async () => {
  const w = world();
  const sub = join(w.d.archiveRoot, w.id.agent, "session-1", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "sub.jsonl"), '{"child":"older but larger snapshot"}\n');
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("不含源的最终内容");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("receipt-publish: the archived history removed at the publish point keeps registry and settle", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async (reg, expected, check) => {
    rmSync(join(w.d.archiveRoot, w.id.agent, "session-1.jsonl"));
    return save(reg, expected, check);
  };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("可恢复");
  expect(w.read()).toEqual(w.registry);
  expect(getOrder(w.d.db, w.id.orderId)!.settle).not.toBeNull();
  w.d.save = save;
  expect(await archiveWorkerRegistry(w.id, w.d)).toEqual({ archived: true });
  expect(w.calls()).toBe(2);
  expect(readFileSync(join(w.d.archiveRoot, w.id.agent, "session-1.jsonl"), "utf8")).toContain("history retained");
  w.d.db.close();
});

test("receipt-publish: an archived history changed at the publish point keeps the record", async () => {
  const w = world();
  const save = w.d.save;
  w.d.save = async (reg, expected, check) => {
    writeFileSync(join(w.d.archiveRoot, w.id.agent, "session-1.jsonl"), '{"type":"user","message":{"content":"tampered"}}\n');
    return save(reg, expected, check);
  };
  await expect(archiveWorkerRegistry(w.id, w.d)).rejects.toThrow("可恢复");
  expect(w.read()).toEqual(w.registry);
  w.d.db.close();
});

test("exit-origin: no trusted host start identity is blocked-capability before any backup / archive", async () => {
  const w = world();
  w.d.hostStart = () => null;
  expect(await archiveWorkerRegistry(w.id, w.d)).toMatchObject({ archived: false, blocked: true });
  expect(w.calls()).toBe(0);
  expect(w.read()).toEqual(w.registry);
  expect(existsSync(w.d.backupRoot)).toBe(false);
  w.d.db.close();
});
