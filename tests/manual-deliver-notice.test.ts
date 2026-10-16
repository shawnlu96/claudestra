/**
 * RVF-2：人工卡交付提醒（lib/manual-deliver-notice.ts + bridge/manual-deliver-notice.ts）。真 SQLite 台账 + 假投递 / 假 owner 卡。
 * 交付即通知 PM、N 分钟升级 PM、再 M 分钟进 owner、派审后撤销、自动卡不触发、去重（重跑 / 巡检已推 / 巡检读到已升级）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualDeliverTicker, type OwnerCard } from "../src/bridge/manual-deliver-notice.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { mdnKey, readMdnConfig, readMdnState, setMdnAuditPort } from "../src/lib/manual-deliver-notice.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const MIN = 60_000, T0 = 1_000 * MIN, P = "mdn", PM = "agent-pm", DISP = "agent-disp", EXE = "agent-task-m1", ID = "M1";
let dir: string, path: string, db: Database, clock: number;
let sends: { to: string; text: string; id: string }[], cards: OwnerCard[], closed: string[];
const ctx = (now: number, actor = "owner") => ({ actor, now });

function ticker() {
  return manualDeliverTicker({
    reader: { get: () => db },
    send: async (to, text, id) => (sends.push({ to, text, id }), { handed: true, note: "已送达" }),
    openOwnerCard: (c) => (cards.push(c), `ask_${cards.length}`),
    closeOwnerCard: (id) => void closed.push(id),
    managerCmd: "bun m.ts", log: () => {}, now: () => clock,
    statePath: join(dir, "state.json"), configPath: join(dir, "config.json"),
  });
}
const at = async (t: number, tick = ticker()) => { clock = t; await tick(); };

/** 建一张卡交付一次（交付时刻 T0）；mode = workflow 模式，actor = 交付的人 */
function deliveredCard(mode: "manual" | "auto" | null = "manual", actor = EXE) {
  createTask(db, ctx(0), { project: P, id: ID, title: ID, kind: "code", stage: "spec", agent: EXE });
  if (mode) setWorkflow(db, ctx(MIN), { taskId: ID, taskRev: 1, workflowRev: 0, template: "code", templateVersion: 2, mode,
    authorFamily: "claude", fallback: "PM 核对", reason: "pm_hold: PM 留人工" });
  moveStage(db, ctx(2 * MIN), { taskId: ID, from: "spec", to: "restate" });
  moveStage(db, ctx(3 * MIN), { taskId: ID, from: "restate", to: "build" });
  return deliver(db, ctx(T0, actor), { taskId: ID, moveFrom: "build" }).event;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdn-"));
  path = join(dir, "ledger.sqlite"); db = openLedger(path);
  setMeta(db, ctx(0), { project: P, key: "pms", value: [PM] });
  writeFileSync(join(dir, "state.json"), "{}"); // 已不是首次运行
  sends = []; cards = []; closed = [];
});
afterEach(() => { setMdnAuditPort(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

describe("交付即通知 → N 分钟升级 PM → 再 M 分钟进 owner → 派审撤销", () => {
  test("缺省 10 / 30 分钟，一路走完，重跑不重推", async () => {
    const d = deliveredCard();
    const tick = ticker();
    await at(T0 + MIN, tick);
    expect(sends).toEqual([expect.objectContaining({ to: PM, id: `mdn-${mdnKey(P, ID, d.seq)}-notify` })]);
    expect(sends[0]!.text).toContain(`bun m.ts ledger dispatch ${ID}`);
    await at(T0 + 9 * MIN, tick);
    expect(sends).toHaveLength(1);
    await at(T0 + 10 * MIN, tick);
    expect(sends.map((s) => s.id.split("-").at(-1))).toEqual(["notify", "pm"]);
    expect(sends[1]!.text).toStartWith(`【升级】人工卡 ${ID}`);
    await at(T0 + 39 * MIN, tick);
    expect(cards).toEqual([]);
    await at(T0 + 40 * MIN, tick);
    expect(cards).toEqual([expect.objectContaining({ project: P, taskId: ID, dedupKey: `manual-deliver:${mdnKey(P, ID, d.seq)}` })]);
    expect(cards[0]!.context).toContain(`PM ${PM}`);
    await at(T0 + 80 * MIN, ticker()); // 换一个 ticker（bridge 重启）：状态在文件里，不重推
    expect([sends.length, cards.length, closed]).toEqual([2, 1, []]);
    appendEvent(db, ctx(T0 + 81 * MIN, PM), { project: P, target: ID, kind: "dispatch", text: "派审", data: { round: getTask(db, ID)!.round } });
    await at(T0 + 82 * MIN, tick);
    expect(closed).toEqual(["ask_1"]);
    expect(readMdnState(join(dir, "state.json")).state[mdnKey(P, ID, d.seq)]!.resolvedAt).toBe(T0 + 82 * MIN);
    await at(T0 + 200 * MIN, tick);
    expect([sends.length, cards.length, closed.length]).toEqual([2, 1, 1]);
  });

  test("记了审查结论也撤销；撤销前没开 owner 卡就不关卡", async () => {
    deliveredCard();
    const tick = ticker();
    await at(T0 + MIN, tick);
    await at(T0 + 10 * MIN, tick);
    recordReview(db, ctx(T0 + 11 * MIN, PM), { taskId: ID, reviewer: "rv", verdict: "changes", p0: 0, p1: 1, p2: 0, path: "/r.md", move: { from: "review", to: "fix" } });
    await at(T0 + 60 * MIN, tick);
    expect([sends.length, cards.length, closed]).toEqual([2, 0, []]);
  });

  test("阈值可配：pmAfterMin 2 / ownerAfterMin 3；写错按缺省", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ pmAfterMin: 2, ownerAfterMin: 3 }));
    deliveredCard();
    const tick = ticker();
    await at(T0 + MIN, tick);
    await at(T0 + 2 * MIN, tick);
    expect(sends.map((s) => s.id.split("-").at(-1))).toEqual(["notify", "pm"]);
    await at(T0 + 4 * MIN, tick);
    expect(cards).toHaveLength(0);
    await at(T0 + 5 * MIN, tick);
    expect(cards).toHaveLength(1);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ pmAfterMin: 0 }));
    expect(readMdnConfig(join(dir, "config.json"))).toMatchObject({ config: { pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }, error: expect.any(String) });
  });

  test("bridge 停过、超过 N 才第一次看到：不补发交付通知，直接升级", async () => {
    deliveredCard();
    await at(T0 + 15 * MIN);
    expect(sends.map((s) => s.id.split("-").at(-1))).toEqual(["pm"]);
  });

  test("投递没成功不记，下一轮重投", async () => {
    deliveredCard();
    const tick = manualDeliverTicker({
      reader: { get: () => db }, send: async () => ({ handed: false, note: "不在 registry" }), openOwnerCard: () => "x", closeOwnerCard: () => {},
      managerCmd: "m", log: () => {}, now: () => clock, statePath: join(dir, "state.json"), configPath: join(dir, "config.json"),
    });
    await at(T0 + MIN, tick);
    expect(readMdnState(join(dir, "state.json")).state[mdnKey(P, ID, 3)]?.notified).toBeUndefined();
    await at(T0 + 2 * MIN);
    expect(sends.map((s) => s.to)).toEqual([PM]);
  });
});

