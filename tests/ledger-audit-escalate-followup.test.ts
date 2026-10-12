/**
 * dispatch-recovery-AUDESC2：巡检升级的四处跟进——首轮静默不算已投递、升级给当班 PM、确认 id 不靠逗号拼接、投递失败留日志。
 * 夹具同 ledger-audit-escalate.test.ts：合成台账库 + 真 CLI（runLedger audit）+ 真 bridge 定时器（ledgerAuditTicker，runManager 直通 CLI）。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackEscalateArgs } from "../src/bridge/ledger-audit-escalate.js";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { AUDIT_ESCALATE_MS, ESCALATE_NO_SILENCE_RULES, escalateTarget, setAuditEscalatePorts, silencedAtBaseline } from "../src/lib/ledger-audit-escalate.js";
import { ackFindings, type StoredFinding } from "../src/lib/ledger-audit-store.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const T0 = 1_000 * MIN;
const OLD_PM = "agent-claudestra";
const NEW_PM = "agent-claudestra-next";
const DIS = "agent-pm-dispatch";
const EXE = "agent-task-t1";
const P = "claude-orchestrator";
const RULE = "review_no_reviewer";

let dir: string, path: string, db: Database, statePath: string;
let now = T0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-escalate-followup-"));
  path = tempLedgerPath("ledger-audit-escalate-followup-db-");
  statePath = join(dir, "audit-escalations.json");
  db = openLedger(path);
  now = T0;
  setAuditEscalatePorts({ policy: (_p, key) => ({ mode: key === "auditEscalate" ? "on" : "observe", manualAfterMs: null, source: "config" }), path: statePath });
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [OLD_PM, NEW_PM, DIS] });
});
afterEach(() => {
  setAuditEscalatePorts();
  closeLedger(path);
});

/** 一张进了 review、没人审的卡：review_no_reviewer 会推给调度助理 */
function reviewTask(id: string, reviewAt: number): void {
  createTask(db, { actor: "owner", now: 0 }, { project: P, id, title: `巡检 ${id}`, kind: "code", agent: EXE, pm: OLD_PM, stage: "build" });
  moveStage(db, { actor: "owner", now: reviewAt }, { taskId: id, from: "build", to: "review" });
}

async function cli(actor: string, ...args: string[]): Promise<Record<string, any>> {
  return runLedger(["audit", ...args], {
    db, actor, actorProject: P, projectIds: [P], now: () => now,
    auditSources: {
      registry: async () => [OLD_PM, NEW_PM, DIS, EXE].map((name) => ({ name, channelId: `c-${name}`, projectId: P, cwd: dir, sessionId: `s-${name}` })),
      windows: async () => ["master", OLD_PM, NEW_PM, DIS, EXE], turn: async () => "idle",
      fileTimes: async () => ({ lastWriteAt: now - 5 * MIN, startedAt: 0 }), reviewers: () => [], heldPath: join(dir, "held.json"),
    },
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

type Row = { key: string; taskId: string; notifiedAt: number | null };
const rows = () => db.query("SELECT key, taskId, notifiedAt FROM audit_findings WHERE rule = ? AND resolvedAt IS NULL ORDER BY taskId").all(RULE) as Row[];
/** 跑一轮巡检，把这条规则的 pending 记成已投给调度助理（不走 bridge 的 --ack：那一路不在本卡范围） */
async function deliverPending(): Promise<string[]> {
  const pending = ((await cli("owner", "--json")).pending as StoredFinding[]).filter((f) => f.rule === RULE);
  expect(pending.every((f) => f.notify === DIS)).toBe(true);
  ackFindings(db, pending.map((f) => f.key), now);
  return pending.map((f) => f.taskId as string);
}
const setActivePm = (agent: string) => // 同 pm-role-switch.ts commitPointer 的写法
  db.query("INSERT INTO meta(project,key,value) VALUES(?,?,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value").run(P, "activePm", JSON.stringify(agent));

type Sent = { to: string | undefined; content: string };
function bridge(online: string[] = [OLD_PM, NEW_PM, DIS]) {
  const sent: Sent[] = [];
  const calls: string[][] = [];
  const clients: LedgerAuditDeps["clients"] = new Map(online.map((a) => [`c-${a}`, { ws: {} as never, channelId: `c-${a}` }]));
  const d: LedgerAuditDeps = {
    clients,
    deliver: async (env: Envelope) => (sent.push({ to: (env.to as { agentName?: string }).agentName, content: String(env.content) }), { outcome: { kind: "sent" } }),
    hold: () => {},
    lastMessageSource: { set: () => {} },
    runManager: async (...args: string[]) => (calls.push(args), cli("owner", ...args.slice(2))),
    busy: async () => false,
    channelOf: (a) => `c-${a}`,
    failureTargets: () => [],
  };
  return { sent, calls, clients, tick: ledgerAuditTicker(d) };
}
const escalateAcks = (calls: string[][]) => calls.filter((c) => c.includes("--ack-escalate"));
const state = () => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>) : {});
const finding = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  key: `${P}|${RULE}|T1`, project: P, taskId: "T1", rule: RULE, firstSeen: T0, lastSeen: T0, resolvedAt: null, since: T0,
  detail: "d", suggestion: "s", notify: DIS, notifiedAt: T0, queuedAs: null, changedAt: T0, ...over,
});

