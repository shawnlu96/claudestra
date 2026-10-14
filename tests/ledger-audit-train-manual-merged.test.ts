/**
 * dispatch-recovery-AUDTRAIN4：PM 私仓人工合入登记（`ledger manual-merge-record`，src/lib/ledger-manual-merge-record.ts）
 * 让巡检（ship_stalled，经 ledger-audit-train-facts.ts）认「当前 head 已合并、在等部署」，不再判成等合并槽。
 * 夹具是临时目录真台账库：合并意图 / 合并槽（scheduler_resources merge:p）/ 合并记录直接写，登记走真命令（runLedger），
 * 取数走真快照（collectAuditSnapshots），规则走真巡检入口（auditLedger），开关用注入的恢复策略 auditTrainQueue。
 * 「基线」= 同一份快照去掉列车事实再跑（off 的原路径）。merge_ready_idle 一侧在 ledger-audit-train-manual-merged-ready.test.ts。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import type { MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { readTrainFacts } from "../src/lib/ledger-audit-train-facts.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { baselineAudit } from "./ledger-test-helpers.js";

const MIN = 60_000, NOW = 100_000 * MIN, P = "p";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
const MERGE = "d".repeat(40), MAIN = "1".repeat(40), RECEIPT = "reviews/B-private-merge.md";
type Snap = AuditSnapshot & MergeTrainInputs;
const head = (id: string) => (id === "A" ? "a" : id === "B" ? "b" : id === "C" ? "c" : "e").repeat(40);
const prOf = (id: string) => `https://github.com/o/r/pull/${id.charCodeAt(0)}`;

let db: Database, dir: string, path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-train-manual-merged-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并槽 / 记录，意图只造用得上的列
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm", "agent-disp"] });
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "team", value: { dispatcher: "agent-disp", audit: true } });
  baselineAudit(db, P);
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

const sources = (over: Partial<SnapshotSources> = {}): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"), ...over,
});
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditTrainQueue" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 自动流程 code 卡，at 时刻进 merge（真 stage 事件 = 本次 mergeEntrySeq） */
function card(id: string, at: number): void {
  createTask(db, { actor: "owner", now: 0 }, { project: P, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm" });
  setWorkflow(db, { actor: "owner", now: 0 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(head(id), prOf(id), `feat/${id}`, id);
  insertEvent(db, { actor: "owner", now: at }, { project: P, target: id, kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
}
function intent(id: string, taskId: string, status: string): string {
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,?,'merge_deploy','merge',1,1,2,1,?,2,?,'seed',0,0)`).run(id, taskId, P, head(taskId), status);
  return id;
}
const slot = (taskId: string, intentId: string) => db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES (?,?,?,?,0)")
  .run(P, `merge:${P}`, taskId, intentId);
const journal = (intentId: string, taskId: string, phase: string, at: number) => db.query(`INSERT INTO scheduler_merges
  (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt) VALUES (?, ?, ?, 'pr', 'b', ?, 'ci', ?, ?, ?)`)
  .run(intentId, taskId, P, head(taskId), phase, at, at);
/** A 真实持项目合并槽（意图 submitted、记录 await_ci） */
const holdA = () => { slot("A", intent("m-A", "A", "submitted")); journal("m-A", "A", "await_ci", NOW - 40 * MIN); };

const deps = (actor: string, now: number) => ({ db, actor, projectIds: [P, "q"], loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => now });
const args = (id: string, over: Record<string, string | null>) => {
  const f: Record<string, string | null> = { head: head(id), "merge-sha": MERGE, pr: prOf(id), base: "main", "main-head": MAIN, receipt: RECEIPT, ...over };
  return ["manual-merge-record", id, ...Object.entries(f).flatMap(([k, v]) => (v === null ? [] : [`--${k}`, v]))];
};
/** 真命令登记 */
const record = (id = "B", over: Record<string, string | null> = {}, actor = "agent-pm", now = NOW - 30 * MIN) =>
  runLedger(args(id, over), deps(actor, now)) as Promise<{ ok: boolean; code?: string; error?: string; event?: number; duplicate?: boolean }>;
const manualEvents = () => db.query("SELECT seq, actor, project, target, kind, data FROM events WHERE json_extract(data, '$.op') = 'manual_merge_record' ORDER BY seq").all() as
  { seq: number; actor: string; project: string; target: string; kind: string; data: string }[];

const snapshot = async (now = NOW, src = sources()): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, src))[0] as Snap;
const ship = (s: Snap, mode: RecoveryMode) => {
  const r = auditLedger(s, NOW, policy(mode));
  return { findings: r.findings.filter((f) => f.rule === "ship_stalled"), keep: r.keep.filter((k) => k.includes("|ship_stalled|")) };
};
const of = (s: Snap, mode: RecoveryMode, id: string) => ship(s, mode).findings.find((f) => f.taskId === id)?.detail;
const base = (s: Snap, mode: RecoveryMode) => { const { mergeTrain: _m, trainFacts: _f, ...rest } = s; return auditLedger(rest, NOW, policy(mode)); };
const plain = (id: string, mins: number) => `${id} 在 merge 已 ${mins} 分钟 没推进`;
const WAIT_A = `（排队中：列车在合 A，await_ci）`;
const keyOf = (id: string, since: number) => `p|ship_stalled|${id}|merge|${since}`;

/** B 被判成等 A 的槽：observe 带标注、on 压掉并 keep 原 key */
const expectQueued = (s: Snap) => {
  expect(s.trainFacts?.cards.B?.merged).toBe(false);
  expect(of(s, "observe", "B")).toBe(`${plain("B", 40)}${WAIT_A}`);
  expect(ship(s, "on").keep).toEqual([keyOf("B", NOW - 40 * MIN)]);
};
/** B 已合并在等部署：observe / on 都按原规则报 B，三种模式与基线逐字一致 */
const expectMergedPlain = (s: Snap) => {
  expect(s.trainFacts?.cards.B?.merged).toBe(true);
  expect(of(s, "observe", "B")).toBe(plain("B", 40));
  expect(of(s, "on", "B")).toBe(plain("B", 40));
  expect(ship(s, "on").keep).toEqual([]);
  for (const mode of MODES) expect(auditLedger(s, NOW, policy(mode))).toEqual(base(s, mode));
};

describe("[验收线 1] 当前 head 人工合并等部署：A 真实持槽，B 留 merge、无 scheduler_merges merged", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    holdA();
  });
  test("登记前按 AUDTRAIN3 判等待；真命令登记后 observe 不标排队、on 不压 B 的发现", async () => {
    expectQueued(await snapshot());
    const r = await record();
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expectMergedPlain(await snapshot()); // 先红：旧实现只认 scheduler_merges，B 仍被标排队
  });
  test("B 自己为部署持槽（无合并记录）：登记后同样原规则", async () => {
    db.query("DELETE FROM scheduler_resources").run();
    slot("B", intent("m-B", "B", "submitted"));
    db.query("UPDATE scheduler_merges SET phase = 'ready' WHERE intentId = 'm-A'").run();
    await record();
    const s = await snapshot();
    expect(s.trainFacts?.holder).toMatchObject({ taskId: "B", merged: true });
    expect(s.trainFacts?.cards.B?.merged).toBe(true);
    for (const mode of ["observe", "on"] as const) expect(of(s, mode, "B")).toBe(plain("B", 40));
    expect(of(s, "observe", "A")).toBe(`${plain("A", 40)}（排队中：合并槽在 B，它已合并、在等部署）`); // A 自身 ready、真在等 B 的槽
    expect(ship(s, "on").keep).toEqual([keyOf("A", NOW - 40 * MIN)]);
    expect(auditLedger(s, NOW, policy("off"))).toEqual(base(s, "off"));
  });
});

describe("[验收线 2] 有效性边界：无效事实一律不豁免 B", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    holdA();
  });
  const entry = () => (db.query("SELECT MAX(seq) AS s FROM events WHERE target = 'B' AND kind = 'stage'").get() as { s: number }).s;
  /** 与真命令写出的同形（见验收线 4 的逐字断言）的有效 v1 事实 */
  const valid = (): Record<string, unknown> => ({ op: "manual_merge_record", v: 1, phase: "merged", head: head("B"), mergeSha: MERGE, pr: prOf("B"), base: "main",
    mainHead: MAIN, specRev: 1, round: 1, mergeEntrySeq: entry(), receipt: RECEIPT });
  const put = (data: Record<string, unknown>, over: { kind?: "scheduler" | "note"; project?: string } = {}) =>
    insertEvent(db, { actor: "agent-pm", now: NOW - 30 * MIN }, { project: over.project ?? P, target: "B", kind: over.kind ?? "scheduler", text: "", data }, false);
  /** 有效事实改一项（或换 kind / project）直接写进库：B 仍等 A 的槽 */
  const forged = async (mutate: (d: Record<string, unknown>) => void, over: { kind?: "scheduler" | "note"; project?: string } = {}) => {
    const data = valid();
    mutate(data);
    put(data, over);
    expectQueued(await snapshot());
  };
  const cases: [string, (d: Record<string, unknown>) => void][] = [
    ["旧 head", (d) => { d.head = "9".repeat(40); }],
    ["不同 PR", (d) => { d.pr = "https://github.com/o/r/pull/999"; }],
    ["不同 specRev", (d) => { d.specRev = 2; }],
    ["不同 round", (d) => { d.round = 2; }],
    ["旧 mergeEntrySeq", (d) => { d.mergeEntrySeq = (d.mergeEntrySeq as number) - 1; }],
    ["resolved", (d) => { d.phase = "resolved"; }],
    ["未知版本", (d) => { d.v = 2; }],
    ["base 不是 main", (d) => { d.base = "dev"; }],
    ...(["mergeSha", "mainHead", "receipt", "head", "pr", "mergeEntrySeq", "v", "phase"] as const).map((k): [string, (d: Record<string, unknown>) => void] =>
      [`缺 ${k}`, (d) => { delete d[k]; }]),
  ];
  for (const [name, mutate] of cases) test(name, () => forged(mutate));
  test("普通 note（同样的 data）", () => forged(() => {}, { kind: "note" }));
  test("其他项目", () => forged(() => {}, { project: "q" }));
  test("卡换了新 head：登记时的 head 成了旧 head", async () => {
    await record();
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'B'").run("9".repeat(40));
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(false);
  });
  test("上一次 merge 的登记：卡退回再进 merge 后不再算", async () => {
    await record();
    insertEvent(db, { actor: "owner", now: NOW - 20 * MIN }, { project: P, target: "B", kind: "stage", text: "", data: { from: "merge", to: "fix" } }, false);
    insertEvent(db, { actor: "owner", now: NOW - 20 * MIN }, { project: P, target: "B", kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
    expect(readTrainFacts(db, P)?.cards.B?.merged).toBe(false);
  });
  test("事件写在本次进入 merge 之前（seq 比入口小，mergeEntrySeq 却指向之后的入口）不算", async () => {
    const data = { ...valid(), mergeEntrySeq: entry() + 2 }; // 本事件 = +1，下一条入口 = +2
    put(data);
    insertEvent(db, { actor: "owner", now: NOW - 20 * MIN }, { project: P, target: "B", kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
    expect(entry()).toBe(data.mergeEntrySeq);
    expect(readTrainFacts(db, P)?.cards.B?.merged).toBe(false);
  });
  test("对照：同一输入不改任何一项 = 有效（直接写与真命令都认）", async () => {
    put(valid());
    expectMergedPlain(await snapshot());
  });
});

describe("[验收线 2] B 是持槽者且有效登记：未合并的 C 仍等待，说明写 B 已合并等部署", () => {
  test("B 自身不标；C observe 标排队（合并槽在 B，它已合并、在等部署）、on 压掉 C", async () => {
    card("B", NOW - 40 * MIN);
    card("C", NOW - 40 * MIN);
    slot("B", intent("m-B", "B", "submitted"));
    const before = await snapshot();
    expect(of(before, "observe", "C")).toBe(`${plain("C", 40)}（排队中：列车在合 B，未开始合并）`);
    await record();
    const s = await snapshot();
    expect(of(s, "observe", "B")).toBe(plain("B", 40));
    expect(of(s, "observe", "C")).toBe(`${plain("C", 40)}（排队中：合并槽在 B，它已合并、在等部署）`); // 先红：旧实现写「列车在合 B」
    expect(ship(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "B" })], keep: [keyOf("C", NOW - 40 * MIN)] });
    expect(db.query("SELECT taskId FROM scheduler_resources").all()).toEqual([{ taskId: "B" }]); // 槽不释放
  });
});

describe("[验收线 3] 提交边界：用外部读取的 await 控制顺序，不靠 sleep", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    holdA();
  });
  test("最终事实读取前提交（注入在外部读取的 await 里）：本轮立即认", async () => {
    let fired = 0;
    const s = await snapshot(NOW, sources({ mergeCi: async () => { expect((await record()).ok).toBe(true); fired++; return {}; } }));
    expect(fired).toBe(1);
    expectMergedPlain(s);
  });
  test("读取完成后才提交：旧快照保留等待结论，下一轮纠正", async () => {
    const old = await snapshot();
    await record();
    expectQueued(old);
    expectMergedPlain(await snapshot());
  });
});

describe("[验收线 4] 真入口：拒绝与成功的写入边界", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    holdA();
  });
  const state = () => Object.fromEntries(["tasks", "task_workflows", "scheduler_intents", "scheduler_resources", "scheduler_merges", "scheduler_sessions", "task_steps"]
    .map((t) => [t, db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const events = () => (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  const refused = async (code: string, ...a: Parameters<typeof record>) => {
    const before = { state: state(), events: events() };
    const r = await record(...a);
    expect(r).toMatchObject({ ok: false, code });
    expect({ state: state(), events: events() }).toEqual(before);
  };
  test("越权：执行者 / 调度助理 / 调度服务身份 / 别项目 PM", async () => {
    await refused("forbidden", "B", {}, "agent-x");
    await refused("forbidden", "B", {}, "agent-disp");
    await refused("forbidden", "B", {}, "scheduler");
    await refused("forbidden", "B", {}, "agent-other-pm");
  });
  test("非 merge 阶段", async () => {
    db.query("UPDATE tasks SET stage = 'live' WHERE id = 'B'").run();
    await refused("conflict");
  });
  test("错 head / 错 PR / 非完整 PR 链接 / base 不是 main", async () => {
    await refused("conflict", "B", { head: "9".repeat(40) });
    await refused("conflict", "B", { pr: "https://github.com/o/r/pull/7" });
    await refused("invalid", "B", { pr: "o/r#66" });
    await refused("invalid", "B", { base: "master" });
  });
  test("非法 SHA", async () => {
    for (const k of ["head", "merge-sha", "main-head"]) await refused("invalid", "B", { [k]: "abc123" });
    await refused("invalid", "B", { "merge-sha": "g".repeat(40) });
  });
  test("缺证据 / 缺字段", async () => {
    await refused("invalid", "B", { receipt: null });
    await refused("invalid", "B", { receipt: "   " });
    await refused("invalid", "B", { "main-head": null });
  });
  test("成功只新增约定事件；同证据重放不重复；身份字段冲突拒绝；任务 / 工作流 / 锁 / 资源不变", async () => {
    const before = state(), n = events();
    const r = await record();
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(state()).toEqual(before);
    expect(events()).toBe(n + 1);
    const entry = (db.query("SELECT MAX(seq) AS s FROM events WHERE target = 'B' AND kind = 'stage'").get() as { s: number }).s;
    const [ev] = manualEvents();
    expect({ ...ev!, data: JSON.parse(ev!.data) }).toEqual({ seq: r.event!, actor: "agent-pm", project: P, target: "B", kind: "scheduler", data: {
      op: "manual_merge_record", v: 1, phase: "merged", head: head("B"), mergeSha: MERGE, pr: prOf("B"), base: "main", mainHead: MAIN,
      specRev: 1, round: 1, mergeEntrySeq: entry, receipt: RECEIPT } });
    expect(await record("B", {}, "owner", NOW)).toMatchObject({ ok: true, duplicate: true, event: r.event });
    await refused("conflict", "B", { "merge-sha": "e".repeat(40) });
    await refused("conflict", "B", { "main-head": "2".repeat(40) });
    await refused("conflict", "B", { receipt: "reviews/other.md" });
    expect(manualEvents()).toHaveLength(1);
    expect(state()).toEqual(before);
  });
  test("master / owner 可登记", async () => {
    expect(await record("B", {}, "master")).toMatchObject({ ok: true });
    expect(await record("A", {}, "owner")).toMatchObject({ ok: true });
  });
});

describe("[验收线 4] 共存与降级", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    holdA();
  });
  test("无有效新事实：完整输出与 AUDTRAIN3 一致（off 与基线逐字一致，observe 只多排队标注）", async () => {
    const s = await snapshot();
    expect(auditLedger(s, NOW, policy("off"))).toEqual(base(s, "off"));
    expectQueued(s);
  });
  test("原 scheduler merged 口径不变：只有 scheduler_merges merged 也认", async () => {
    journal("m-B", "B", "merged", NOW - 35 * MIN);
    expectMergedPlain(await snapshot());
  });
  test("events 表缺失 / 登记事件数据读不了：事实整体 undefined（不当成没登记），快照没带事实时 observe / on 按 off", async () => {
    const s = await snapshot();
    db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-pm', ?, 'B', 'scheduler', '', '{broken')").run(NOW, P);
    expect(readTrainFacts(db, P)).toBeUndefined();
    const { trainFacts: _drop, ...rest } = s;
    const off = auditLedger(rest, NOW, policy("off"));
    for (const mode of ["observe", "on"] as const) expect(auditLedger(rest, NOW, policy(mode))).toEqual(off);
    db.run("ALTER TABLE events RENAME TO events_gone");
    expect(readTrainFacts(db, P)).toBeUndefined();
  });
});
