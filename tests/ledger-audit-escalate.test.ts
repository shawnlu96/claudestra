/**
 * dispatch-recovery-AUDESC1：推给调度助理 60 分钟没人处理的巡检提醒升级给当班 PM。
 * 夹具是真台账库 + 真 CLI（runLedger audit）+ 真 bridge 定时器（ledgerAuditTicker，runManager 直通 CLI）；
 * 恢复策略 auditEscalate 与状态文件路径经 setAuditEscalatePorts 注入。「改动前」= `ledger audit --json` 没有 escalate、bridge 没有任何后续。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalateNoticeText } from "../src/bridge/ledger-audit-escalate.js";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { AUDIT_ESCALATE_MS, escalateTarget, parseEscalateId, setAuditEscalatePorts } from "../src/lib/ledger-audit-escalate.js";
import type { StoredFinding } from "../src/lib/ledger-audit-store.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const T0 = 1_000 * MIN;
const PM = "agent-claudestra";
const DIS = "agent-pm-dispatch";
const EXE = "agent-task-t1";
const P = "claude-orchestrator";

let dir: string, path: string, db: Database, statePath: string;
let now = T0;
let mode: RecoveryMode = "on";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-escalate-"));
  path = tempLedgerPath("ledger-audit-escalate-db-");
  statePath = join(dir, "audit-escalations.json");
  db = openLedger(path);
  now = T0;
  mode = "on";
  setAuditEscalatePorts({ policy: (_p, key) => ({ mode: key === "auditEscalate" ? mode : "observe", manualAfterMs: null, source: "config" }), path: statePath });
  const owner = { actor: "owner", now: 0 };
  createTask(db, owner, { project: P, id: "T1", title: "巡检", kind: "code", agent: EXE, pm: PM, stage: "build" });
  moveStage(db, { actor: "owner", now: T0 - 30 * MIN }, { taskId: "T1", from: "build", to: "review" });
  setMeta(db, owner, { project: P, key: "pms", value: [PM, DIS] });
  baselineAudit(db, P);
});
afterEach(() => {
  setAuditEscalatePorts();
  closeLedger(path);
});

async function cli(actor: string, ...args: string[]): Promise<Record<string, any>> {
  return runLedger(["audit", ...args], {
    db, actor, actorProject: P, projectIds: [P], now: () => now,
    auditSources: {
      registry: async () => [PM, DIS, EXE].map((name) => ({ name, channelId: `c-${name}`, projectId: P, cwd: dir, sessionId: `s-${name}` })),
      windows: async () => ["master", PM, DIS, EXE], turn: async () => "idle",
      fileTimes: async () => ({ lastWriteAt: now - 5 * MIN, startedAt: 0 }), reviewers: () => [], heldPath: join(dir, "held.json"),
    },
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

const row = () => db.query("SELECT key, notifiedAt, resolvedAt FROM audit_findings WHERE rule = 'review_no_reviewer'").get() as { key: string; notifiedAt: number | null; resolvedAt: number | null };
/** 第一轮：review_no_reviewer 推给调度助理、ack（notifiedAt = now） */
async function pushedToDispatcher(): Promise<string> {
  const a = await cli("owner", "--json");
  const f = a.pending.find((x: any) => x.rule === "review_no_reviewer");
  expect(f.notify).toBe(DIS);
  expect(await cli("owner", "--ack", f.key)).toEqual({ ok: true, acked: 1 });
  return f.key;
}

