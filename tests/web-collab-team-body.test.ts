/** TEAMVIS7：中心正文 → 团队详情的 events / 审查 / 规格 / 参与者（纯模块），读取缓存与团队源接线。 */
import { expect, test } from "bun:test";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { reviewRows, type TaskDetail } from "@/features/collab/collab-detail-model";
import { hasReplay, replayFrames } from "@/features/collab/collab-replay";
import { bodyEvents, reviewOf, teamPeople } from "@/features/collab/team-body/team-body-model";
import { teamBodyReader } from "@/features/collab/team-body/team-body-source";
import type { LedgerEventView } from "@/features/collab/collab-model";
import { SharedLedgerSession, type Transport } from "@/lib/api/shared-ledger";
import { ApiError } from "@/lib/api/client";
import type { TeamBodyReadWire, TeamBodyRecordWire, TeamBodyTransport } from "@/lib/api/shared-ledger-team-body";

const fx = generateTeamFixture();
const details = new Map(fx.details.map((d) => [d.feature.id, d]));
const team = teamOverview(fx.list, details, fx.now);
const [cardId, at] = [...team.index].find(([, v]) => v.taskId)!;
const FID = at.featureId, TID = at.taskId!;
const SYNCED = fx.now - 5 * 60_000;
const REVIEW = "审查结论 changes · P0 0 / P1 1 / P2 0\n- [P1] edge-1：空列表时越界\n  复现：bun test x\n\n第二段说明";
const SPEC = "# 规格\n\n## 本卡做什么\n1. 第一条\n2. 第二条";

const rec = (kind: TeamBodyRecordWire["kind"], sourceKey: string, text: string, meta?: TeamBodyRecordWire["meta"]): TeamBodyRecordWire =>
  ({ featureId: FID, taskId: TID, kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: "d".repeat(64), ...(meta ? { meta } : {}) });
const read = (records: TeamBodyRecordWire[], syncedAt: number | null = SYNCED): TeamBodyReadWire =>
  ({ schemaVersion: 1, teamId: fx.team, projectId: fx.project, featureId: FID, taskId: TID, records, syncedAt, homeOnline: true });
/** 3 条事件 + 1 条审查 + 规格（两版，取新的）；故意乱序给，按 sourceKey 排 */
const BODY = read([rec("event", "14", "交付 PR #31"), rec("review", "15", REVIEW), rec("event", "9", "开工：先写测试"),
  rec("spec", "1", "旧规格"), rec("event", "12", "补了边界用例"), rec("spec", "2", SPEC)]);

test("复现测试:中心 3 条事件 + 1 条审查 + 规格 → 详情 events 3 条、审查全文、规格全文；不给正文时 events 为空（main 同输入）", () => {
  const before = teamTaskDetail(team, cardId, fx.now)!;
  expect(before.events).toEqual([]);
  expect(before.team).toBeUndefined();
  const d = teamTaskDetail(team, cardId, fx.now, { status: "ok", read: BODY }, null)!;
  expect(d.events.filter((e) => e.kind !== "review").map((e) => e.text)).toEqual(["开工：先写测试", "补了边界用例", "交付 PR #31"]);
  expect(d.events.map((e) => e.seq)).toEqual([9, 12, 14, 15]);
  const [rv] = reviewRows(d.events);
  expect(rv).toMatchObject({ verdict: "changes", p0: 0, p1: 1, p2: 0, text: "- [P1] edge-1：空列表时越界" });
  expect(rv!.full).toContain("复现：bun test x");
  expect(rv!.full).toContain("第二段说明");
  expect(d.team).toMatchObject({ status: "ok", syncedAt: SYNCED, specText: SPEC, stageDetail: false });
  // 没有时间的记录用同步时刻、标近似；没有种类当 note；不编阶段
  expect(d.events.every((e) => e.ts === SYNCED && e.data.approxTime === true && e.data.to === undefined)).toBe(true);
  expect(d.timeline).toEqual([]);
});

test("审查首行不是主场格式：整段当全文，不编结论", () => {
  expect(reviewOf("只有一句话")).toEqual({ data: {}, text: "只有一句话" });
  expect(reviewOf("审查结论 pass · P0 0 / P1 0 / P2 2").data).toEqual({ verdict: "pass", p0: 0, p1: 0, p2: 2 });
});

/** 同一夹具的本机事件：建任务 + 三次推进 + 交付 + 审查 */
const T0 = fx.now - 3 * 3600_000;
const LOCAL: LedgerEventView[] = [
  { seq: 3, ts: T0, actor: "agent-pm", target: cardId, kind: "stage", text: "开工", data: { from: "spec", to: "build" } },
  { seq: 5, ts: T0 + 600_000, actor: "agent-dev", target: cardId, kind: "deliver", text: "交付", data: {} },
  { seq: 6, ts: T0 + 700_000, actor: "agent-pm", target: cardId, kind: "stage", text: "送审", data: { from: "build", to: "review" } },
  { seq: 8, ts: T0 + 900_000, actor: "agent-rv", target: cardId, kind: "review", text: "要改", data: { verdict: "changes", p0: 0, p1: 1, p2: 0 } },
  { seq: 9, ts: T0 + 950_000, actor: "agent-pm", target: cardId, kind: "stage", text: "退回", data: { from: "review", to: "fix" } },
];