describe("不触发 / 不重复", () => {
  test("自动卡不触发", async () => {
    deliveredCard("auto");
    for (const m of [1, 10, 40, 100]) await at(T0 + m * MIN);
    expect([sends, cards]).toEqual([[], []]);
  });

  test.each([[null, EXE], [PM, EXE], [DISP, PM]] as const)("班子路由已直推 PM（调度助理 %p）或 PM 自己交付（%p）：不发交付即通知，升级照常", async (dispatcher, actor) => {
    setMeta(db, ctx(0), { project: P, key: "team", value: { dispatcher, audit: true } });
    deliveredCard("manual", actor);
    await at(T0 + MIN);
    expect(sends).toEqual([]);
    await at(T0 + 10 * MIN);
    expect(sends.map((s) => [s.to, s.id.split("-").at(-1)])).toEqual([[PM, "pm"]]);
  });

  test("配了别人当调度助理：调度助理照收（班子路由），PM 也直接收到", async () => {
    setMeta(db, ctx(0), { project: P, key: "team", value: { dispatcher: DISP, audit: true } });
    deliveredCard();
    await at(T0 + MIN);
    expect(sends.map((s) => s.to)).toEqual([PM]);
  });

  test("巡检已推过这次交付：bridge 不再发升级，从巡检推的时刻起算 owner", async () => {
    const d = deliveredCard();
    db.query(`INSERT INTO audit_findings (key, project, taskId, rule, firstSeen, lastSeen, since, notify, notifiedAt, changedAt)
      VALUES (?, ?, ?, 'manual_deliver_no_review', 0, 0, 0, ?, ?, 0)`).run(`${P}|manual_deliver_no_review|${ID}|${d.seq}`, P, ID, PM, T0 + 5 * MIN);
    await at(T0 + 10 * MIN);
    expect(sends.map((s) => s.id.split("-").at(-1))).toEqual([]); // 超过 N 才第一次看到，通知也不补
    await at(T0 + 35 * MIN);
    expect(cards).toHaveLength(1);
  });

  test("首次运行（状态文件不在）：已在等的交付全部静默记成做过", async () => {
    deliveredCard();
    rmSync(join(dir, "state.json"));
    for (const m of [1, 10, 40, 100]) await at(T0 + m * MIN);
    expect([sends, cards]).toEqual([[], []]);
  });
});

describe("巡检 manual_deliver_no_review 用同一套阈值和去重", () => {
  const observe: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null, source: "config" });
  const snap = () => ({ project: P, pms: [PM, DISP], tasks: [{ task: getTask(db, ID)!, events: listEvents(db, { target: ID }), workflowMode: "manual" as const }],
    agents: [], reviewers: [], held: [], ownerInbox: [] });
  const rule = (now: number) => auditLedger(snap(), now, observe);

  test("N 分钟起推卡的 PM；bridge 已升级过 → keep 不推", () => {
    deliveredCard();
    setMdnAuditPort({ config: () => ({ pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }), pushedAt: () => null });
    expect(rule(T0 + 10 * MIN).findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([]);
    expect(rule(T0 + 11 * MIN).findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([expect.objectContaining({ notify: PM })]);
    setMdnAuditPort({ config: () => ({ pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }), pushedAt: () => T0 + 10 * MIN });
    const r = rule(T0 + 11 * MIN);
    expect(r.findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([]);
    expect(r.keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
  });

  test("巡检读的就是 bridge 写的状态文件（默认口子）", async () => {
    deliveredCard();
    await at(T0 + 10 * MIN);
    const state = readMdnState(join(dir, "state.json")).state;
    setMdnAuditPort({ pushedAt: (k) => state[k]?.pm ?? null });
    expect(rule(T0 + 11 * MIN).keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
  });
});
