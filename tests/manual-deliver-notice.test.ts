/**
 * RVF-2：人工卡交付提醒（lib/manual-deliver-notice.ts + bridge/manual-deliver-notice.ts）。真 SQLite 台账 + 假投递 / 假 owner 卡。
 * 交付即通知 PM、N 分钟升级 PM、再 M 分钟进 owner、派审后撤销、自动卡不触发、去重（重跑 / 巡检已推 / 巡检读到已升级）；
 * 第 1 轮对抗审查（reviews/RVF-2-r1-adv.md）的回归在「审查回归」一节。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualDeliverTicker, serialMdn, type MdnDeps, type OwnerCard } from "../src/bridge/manual-deliver-notice.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { mdnKey, ownerCardText, readMdnConfig, readMdnState, setMdnAuditPort } from "../src/lib/manual-deliver-notice.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const MIN = 60_000, T0 = 1_000 * MIN, P = "mdn", PM = "agent-pm", DISP = "agent-disp", EXE = "agent-task-m1", ID = "M1";
let dir: string, path: string, db: Database, clock: number, statePath: string;
let sends: { to: string; text: string; id: string }[], cards: OwnerCard[], closed: string[];
const ctx = (now: number, actor = "owner") => ({ actor, now });
const kinds = () => sends.map((s) => s.id.split("-").at(-1));
const observe: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null, source: "config" });

function ticker(over: Partial<MdnDeps> = {}) {
  return manualDeliverTicker({
    reader: { get: () => db },
    send: async (to, text, id) => (sends.push({ to, text, id }), { handed: true, note: "已送达" }),
    openOwnerCard: (c) => (cards.push(c), `ask_${cards.length}`),
    closeOwnerCard: (key) => void closed.push(key),
    managerCmd: "bun m.ts", log: () => {}, now: () => clock,
    statePath, configPath: join(dir, "config.json"), ...over,
  });
}
const at = async (t: number, tick = ticker()) => { clock = t; await tick(); };

/** 建一张卡交付一次（交付时刻 T0）；mode = workflow 模式，actor = 交付的人 */
function deliveredCard(mode: "manual" | "auto" | null = "manual", actor = EXE, id = ID) {
  createTask(db, ctx(0), { project: P, id, title: id, kind: "code", stage: "spec", agent: EXE });
  if (mode) setWorkflow(db, ctx(MIN), { taskId: id, taskRev: 1, workflowRev: 0, template: "code", templateVersion: 2, mode,
    authorFamily: "claude", fallback: "PM 核对", reason: "pm_hold: PM 留人工" });
  moveStage(db, ctx(2 * MIN), { taskId: id, from: "spec", to: "restate" });
  moveStage(db, ctx(3 * MIN), { taskId: id, from: "restate", to: "build" });
  return deliver(db, ctx(T0, actor), { taskId: id, moveFrom: "build" }).event;
}
const dispatched = (t: number, id = ID) =>
  appendEvent(db, ctx(t, PM), { project: P, target: id, kind: "dispatch", text: "派审", data: { round: getTask(db, id)!.round } });
const snapOf = (pms: string[]) => ({ project: P, pms, tasks: [{ task: getTask(db, ID)!, events: listEvents(db, { target: ID }), workflowMode: "manual" as const }],
  agents: [], reviewers: [], held: [], ownerInbox: [] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdn-"));
  path = join(dir, "ledger.sqlite"); db = openLedger(path); statePath = join(dir, "state.json");
  setMeta(db, ctx(0), { project: P, key: "pms", value: [PM] });
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
    expect(kinds()).toEqual(["notify", "pm"]);
    expect(sends[1]!.text).toStartWith(`【升级】人工卡 ${ID}`);
    await at(T0 + 39 * MIN, tick);
    expect(cards).toEqual([]);
    await at(T0 + 40 * MIN, tick);
    expect(cards).toEqual([expect.objectContaining({ project: P, taskId: ID, dedupKey: `manual-deliver:${mdnKey(P, ID, d.seq)}#${T0 + 40 * MIN}` })]);
    expect(cards[0]!.context).toContain(`PM ${PM}`);
    await at(T0 + 80 * MIN, ticker()); // 换一个 ticker（bridge 重启）：状态在文件里，不重推
    expect([sends.length, cards.length, closed]).toEqual([2, 1, []]);
    dispatched(T0 + 81 * MIN);
    await at(T0 + 82 * MIN, tick);
    expect(closed).toEqual([cards[0]!.dedupKey]);
    expect(readMdnState(statePath).state[mdnKey(P, ID, d.seq)]!.resolvedAt).toBe(T0 + 82 * MIN);
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
    expect(kinds()).toEqual(["notify", "pm"]);
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
    expect(kinds()).toEqual(["pm"]);
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
    expect(kinds()).toEqual([]); // 超过 N 才第一次看到，通知也不补
    await at(T0 + 35 * MIN);
    expect(cards).toHaveLength(1);
  });
});