describe("[验收线 1] 首轮静默不算已投递", () => {
  test("规则第一次跑静默的 3 条，61 分钟后一条都不升级；基线之后真正投递的一条照常升级", async () => {
    for (const id of ["T1", "T2", "T3"]) reviewTask(id, T0 - 30 * MIN);
    const first = await cli("owner", "--json");
    const silenced = rows();
    expect(silenced.map((r) => r.taskId)).toEqual(["T1", "T2", "T3"]);
    expect(silenced.every((r) => r.notifiedAt === T0)).toBe(true); // 记成已推过，实际一条没发
    expect(first.projects[0].silenced).toBe(3);
    expect(first.pending.filter((f: StoredFinding) => f.rule === RULE)).toEqual([]);

    reviewTask("T4", T0 + 31 * MIN);
    now = T0 + 61 * MIN;
    expect(await deliverPending()).toEqual(["T4"]); // 基线之后新出现、真正投给调度助理
    expect((await cli("owner", "--json")).escalate).toEqual([]); // 改动前：T1 T2 T3 三条都在这里

    now = T0 + 122 * MIN;
    const r = await cli("owner", "--json");
    expect(r.escalate.map((e: any) => [e.taskId, e.rule, e.notifiedAt, e.from])).toEqual([["T4", RULE, T0 + 61 * MIN, DIS]]);
    const { sent, tick } = bridge();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain(`T4 · ${RULE}`);
    for (const id of ["T1", "T2", "T3"]) expect(sent[0]!.content).not.toContain(`${id} · `);
  });

  test("判定：notifiedAt 不晚于该规则的基线 since = 静默；没有基线 / 首轮不静默的规则不受影响", () => {
    const at = T0 + AUDIT_ESCALATE_MS;
    const pms = [OLD_PM, DIS];
    expect(escalateTarget(finding(), pms, null, {}, at, { baseline: new Map([[RULE, T0]]) })).toBeNull();
    expect(escalateTarget(finding(), pms, null, {}, at, { baseline: new Map([[RULE, T0 + 1]]) })).toBeNull();
    expect(escalateTarget(finding(), pms, null, {}, at, { baseline: new Map([[RULE, T0 - 1]]) })).toEqual({ from: DIS, to: OLD_PM });
    expect(escalateTarget(finding(), pms, null, {}, at, { baseline: new Map([["executor_idle", T0]]) })).toEqual({ from: DIS, to: OLD_PM }); // 别的规则的基线不算
    expect(escalateTarget(finding(), pms, null, {}, at, { baseline: new Map() })).toEqual({ from: DIS, to: OLD_PM });
    expect(escalateTarget(finding(), pms, null, {}, at)).toEqual({ from: DIS, to: OLD_PM });
    for (const rule of ESCALATE_NO_SILENCE_RULES) {
      expect(silencedAtBaseline({ rule, notifiedAt: T0 }, new Map([[rule, T0]]))).toBe(false);
      expect(escalateTarget(finding({ rule }), pms, null, {}, at, { baseline: new Map([[rule, T0]]) })).toEqual({ from: DIS, to: OLD_PM });
    }
  });

  test("首轮不静默的规则名单与 ledger-audit-store.ts 一致", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/ledger-audit-store.ts"), "utf8");
    const m = src.match(/const NO_SILENCE_RULES[^=]*=\s*(\[[^\]]*\])/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual([...ESCALATE_NO_SILENCE_RULES]);
  });
});