type Sent = { kind: "deliver" | "hold"; env: Envelope };
function bridge(over: Partial<LedgerAuditDeps> = {}) {
  const sent: Sent[] = [];
  const calls: string[][] = [];
  const d: LedgerAuditDeps = {
    clients: new Map([PM, DIS].map((a) => [`c-${a}`, { ws: {} as never, channelId: `c-${a}` }])),
    deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: "sent" } }),
    hold: (env) => void sent.push({ kind: "hold", env }),
    lastMessageSource: { set: () => {} },
    runManager: async (...args: string[]) => (calls.push(args), cli("owner", ...args.slice(2))),
    busy: async () => false,
    channelOf: (a) => `c-${a}`,
    failureTargets: () => [],
    ...over,
  };
  return { d, sent, calls, tick: ledgerAuditTicker(d) };
}
const to = (s: Sent) => (s.env.to as { agentName?: string }).agentName;
const escalateAcks = (calls: string[][]) => calls.filter((c) => c.includes("--ack-escalate"));
const state = () => JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>;

describe("[验收线 1] 推给调度助理 61 分钟后仍开着 → 升级给 PM", () => {
  test("escalate 有这一条、to 是 PM；bridge 一轮后 PM 收到一条合并通知、状态文件有 key@notifiedAt；再跑一轮不再推", async () => {
    const key = await pushedToDispatcher();
    now = T0 + 61 * MIN;
    const r = await cli("owner", "--json");
    expect(r.escalate).toEqual([{ key, taskId: "T1", rule: "review_no_reviewer", notifiedAt: T0, from: DIS, to: PM, detail: expect.stringContaining("T1"), mode: "on" }]);
    const { sent, calls, tick } = bridge();
    await tick();
    expect(sent.map(to)).toEqual([PM]);
    const text = String(sent[0]!.env.content);
    expect(text).toContain("调度助理 60 分钟没处理的巡检提醒");
    expect(text).toContain("T1 · review_no_reviewer");
    expect(escalateAcks(calls)).toEqual([["ledger", "audit", "--ack-escalate", `${key}@${T0}`]]);
    expect(state()).toEqual({ [`${key}@${T0}`]: now });
    expect(row()).toMatchObject({ notifiedAt: T0, resolvedAt: null }); // 不改 audit_findings
    now += 15 * MIN;
    await tick();
    expect(sent).toHaveLength(1);
    expect((await cli("owner", "--json")).escalate).toEqual([]);
  });

  test("meta.team.dispatcher 指定的调度助理（名字里没有 dispatch）同样升级", async () => {
    setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [DIS, "agent-helper"] });
    setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "team", value: { dispatcher: "agent-helper", audit: true } });
    const f = (await cli("owner", "--json")).pending.find((x: any) => x.rule === "review_no_reviewer");
    expect(f.notify).toBe("agent-helper");
    await cli("owner", "--ack", f.key);
    now = T0 + 60 * MIN;
    const r = await cli("owner", "--json");
    expect(r.escalate.map((e: any) => [e.from, e.to])).toEqual([["agent-helper", DIS]]);
  });

  test("通知每条一行，detail 截 120 字", () => {
    const text = escalateNoticeText([{ key: "k", taskId: "T9", rule: "executor_idle", notifiedAt: T0, from: DIS, to: PM, detail: "长".repeat(200), mode: "on" }]);
    const line = text.split("\n")[1]!;
    expect(line).toContain("T9 · executor_idle · 首次推送 ");
    expect(line).toContain(`${"长".repeat(120)}…`);
    expect(line).not.toContain("长".repeat(121));
  });
});

