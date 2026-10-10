/**
 * team-project-PMWAKE 第 2 轮审查两条 P1 的负例：
 * - spec-recheck：调度从只读连接预读 PM / 门之后、ledger CLI 真正写之前，PM 改派或项目冻结 → writer 回 conflict，0 记录 0 发送，
 *   下一轮按新状态发给新 PM（不被旧目标消耗 30 分钟窗口）。
 * - send-after-stop：缺省发送走本轮 notifyPm（notifyProjectPm + stillActive，与 scheduler-autostart-deps.ts 同款接线），
 *   bridge 握手期间停服 → 0 帧。只把 WebSocket 换成假的，bridgeSend / notifyProjectPm / ledger CLI 都是真实现。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { notifyProjectPm } from "../src/lib/pm-notify.js";
import { featureGate } from "../src/lib/scheduler-autostart.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { specWaitTick, type SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import { runLedger } from "../src/manager/ledger.js";

const PROJ = "claude-orchestrator", PM = "agent-pm", X = "agent-x", Y = "agent-y", FID = "ab12-i28";
let dir: string, db: Database, reader: LedgerReader, now: number;
let sent: { to: string; text: string }[];

const sw = (input: { featureId?: string; pm?: string; specWait?: string }) =>
  setAutostartSwitch(db, { actor: PM, now: now++ }, { project: PROJ, on: true, ...input, reason: "测试" });
const records = () => listEvents(db, { target: FID }).filter((e) => e.data.op === "spec_wait");
const schedLedger = (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [PROJ],
  loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, now: () => now, autoDispatch: () => true, autoProjects: () => [PROJ] });

function env(over: Partial<SpecWaitEnv> = {}): SpecWaitEnv {
  return {
    db: reader.get() as Database, ledger: schedLedger, svc: { autoDispatch: true, projects: [PROJ], maxWorkers: () => 3 }, readSpec: () => null, now: () => now,
    notifyPm: async () => { throw new Error("不该走缺省发送"); },
    specWaitSend: async (_db, _p, to, text) => void sent.push({ to, text }), ...over,
  };
}

/** 在 env.ledger 入口、真正调 runLedger 之前改台账（模拟预读与写之间的异步间隙） */
const raceLedger = (change: () => void) => async (...args: string[]) => { change(); return schedLedger(...args); };

beforeEach(() => {
  now = Date.now();
  sent = [];
  dir = mkdtempSync(join(tmpdir(), "pmwake-race-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: PROJ, key: "pms", value: [PM, X, Y] });
  createFeature(db, { actor: PM, now: now++ }, { project: PROJ, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
  sw({ specWait: "on" });
  sw({ featureId: FID, pm: X });
  reader = new LedgerReader(join(dir, "ledger.sqlite"));
  expect(((reader.get() as Database).query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
});
afterEach(() => {
  reader.close();
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("spec-recheck：预读到写之间条件变了 → conflict，下一轮按新状态重判", () => {
  test("PM 改派（X → Y）：本轮 0 记录 0 发送；下一轮立刻发给 Y（窗口没被旧目标占掉）", async () => {
    expect(await specWaitTick(env({ ledger: raceLedger(() => sw({ featureId: FID, pm: Y })) }))).toEqual([]);
    expect(records()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await specWaitTick(env())).toEqual([]);
    expect(sent.map((s) => s.to)).toEqual([Y]);
    expect(records().map((e) => e.data.pm)).toEqual([Y]);
  });

  test("项目冻结：本轮 0 记录 0 发送；解冻后照发", async () => {
    expect(await specWaitTick(env({ ledger: raceLedger(() => setFrozen(db, { actor: PM, now: now++ }, { project: PROJ, frozen: true, reason: "测试" })) }))).toEqual([]);
    expect(records()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await specWaitTick(env())).toEqual([]);
    expect(sent).toEqual([]);
    setFrozen(db, { actor: PM, now: now++ }, { project: PROJ, frozen: false });
    expect(await specWaitTick(env())).toEqual([]);
    expect(sent.map((s) => s.to)).toEqual([X]);
  });

  test("writer 直接被调：--pm 不是当前 featurePm → conflict；容量满不拦（CLI 的 svc 给 maxWorkers=0，容量门恒满：只豁免容量）", async () => {
    expect(featureGate(db, getFeature(db, FID)!, { autoDispatch: true, projects: [PROJ], maxWorkers: () => 0 })?.gate).toBe("capacity");
    const w = (pm: string) => schedLedger("ledger", "scheduler-autostart", "spec-wait", FID, "a", "--version", "1", "--mode", "on", "--pm", pm, "--text", "t");
    expect(await w(PM)).toMatchObject({ ok: false, code: "conflict" });
    expect(records()).toEqual([]);
    expect(await w(X)).toMatchObject({ ok: true, due: true });
  });
});

describe("send-after-stop：缺省发送带本轮存活检查", () => {
  const RealWS = globalThis.WebSocket;
  let frames: { targetName: string }[], stopped: boolean, stopOnConnect: boolean;
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      if (stopOnConnect) stopped = true; // 连接已发起、onopen 之前停服 / 失租
      setTimeout(() => this.onopen?.(), 0);
    }
    send(raw: string) {
      const msg = JSON.parse(raw);
      frames.push(msg);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ requestId: msg.requestId, result: { ok: true } }) }), 0);
    }
    close() {}
  }
  // 与 scheduler-autostart-deps.ts 的 autostartHooks 同款：active() 抛错 = 停了；notifyPm 带 stillActive
  const active = () => { if (stopped) throw new SchedulerStopped("停了"); };
  const alive = () => { try { active(); return true; } catch { return false; } };
  const prodEnv = () => env({ specWaitSend: undefined, notifyPm: (project, text) => notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: alive }) });

  beforeEach(() => {
    frames = [];
    stopped = false;
    stopOnConnect = false;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
  });
  afterEach(() => {
    globalThis.WebSocket = RealWS;
  });

  test("服务在：发 1 帧，目标是 feature PM X", async () => {
    expect(await specWaitTick(prodEnv())).toEqual([]);
    expect(frames.map((f) => f.targetName)).toEqual([X]);
  });

  test("握手期间停服：0 帧（stillActive 在发帧同一同步段拦下）", async () => {
    stopOnConnect = true;
    const failed = await specWaitTick(prodEnv());
    expect(stopped).toBe(true);
    expect(frames).toEqual([]);
    expect(failed.map((f) => f.error).join()).toContain("发送方已停止");
  });
});