test("复现测试:回放（带 kind / ts / stageTo）团队侧阶段序列与本机侧同一夹具一致", () => {
  const records = LOCAL.map((e) => e.kind === "review"
    ? rec("review", String(e.seq), `审查结论 changes · P0 0 / P1 1 / P2 0\n${e.text}`, { ts: e.ts })
    : rec("event", String(e.seq), e.text, { kind: e.kind, ts: e.ts, ...(e.kind === "stage" ? { stageTo: e.data.to } : {}) }));
  const d = teamTaskDetail(team, cardId, fx.now, { status: "ok", read: read(records.reverse()) }, null)!;
  expect(d.team!.stageDetail).toBe(true);
  expect(hasReplay(d.events)).toBe(true);
  const stages = (ev: readonly LedgerEventView[]) => replayFrames(ev).map((f) => [f.seq, f.ts, f.kind, f.stage]);
  expect(stages(d.events)).toEqual(stages(LOCAL));
  expect(d.timeline.map((t) => t.stage)).toEqual(["build", "review", "fix"]);
});

test("回放（现行契约，不带三字段）：不出播放器，事件按 sourceKey 顺序，没有编出来的阶段", () => {
  const d = teamTaskDetail(team, cardId, fx.now, { status: "ok", read: read(LOCAL.map((e) => rec("event", String(e.seq), e.text)).reverse()) }, null)!;
  expect(hasReplay(d.events)).toBe(false);
  expect(d.team!.stageDetail).toBe(false);
  expect(d.events.map((e) => e.seq)).toEqual([3, 5, 6, 8, 9]);
  expect(d.events.every((e) => e.kind === "note" && e.data.to === undefined)).toBe(true);
});

test("正文为空 → 正文同步中；读不到时没有原文，只有作者（团队卡事实）", () => {
  expect(teamTaskDetail(team, cardId, fx.now, { status: "ok", read: read([], null) }, null)!.team).toMatchObject({ status: "syncing", syncedAt: null });
  for (const status of ["not_member", "unsupported", "unavailable"] as const) {
    const d = teamTaskDetail(team, cardId, fx.now, { status }, null)!;
    expect(d.events).toEqual([]);
    expect(d.team).toMatchObject({ status, specText: null });
  }
});

test("参与者：作者 / 审查员 / PM 三类；本机实例写本机，其他写其他成员的机器，实例 id 不当名字", () => {
  const facts = { assigneeCode: "peer-1a2b", executorInstanceId: "a".repeat(32), head: null, blockingAsks: 0, mirror: null, freshUntil: null, observedAt: null };
  expect(teamPeople({ team: facts }, "a".repeat(32))).toEqual([
    { role: "executor", name: "peer-1a2b", machine: "local", instance: "a".repeat(32) },
    { role: "reviewer", name: null, machine: null, instance: null },
    { role: "pm", name: null, machine: null, instance: null },
  ]);
  expect(teamPeople({ team: facts }, "b".repeat(32))[0]!.machine).toBe("other");
  expect(teamPeople({ team: { ...facts, assigneeCode: `peer-${"c".repeat(20)}` } }, null)[0]!.name).toBeNull();
  expect(teamPeople({}, null)[0]).toEqual({ role: "executor", name: null, machine: null, instance: null });
});

const apiError = (status: number, body: Record<string, unknown> = {}) => new ApiError(`http ${status}`, status, body);

test("复现测试:读取缓存：403 → 非成员并清空缓存；离线回退缓存；无能力位 → 中心暂未开放", async () => {
  let answer: () => Promise<TeamBodyReadWire> = async () => BODY;
  const reader = teamBodyReader(() => ({ read: () => answer() }));
  const signal = new AbortController().signal;
  expect((await reader.load(FID, TID, signal)).status).toBe("ok");
  expect(reader.cached()).toBe(1);
  answer = async () => { throw apiError(503); };
  expect(await reader.load(FID, TID, signal)).toEqual({ status: "ok", read: BODY });
  expect(await reader.load(FID, "other-task", signal)).toEqual({ status: "unavailable" });
  answer = async () => { throw apiError(404, { code: "unsupported" }); };
  expect(await reader.load(FID, TID, signal)).toEqual({ status: "unsupported" });
  answer = async () => { throw apiError(409, { code: "not_open" }); };
  expect(await reader.load(FID, TID, signal)).toEqual({ status: "unsupported" });
  answer = async () => { throw apiError(403, { code: "not_member" }); };
  expect(await reader.load(FID, TID, signal)).toEqual({ status: "not_member" });
  expect(reader.cached()).toBe(0);
  answer = async () => { throw apiError(503); };
  expect(await reader.load(FID, TID, signal)).toEqual({ status: "unavailable" });
});

test("团队源接线：非主场卡读正文，homeOnly 只剩打开会话 / 对它说；计划节点不读", async () => {
  const transport: Transport = { list: async () => fx.list, detail: async (id) => details.get(id)!,
    command: async () => { throw new Error("no"); }, receipt: async () => { throw new Error("no"); } };
  const asked: string[] = [];
  const body: TeamBodyTransport = { read: async (f, t) => { asked.push(`${f}/${t}`); return BODY; } };
  const session = new SharedLedgerSession({ center: "c", team: fx.team, person: "p", project: fx.project, machine: "local" }, transport);
  const src = sharedCollabSource(session, "team-key", "团队", 5_000, { body });
  const d: TaskDetail = await src.task(cardId, new AbortController().signal);
  expect(asked).toEqual([`${FID}/${TID}`]);
  expect(d.events).toHaveLength(4);
  expect([...src.homeOnlyOf!(d)!].sort()).toEqual(["say", "sessions"]);
  const planned = [...team.index].find(([, v]) => !v.taskId)![0];
  const p = await src.task(planned, new AbortController().signal);
  expect(asked).toHaveLength(1);
  expect(p.team!.status).toBe("syncing");
});

test("bodyEvents 只收 event / review，按 seq 排", () => {
  const r = read([rec("spec", "3", "s"), rec("review", "2", "r"), rec("event", "1", "e")]);
  expect(bodyEvents(r, "X", 1).map((e) => [e.seq, e.kind])).toEqual([[1, "note"], [2, "review"]]);
});