describe("[验收线 2] 不升级", () => {
  const f = (over: Partial<StoredFinding> = {}): StoredFinding => ({
    key: "p|review_no_reviewer|T1", project: P, taskId: "T1", rule: "review_no_reviewer", firstSeen: T0, lastSeen: T0, resolvedAt: null, since: T0,
    detail: "d", suggestion: "s", notify: DIS, notifiedAt: T0, queuedAs: null, changedAt: T0, ...over,
  });
  const at = T0 + AUDIT_ESCALATE_MS;

  test("满 60 分钟正好升级（基准）", () => {
    expect(escalateTarget(f(), [PM, DIS], null, {}, at)).toEqual({ from: DIS, to: PM });
  });
  test("59 分钟 / 已解决 / 本来推 PM / 没配 PM / PM 就是调度助理 / notifiedAt 为空 / 同一推送已升级过", () => {
    expect(escalateTarget(f(), [PM, DIS], null, {}, T0 + 59 * MIN)).toBeNull();
    expect(escalateTarget(f({ resolvedAt: at }), [PM, DIS], null, {}, at)).toBeNull();
    expect(escalateTarget(f({ rule: "pm_held", notify: PM }), [PM, DIS], null, {}, at)).toBeNull();
    expect(escalateTarget(f(), [DIS], null, {}, at)).toBeNull();
    expect(escalateTarget(f({ notify: PM }), [PM], PM, {}, at)).toBeNull();
    expect(escalateTarget(f({ notifiedAt: null, queuedAs: "m1" }), [PM, DIS], null, {}, at)).toBeNull();
    expect(escalateTarget(f(), [PM, DIS], null, { [`${f().key}@${T0}`]: at }, at)).toBeNull();
  });

  test("CLI：59 分钟、notifiedAt 为空、已升级过、已解决 → escalate 不含它", async () => {
    const a = await cli("owner", "--json");
    const key = a.pending.find((x: any) => x.rule === "review_no_reviewer").key;
    now = T0 + 61 * MIN;
    expect((await cli("owner", "--json")).escalate).toEqual([]); // 还没推出去：走现有回落
    now = T0;
    await cli("owner", "--ack", key);
    now = T0 + 59 * MIN;
    expect((await cli("owner", "--json")).escalate).toEqual([]);
    now = T0 + 60 * MIN;
    expect((await cli("owner", "--dry-run")).escalate.map((e: any) => e.key)).toEqual([key]);
    writeFileSync(statePath, JSON.stringify({ [`${key}@${T0}`]: now }));
    expect((await cli("owner", "--json")).escalate).toEqual([]);
    writeFileSync(statePath, "{}");
    db.prepare("UPDATE audit_findings SET resolvedAt = ? WHERE key = ?").run(now, key);
    expect((await cli("owner", "--dry-run")).escalate).toEqual([]);
  });

  test("CLI：没配 PM（只有调度助理）→ 不升级", async () => {
    setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [DIS] });
    await pushedToDispatcher();
    now = T0 + 90 * MIN;
    expect((await cli("owner", "--json")).escalate).toEqual([]);
  });
});

describe("[验收线 3] 解决后再打开", () => {
  test("再出现、重推、又满 60 分钟 → 再升级一次；旧条目在写入时删掉", async () => {
    const key = await pushedToDispatcher();
    now = T0 + 61 * MIN;
    const { sent, tick } = bridge();
    await tick();
    expect(sent).toHaveLength(1);
    db.prepare("UPDATE audit_findings SET resolvedAt = ? WHERE key = ?").run(now, key); // 解决了；下一轮规则又报 → 重新打开
    now = T0 + 100 * MIN;
    await tick(); // 重新打开、重推给调度助理并 ack（notifiedAt = 这一刻）
    expect(sent.map(to)).toEqual([PM, DIS]);
    const t2 = now;
    expect(row().notifiedAt).toBe(t2);
    now = t2 + 30 * MIN;
    await tick();
    expect(sent).toHaveLength(2);
    now = t2 + 60 * MIN;
    await tick();
    expect(sent.map(to)).toEqual([PM, DIS, PM]);
    expect(state()).toEqual({ [`${key}@${t2}`]: now });
  });
});