describe("[验收线 2] 升级发给当班 PM", () => {
  beforeEach(() => {
    baselineAudit(db, P);
    reviewTask("T1", T0 - 30 * MIN);
  });
  const escalatedTo = async () => ((await cli("owner", "--json")).escalate as { to: string }[]).map((e) => e.to);

  test("pms = [旧 PM, 新 PM]、activePm = 新 PM：升级发给新 PM（改动前发给旧 PM）", async () => {
    setActivePm(NEW_PM);
    await deliverPending();
    now = T0 + 61 * MIN;
    expect(await escalatedTo()).toEqual([NEW_PM]);
    const { sent, tick } = bridge([NEW_PM, DIS]); // 旧 PM 已离线
    await tick();
    expect(sent.map((s) => s.to)).toEqual([NEW_PM]);
    expect(Object.keys(state())).toHaveLength(1);
  });

  test("activePm 没设、或设成调度助理：与改前一致，发给名单里第一个不是调度助理的人", async () => {
    await deliverPending();
    now = T0 + 61 * MIN;
    expect(await escalatedTo()).toEqual([OLD_PM]);
    setActivePm(DIS);
    expect(await escalatedTo()).toEqual([OLD_PM]);
  });

  test("判定：activePm 是调度助理（按班子配置认）/ 就是原收件人 / 空串时退回 auditRecipient", () => {
    const at = T0 + AUDIT_ESCALATE_MS;
    const pms = [OLD_PM, NEW_PM, DIS];
    expect(escalateTarget(finding(), pms, null, {}, at, { activePm: NEW_PM })).toEqual({ from: DIS, to: NEW_PM });
    expect(escalateTarget(finding(), pms, null, {}, at, { activePm: "" })).toEqual({ from: DIS, to: OLD_PM });
    expect(escalateTarget(finding(), pms, null, {}, at, { activePm: null })).toEqual({ from: DIS, to: OLD_PM });
    expect(escalateTarget(finding({ notify: NEW_PM }), pms, NEW_PM, {}, at, { activePm: NEW_PM })).toEqual({ from: NEW_PM, to: OLD_PM });
    expect(escalateTarget(finding({ notify: OLD_PM }), pms, null, {}, at, { activePm: NEW_PM })).toBeNull(); // 本来就推给 PM 的不升级
  });
});

describe("[验收线 3] 确认 id 每个单独一个参数", () => {
  const IDS = ["ESC,1", "ESC 2", `ESC"3'`, "T1"];

  test("带逗号 / 空格 / 引号的卡号和普通卡号同一批确认，都确认成功，下一轮都不重推", async () => {
    baselineAudit(db, P);
    for (const id of IDS) reviewTask(id, T0 - 30 * MIN);
    expect((await deliverPending()).sort()).toEqual([...IDS].sort());
    const expected = rows().map((r) => `${r.key}@${T0}`).sort();
    expect(expected.some((id) => id.includes("ESC,1"))).toBe(true);

    now = T0 + 61 * MIN;
    const { sent, calls, tick } = bridge();
    await tick();
    expect(sent.map((s) => s.to)).toEqual([OLD_PM]);
    const acks = escalateAcks(calls);
    expect(acks).toHaveLength(1);
    const args = acks[0]!.slice(3).filter((a) => a !== "--");
    expect([...args].sort()).toEqual(expected); // 一个 id 一个参数，原样不拆
    expect(Object.keys(state()).sort()).toEqual(expected); // 改动前：ack 判 invalid，这里是空的

    now += 15 * MIN;
    await tick();
    expect(sent).toHaveLength(1);
    expect(escalateAcks(calls)).toHaveLength(1);
    expect((await cli("owner", "--json")).escalate).toEqual([]);
  });

  test("CLI：多个 id 一次确认；逗号不再当分隔符；一个不带 id 的 --ack-escalate 报 invalid", async () => {
    const a = `${P}|${RULE}|ESC,1|r1@${T0}`;
    const b = `${P}|${RULE}|--weird x|r1@${T0}`;
    expect(ackEscalateArgs([a])).toEqual(["ledger", "audit", "--ack-escalate", a]);
    expect(ackEscalateArgs([a, b])).toEqual(["ledger", "audit", "--ack-escalate", a, "--", b]);
    expect(await cli("owner", ...ackEscalateArgs([a, b]).slice(2))).toEqual({ ok: true, escalated: 2 });
    expect((await cli("owner", "--ack-escalate", "")).code).toBe("invalid");
    expect((await cli("owner", "--ack-escalate", a, "--", `${P}|没有时刻`)).code).toBe("invalid");
    expect((await cli(EXE, "--ack-escalate", a, "--", b)).ok).toBe(false);
  });
});

