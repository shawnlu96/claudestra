/**
 * team-project-PMWAKE 验收线 8：feature PM 收得到。当班 PM=P、feature A 的 pm=X（在名单、≠P）→ pmRedirect(project, X) 为 null（照点名投递）；
 * 清掉 A 的 pm 后回到 main 的行为（转给 P）。缺规格提醒端到端：假 bridge 收到的目标是 X，不是 P。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bridged: { targetName: string; text: string }[] = [];
let faking = false;
// mock.module is process-wide under bun's single-process runner: outside this file's tests it delegates to the real bridgeSend.
const real = await import("../src/lib/bridge-client.js");
const realSend = real.bridgeSend;
mock.module("../src/lib/bridge-client.js", () => ({
  ...real,
  bridgeSend: async (msg: Record<string, unknown>, opts?: Parameters<typeof realSend>[1]) => {
    if (!faking) return realSend(msg, opts);
    bridged.push(msg as { targetName: string; text: string });
    return { ok: true };
  },
}));
const { setAutostartSwitch } = await import("../src/lib/ledger-autostart.js");
const { createFeature, initDag } = await import("../src/lib/ledger-feature-write.js");
const { closeLedger, openLedger } = await import("../src/lib/ledger-store.js");
const { LedgerReader } = await import("../src/lib/ledger-read.js");
const { runLedger } = await import("../src/manager/ledger.js");
const { setMeta } = await import("../src/lib/ledger-write.js");
const { pmRedirect } = await import("../src/lib/pm-role.js");
const { specWaitTick } = await import("../src/lib/scheduler-spec-wait.js");
const { notifyProjectPm } = await import("../src/lib/pm-notify.js");

const PROJ = "claude-orchestrator", P = "agent-pm-codex", X = "agent-claudestra", FID = "ab12-i28";
let dir: string, db: Database, now: number;
const set = (pm: string) => setAutostartSwitch(db, { actor: P, now: now++ }, { project: PROJ, on: true, featureId: FID, pm, reason: "测试" });

beforeEach(() => {
  now = Date.now();
  bridged.length = 0;
  faking = true;
  dir = mkdtempSync(join(tmpdir(), "pmwake-redirect-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: PROJ, key: "pms", value: [X, P] });
  db.query("INSERT INTO meta (project, key, value) VALUES (?, 'activePm', ?)").run(PROJ, JSON.stringify(P));
  createFeature(db, { actor: P, now: now++ }, { project: PROJ, slug: "i28", title: "协作底座" });
  initDag(db, { actor: P, now: now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
});
afterEach(() => {
  faking = false;
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

test("main 的行为：名单里的非当班 PM 被转给当班 PM", () => {
  expect(pmRedirect(db, PROJ, X)).toBe(P);
  expect(pmRedirect(db, PROJ, P)).toBeNull();
});

test("A 的 feature pm=X → pmRedirect(project, X) 为 null；清掉后回到 P", () => {
  set(X);
  expect(pmRedirect(db, PROJ, X)).toBeNull();
  set("-");
  expect(pmRedirect(db, PROJ, X)).toBe(P);
});

test("不在名单的 target 照旧不转（null）；--pm 写不在名单的人被拒", () => {
  expect(pmRedirect(db, PROJ, "agent-other")).toBeNull();
  expect(() => set("agent-other")).toThrow("不在项目 PM 名单里");
});

test("缺规格提醒端到端（缺省发送 = 本轮 notifyPm → notifyProjectPm → bridge；读走生产同款只读 LedgerReader、写走调度 ledger CLI）：假 bridge 收到的目标是 X，不是当班 PM", async () => {
  set(X);
  setAutostartSwitch(db, { actor: P, now: now++ }, { project: PROJ, on: true, specWait: "on", reason: "测试" });
  const reader = new LedgerReader(join(dir, "ledger.sqlite"));
  const ro = reader.get() as Database;
  expect((ro.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
  const ledger = (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [PROJ], loadRegistry: async () => ({ socket: "", agents: {} }) as never,
    saveRegistry: async () => {}, now: () => now, autoDispatch: () => true, autoProjects: () => [PROJ] });
  const notifyPm = (project: string, text: string) => notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: () => true });
  const failed = await specWaitTick({ db: ro, ledger, svc: { autoDispatch: true, projects: [PROJ], maxWorkers: () => 3 }, readSpec: () => null, now: () => now, notifyPm });
  reader.close();
  expect(failed).toEqual([]);
  expect(bridged.map((m) => m.targetName)).toEqual([X]);
  expect(pmRedirect(db, PROJ, bridged[0].targetName)).toBeNull();
});