describe("[验收线 4] observe / off", () => {
  test("observe：escalate 照算、带 mode observe；bridge 不推、不 ack，日志一行，同一批不重复打", async () => {
    mode = "observe";
    const key = await pushedToDispatcher();
    now = T0 + 61 * MIN;
    expect((await cli("owner", "--json")).escalate).toMatchObject([{ key, to: PM, mode: "observe" }]);
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      const { sent, calls, tick } = bridge();
      await tick();
      await tick();
      expect(sent).toEqual([]);
      expect(escalateAcks(calls)).toEqual([]);
      expect(existsSync(statePath)).toBe(false);
      const obs = logs.filter((l) => l.includes("升级观察"));
      expect(obs).toEqual([`🔎 台账巡检升级观察：1 条该升级给 PM（未推）：${key}@${T0}`]);
    } finally {
      spy.mockRestore();
    }
  });

  test("off：输出没有 escalate 字段（与改前一致），bridge 不推不 ack", async () => {
    mode = "off";
    await pushedToDispatcher();
    now = T0 + 61 * MIN;
    const r = await cli("owner", "--json");
    expect(Object.keys(r)).toEqual(["ok", "now", "dryRun", "projects", "pending"]);
    expect(Object.keys(await cli("owner", "--dry-run"))).toEqual(["ok", "now", "dryRun", "projects"]);
    const { sent, calls, tick } = bridge();
    await tick();
    expect(sent).toEqual([]);
    expect(escalateAcks(calls)).toEqual([]);
  });
});

describe("[验收线 5] 投递", () => {
  test("押后算投出：ack", async () => {
    const key = await pushedToDispatcher();
    now = T0 + 61 * MIN;
    const { sent, calls, tick } = bridge({ busy: async () => true });
    await tick();
    expect(sent.map((s) => [s.kind, to(s)])).toEqual([["hold", PM]]);
    expect(escalateAcks(calls)).toHaveLength(1);
    expect(Object.keys(state())).toEqual([`${key}@${T0}`]);
  });

  test("失败不 ack，下一轮重试", async () => {
    await pushedToDispatcher();
    now = T0 + 61 * MIN;
    let ok = false;
    const { sent, calls, tick } = bridge({ deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: ok ? "sent" : "error" } }) });
    await tick();
    expect(escalateAcks(calls)).toEqual([]);
    ok = true;
    now += 15 * MIN;
    await tick();
    expect(sent.map(to)).toEqual([PM, PM]);
    expect(escalateAcks(calls)).toHaveLength(1);
  });

  test("状态文件读坏：按空、打诊断；pending 那一路照常推和 ack；之后写入覆盖成好文件", async () => {
    writeFileSync(statePath, "{坏");
    const errs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((m: unknown) => void errs.push(String(m)));
    try {
      const { sent, calls, tick } = bridge();
      await tick(); // pending：review_no_reviewer 推给调度助理
      expect(sent.map(to)).toEqual([DIS]);
      expect(calls.some((c) => c.includes("--ack"))).toBe(true);
      expect(row().notifiedAt).toBe(T0);
      now = T0 + 61 * MIN;
      await tick();
      expect(sent.map(to)).toEqual([DIS, PM]);
      expect(errs.some((e) => e.includes("巡检升级状态文件读不了"))).toBe(true);
      expect(Object.keys(state())).toEqual([`${row().key}@${T0}`]);
    } finally {
      spy.mockRestore();
    }
  });

  test("--ack-escalate 权限同 --ack：执行者不能写；格式不对报 invalid", async () => {
    const key = await pushedToDispatcher();
    expect((await cli(EXE, "--ack-escalate", `${key}@${T0}`)).ok).toBe(false);
    expect((await cli("owner", "--ack-escalate", key)).code).toBe("invalid");
    expect(await cli(PM, "--ack-escalate", `${key}@${T0}`)).toEqual({ ok: true, escalated: 1 });
    expect(await cli(PM, "--ack-escalate", `${key}@${T0}`)).toEqual({ ok: true, escalated: 0 });
    expect(parseEscalateId("a|b@c|d@123")).toEqual({ key: "a|b@c|d", notifiedAt: 123 });
  });
});

describe("[验收线 6] 开关", () => {
  test("RECOVERY_KEYS 里 auditEscalate 恰好一次；没配是 observe", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "auditEscalate")).toHaveLength(1);
    expect(recoveryPolicy(P, "auditEscalate", join(dir, "missing-policy.json")).mode).toBe("observe");
  });
});