describe("巡检 manual_deliver_no_review 用同一套阈值和去重", () => {
  const audit = (now: number, pms = [PM, DISP]) => auditLedger(snapOf(pms), now, observe);
  const found = (now: number, pms?: string[]) => audit(now, pms).findings.filter((f) => f.rule === "manual_deliver_no_review");

  test("满 N 分钟（≥）起推卡的 PM；bridge 已升级过 → keep 不推", () => {
    deliveredCard();
    setMdnAuditPort({ config: () => ({ pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }), pushedAt: () => null });
    expect(found(T0 + 10 * MIN - 1)).toEqual([]);
    expect(found(T0 + 10 * MIN)).toEqual([expect.objectContaining({ notify: PM })]);
    setMdnAuditPort({ config: () => ({ pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }), pushedAt: () => T0 + 10 * MIN });
    const r = audit(T0 + 11 * MIN);
    expect(r.findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([]);
    expect(r.keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
  });

  test("巡检读的就是 bridge 写的状态文件", async () => {
    deliveredCard();
    await at(T0 + 10 * MIN);
    const state = readMdnState(statePath).state;
    setMdnAuditPort({ pushedAt: (k) => state[k]?.pm ?? null });
    expect(audit(T0 + 11 * MIN).keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
  });

  test("P2-3 没开班子、名单第一个名字带 dispatch：通知和巡检都给 PM，不给调度助理", async () => {
    setMeta(db, ctx(0), { project: P, key: "pms", value: ["agent-x-dispatch", PM] });
    deliveredCard();
    await at(T0 + MIN);
    expect(sends.map((s) => s.to)).toEqual([PM]);
    setMdnAuditPort({ config: () => ({ pmAfterMs: 10 * MIN, ownerAfterMs: 30 * MIN }), pushedAt: () => null });
    expect(found(T0 + 10 * MIN, ["agent-x-dispatch", PM])).toEqual([expect.objectContaining({ notify: PM })]);
  });
});

describe("审查回归（RVF-2 r1）", () => {
  test("P1-1 首次运行（状态文件不在）：上线时在等的交付照常升级、进 owner，巡检不被压住", async () => {
    const d = deliveredCard();
    await at(T0 + 30 * MIN);
    expect(kinds()).toEqual(["pm"]); // 至少一条提醒
    expect(readMdnState(statePath).state[mdnKey(P, ID, d.seq)]!.pm).toBe(T0 + 30 * MIN); // 巡检读到的 pm 是真送到的时刻
    await at(T0 + 60 * MIN);
    expect(cards).toHaveLength(1);
  });

  test("P1-2 review → blocked → review：回来后开的 owner 卡，派审后自动关", async () => {
    deliveredCard();
    const tick = ticker();
    await at(T0 + MIN, tick);
    await at(T0 + 10 * MIN, tick);
    moveStage(db, ctx(T0 + 11 * MIN, PM), { taskId: ID, from: "review", to: "blocked" });
    await at(T0 + 12 * MIN, tick);
    moveStage(db, ctx(T0 + 13 * MIN, PM), { taskId: ID, from: "blocked", to: "review" });
    await at(T0 + 41 * MIN, tick);
    expect(cards).toHaveLength(1);
    dispatched(T0 + 50 * MIN);
    await at(T0 + 51 * MIN, tick);
    expect(closed).toEqual([cards[0]!.dedupKey]);
    expect(kinds()).toEqual(["notify", "pm"]); // 回来后不重发通知 / 升级
  });

  test("P1-2 owner 卡开了之后交回 auto 又退回人工：旧卡关掉，到点开新卡（不同 dedupKey），派审后也关", async () => {
    deliveredCard();
    const tick = ticker();
    for (const m of [1, 10, 40]) await at(T0 + m * MIN, tick);
    db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = ?").run(ID);
    await at(T0 + 41 * MIN, tick);
    expect(closed).toEqual([cards[0]!.dedupKey]);
    db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = ?").run(ID);
    await at(T0 + 42 * MIN, tick);
    expect(cards).toHaveLength(2);
    expect(cards[1]!.dedupKey).not.toBe(cards[0]!.dedupKey);
    dispatched(T0 + 43 * MIN);
    await at(T0 + 44 * MIN, tick);
    expect(closed).toEqual([cards[0]!.dedupKey, cards[1]!.dedupKey]);
  });

  test("P1-3 PM 投递不出去：每轮重试升级，第一次没送到满 M 分钟照样进 owner，卡上写明没送到", async () => {
    deliveredCard();
    const tick = ticker({ send: async (to, text, id) => (sends.push({ to, text, id }), { handed: false, note: "agent-pm 不在 registry（或不活跃），没投" }) });
    for (const m of [1, 10, 11, 39]) await at(T0 + m * MIN, tick);
    expect(cards).toEqual([]);
    await at(T0 + 40 * MIN, tick);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.context).toContain("升级提醒当时没送到 PM（agent-pm 不在 registry");
    const n = sends.length;
    await at(T0 + 50 * MIN, tick);
    expect(sends).toHaveLength(n); // 开了 owner 就不再重试升级
  });

  test("P2-1 巡检押着（queuedAs，notifiedAt 还空）也算推过", async () => {
    const d = deliveredCard();
    db.query(`INSERT INTO audit_findings (key, project, taskId, rule, firstSeen, lastSeen, since, notify, queuedAs, changedAt)
      VALUES (?, ?, ?, 'manual_deliver_no_review', 0, ?, 0, ?, 'msg_1', 0)`).run(`${P}|manual_deliver_no_review|${ID}|${d.seq}`, P, ID, T0 + 10 * MIN, PM);
    await at(T0 + 10 * MIN);
    expect(kinds()).toEqual([]);
    expect(readMdnState(statePath).state[mdnKey(P, ID, d.seq)]!.pm).toBe(T0 + 10 * MIN);
  });

  test("P2-1 提醒与巡检串行：后来的等前一个做完才开始；前一个抛错不卡住后面", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = serialMdn(() => new Promise<void>((r) => { order.push("a-start"); release = () => { order.push("a-end"); r(); }; }));
    const second = serialMdn(async () => void order.push("b"));
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    await expect(serialMdn(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await serialMdn(async () => 1)).toBe(1);
  });

  test("P2-2 一张卡开 owner 卡抛错：别的卡照常；已投的步骤已落盘，不每分钟重推", async () => {
    deliveredCard("manual", EXE, "A1");
    deliveredCard("manual", EXE, "B1");
    const tick = ticker({ openOwnerCard: (c) => { if (c.taskId === "A1") throw new Error("busy"); cards.push(c); return "ask_b"; } });
    for (const m of [1, 10, 40, 41, 42]) await at(T0 + m * MIN, tick);
    expect(cards.map((c) => c.taskId)).toEqual(["B1"]);
    expect(kinds()).toEqual(["notify", "notify", "pm", "pm"]);
  });

  test("P2-2 状态写不下（写盘失败）：先记再投，一条都不发、不重复", async () => {
    deliveredCard();
    statePath = join(dir, "state-dir");
    mkdirSync(statePath);
    for (const m of [1, 2, 3, 10]) await at(T0 + m * MIN);
    expect(sends).toEqual([]);
  });

  test("P2-4a 撤销满 7 天的记录又回到等审：不被清掉，接着用", async () => {
    const d = deliveredCard();
    const key = mdnKey(P, ID, d.seq);
    writeFileSync(statePath, JSON.stringify({ [key]: { deliverTs: T0, notified: T0, pm: T0 + 10 * MIN, resolvedAt: T0 + 11 * MIN } }));
    await at(T0 + 8 * 24 * 60 * MIN);
    const rec = readMdnState(statePath).state[key]!;
    expect(rec.resolvedAt).toBeUndefined();
    expect(rec.pm).toBe(T0 + 10 * MIN);
    expect(cards).toHaveLength(1);
  });

  test("P2-5 项目没有 PM：owner 卡不写「已给 PM 发过升级」", () => {
    const d = { seq: 1, ts: T0, actor: EXE, project: P, target: ID, kind: "deliver" as const, text: "", data: { round: 1 }, dedupKey: null };
    const t = ownerCardText({ id: ID, project: P }, d, null, { deliverTs: T0, pmFail: { at: T0, note: "项目没有 PM" } }, T0 + 40 * MIN, "m");
    expect(t.context).toContain("项目没有 PM");
    expect(t.context).not.toContain("已给 PM 发过升级");
  });
});