describe("[验收线 4] 投递失败留日志", () => {
  test("连续失败两轮再成功：一条失败日志、一条恢复日志；失败的两轮没有 ack，下一轮照常重推", async () => {
    baselineAudit(db, P);
    reviewTask("T1", T0 - 30 * MIN);
    await deliverPending();
    const id = `${rows()[0]!.key}@${T0}`;
    const logs: string[] = [];
    const record = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const spies = [spyOn(console, "error").mockImplementation(record), spyOn(console, "log").mockImplementation(record)];
    const failed = () => logs.filter((l) => l.includes("台账巡检升级投递失败"));
    const recovered = () => logs.filter((l) => l.includes("台账巡检升级投递恢复"));
    try {
      const { sent, calls, clients, tick } = bridge([DIS]); // PM 不在线：notify 回 failed
      for (const round of [1, 2]) {
        now = T0 + 61 * MIN + (round - 1) * 15 * MIN;
        await tick();
        expect(sent).toEqual([]);
        expect(escalateAcks(calls)).toEqual([]);
        expect(state()).toEqual({});
        expect(((await cli("owner", "--json")).escalate as { key: string }[]).map((e) => e.key)).toEqual([rows()[0]!.key]); // 下一轮还会列出来
        expect(failed()).toHaveLength(1);
      }
      expect(failed()[0]).toContain(`收件人 ${OLD_PM}`);
      expect(failed()[0]).toContain("1 条");
      expect(failed()[0]).toContain("原因：收件人不在线或投递未被接受");
      expect(recovered()).toEqual([]);

      clients.set(`c-${OLD_PM}`, { ws: {} as never, channelId: `c-${OLD_PM}` });
      now += 15 * MIN;
      await tick();
      expect(sent.map((s) => s.to)).toEqual([OLD_PM]);
      expect(escalateAcks(calls)).toEqual([["ledger", "audit", "--ack-escalate", id]]);
      expect(Object.keys(state())).toEqual([id]);
      expect(failed()).toHaveLength(1);
      expect(recovered()).toHaveLength(1);
      expect(recovered()[0]).toContain(`收件人 ${OLD_PM}`);

      now += 15 * MIN;
      await tick();
      expect(sent).toHaveLength(1);
      expect(recovered()).toHaveLength(1);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("notify 抛错同样按收件人去重，日志带错误原因；别的收件人照常推", async () => {
    const { ledgerAuditEscalator } = await import("../src/bridge/ledger-audit-escalate.js");
    const entry = (to: string, key: string) => ({ key, taskId: "T1", rule: RULE, notifiedAt: T0, from: DIS, to, detail: "d", mode: "on" as const });
    const raw = { escalate: [entry(OLD_PM, "k1"), entry(OLD_PM, "k2"), entry(NEW_PM, "k3")] };
    const errs: string[] = [];
    const spies = [spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" "))), spyOn(console, "log").mockImplementation(() => {})];
    try {
      const acks: string[][] = [];
      let broken = true;
      const run = ledgerAuditEscalator({
        notify: async (to) => {
          if (to === OLD_PM && broken) throw new Error("socket closed");
          return { kind: "sent" };
        },
        runManager: async (...args) => (acks.push(args), { ok: true }),
      });
      await run(raw);
      await run(raw);
      expect(errs).toEqual([`⚠️ 台账巡检升级投递失败（不确认，下一轮重推）：收件人 ${OLD_PM}，2 条，原因：socket closed`]);
      expect(acks).toEqual([["ledger", "audit", "--ack-escalate", `k3@${T0}`], ["ledger", "audit", "--ack-escalate", `k3@${T0}`]]);
      broken = false;
      await run(raw);
      expect(acks.at(-2)).toEqual(["ledger", "audit", "--ack-escalate", `k1@${T0}`, "--", `k2@${T0}`]);
      broken = true;
      await run(raw);
      expect(errs).toHaveLength(2); // 恢复之后再坏，是新的一次失败
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
