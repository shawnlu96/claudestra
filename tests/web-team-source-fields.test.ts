/**
 * team-parity-B（docs/team/team-collab-parity-plan.md §5.1 P1-B）：读口已经给的字段不再被适配层丢掉。
 * 旧红新绿：main 上 assigneeCode / executorInstanceId / head / asks / steps 全被丢、边的建立者 / 时间是 feature 的
 * updatedBy / updatedAt；修完原值进 LedgerTaskView.team、steps 进 stepLine、边三项为 null。纯数据，不碰网络。
 */
import { expect, test } from "bun:test";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { parseStepId, teamStepLine, UNKNOWN_EXECUTOR } from "@/features/collab/team-source-steps";
import { stepLineView } from "@/features/collab/collab-step-line-model";
import { homeView, lineOf, teamNote } from "@/features/collab/collab-model";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, type FeatureDetail, type FeatureList, type TaskProjection } from "@/lib/api/shared-ledger";

const fx = generateTeamFixture();
const one = (d: FeatureDetail, now = fx.now) => teamOverview({ ...fx.list, features: [d.feature] }, new Map([[d.feature.id, d]]), now);
const withTask = (patch: Partial<TaskProjection>) => {
  const d = structuredClone(fx.details[0]!);
  const t = d.tasks.find((x) => x.stage === "review")!;
  Object.assign(t, patch);
  return { d, key: t.sourceTaskId };
};

test("复现测试：assigneeCode / executorInstanceId / head 原值保留在 team 里，agent 仍是 null（不当本机会话）", () => {
  const { d, key } = withTask({ assigneeCode: "worker-a", executorInstanceId: "11111111-2222-4333-a444-555555555555", head: "0123456789abcdef0123456789abcdef01234567" });
  const t = one(d).ov.tasks.find((x) => x.id === key)!;
  expect(t.team).toMatchObject({ assigneeCode: "worker-a", executorInstanceId: "11111111-2222-4333-a444-555555555555", head: "0123456789abcdef0123456789abcdef01234567" });
  expect(t.agent).toBeNull();
  expect(t.extra?.delegate).toBeUndefined();
  // 列表线也不把代号当执行者 / 委托人（「对它说」「打开会话」都靠 agent）
  const line = lineOf(t, one(d).ov, new Map(), fx.now);
  expect(line.agent).toBeNull();
  expect(line.delegate).toBeNull();
});

test("复现测试：没有代号 / head / 实例的给 null，不编空串；计划节点没有 team", () => {
  const { d, key } = withTask({ assigneeCode: null, executorInstanceId: null, head: null });
  const ov = one(d).ov;
  expect(ov.tasks.find((x) => x.id === key)!.team).toMatchObject({ assigneeCode: null, executorInstanceId: null, head: null });
  const unbound = d.dag.nodes.find((n) => !d.dag.bindings.some((b) => b.nodeKey === n.key));
  if (unbound) expect(ov.tasks.find((x) => x.id === unbound.key)!.team).toBeUndefined();
});

test("复现测试：阻塞提问只数 blocking 且开着的；没有提问是真 0，不是未知", () => {
  const { d, key } = withTask({ asks: [
    { kind: "question", state: "open", blocking: true }, { kind: "question", state: "open", blocking: true },
    { kind: "question", state: "answered", blocking: true }, { kind: "note", state: "open", blocking: false }] });
  expect(one(d).ov.tasks.find((x) => x.id === key)!.team!.blockingAsks).toBe(2);
  const none = withTask({ asks: [] });
  expect(one(none.d).ov.tasks.find((x) => x.id === none.key)!.team!.blockingAsks).toBe(0);
});

test("复现测试：镜像状态按实际显示的详情 + stale()：过期 / 最新 / 没有镜像 = null（不补成最新）", () => {
  const d = structuredClone(fx.details[0]!);
  const key = d.tasks[0]!.sourceTaskId;
  const at = d.feature.projection!.observedAt, until = at + 10 * 60_000;
  expect(one(d).ov.tasks.find((x) => x.id === key)!.team).toMatchObject({ mirror: "fresh", freshUntil: until, observedAt: at });
  expect(one(d).ov.mirror).toEqual([{ mirror: "fresh", freshUntil: until, observedAt: at }]);
  expect(one(d, fx.now + 11 * 60_000).ov.tasks.find((x) => x.id === key)!.team).toMatchObject({ mirror: "stale", freshUntil: null, observedAt: at });
  expect(one(d, fx.now + 11 * 60_000).ov.mirror).toEqual([{ mirror: "stale", freshUntil: null, observedAt: at }]);
  d.feature.projection = null;
  expect(one(d).ov.tasks.find((x) => x.id === key)!.team).toMatchObject({ mirror: null, freshUntil: null, observedAt: null });
  expect(one(d).ov.mirror).toEqual([{ mirror: null, freshUntil: null, observedAt: null }]);
});

/** 真实 SharedLedgerSession + sharedCollabSource，纯内存 Transport（每次给快照副本，不许写） */
function memSource(list: () => FeatureList, detail: (id: string) => FeatureDetail) {
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  return sharedCollabSource(new SharedLedgerSession(identity, {
    list: async () => structuredClone(list()),
    detail: async (id) => structuredClone(detail(id)),
    command: async () => { throw new Error("read only"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  }), "team", "label", 5);
}
const signal = new AbortController().signal;
async function withClock(start: number, run: (tick: (ms: number) => number) => Promise<void>) {
  const real = Date.now;
  let clock = start;
  Date.now = () => clock;
  try { await run((ms) => (clock += ms)); } finally { Date.now = real; }
}

test("复现测试：镜像越过 10 分钟过期阈值但 serverSeq 不变：follow 不发事件，列表线 / 详情按走表的 now 显示过期", async () => {
  await withClock(fx.now, async (tick) => {
    const d = fx.details[0]!;
    const list = { ...fx.list, features: [d.feature] };
    const src = memSource(() => list, () => d);
    const ov = await src.overview(signal);
    const key = d.tasks[0]!.sourceTaskId;
    expect(lineOf((await src.task(key, signal)).task, ov, new Map(), fx.now).reason).not.toContain("主场镜像过期");
    const now = tick(11 * 60_000);
    const ctrl = new AbortController(), events: unknown[] = [];
    const done = src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: (e) => events.push(e) });
    await Bun.sleep(40);
    ctrl.abort();
    await done;
    expect(events).toEqual([]); // 主场停了：没有新水位，不重拉
    const t = (await src.task(key, signal)).task;
    expect(lineOf(t, ov, new Map(), now).reason).toContain("主场 11 分钟前同步");
    expect(teamNote(t, now)).toContain("主场 11 分钟前同步");
  });
});

test("复现测试：新列表加旧详情缓存：读新详情失败回退旧卡时按旧详情自己的水位判过期，不借列表的新时间", async () => {
  await withClock(fx.now, async (tick) => {
    const d = fx.details[0]!;
    let list: FeatureList = { ...fx.list, features: [d.feature] };
    let fail = false;
    const src = memSource(() => list, () => { if (fail) throw new Error("synthetic detail failure"); return d; });
    const key = d.tasks[0]!.sourceTaskId;
    await src.overview(signal);
    expect((await src.task(key, signal)).task.team!.mirror).toBe("fresh");
    const warn = console.warn;
    console.warn = () => {};
    try {
      // ① 11 分钟后列表前进、详情读失败：旧卡本身已过期
      const now = tick(11 * 60_000);
      const p = d.feature.projection!;
      list = { ...list, serverSeq: list.serverSeq + 1, features: [{ ...d.feature, projection: { ...p, sourceSeq: p.sourceSeq + 1, observedAt: now } }] };
      fail = true;
      let ov = await src.overview(signal);
      expect(ov.tasks.find((t) => t.id === key)!.team!.mirror).toBe("stale");
      expect(ov.mirror).toEqual([{ mirror: "stale", freshUntil: null, observedAt: p.observedAt }]);
      expect(lineOf(ov.tasks.find((t) => t.id === key)!, ov, new Map(), now).reason).toContain("主场 11 分钟前同步");
      // ② 旧详情还在 10 分钟内，但中心列表的水位比它新：显示的不是中心现在的，也算过期
      fail = false;
      list = { ...list, serverSeq: list.serverSeq + 1, features: [{ ...d.feature, projection: { ...p, observedAt: now } }] };
      const fresh = structuredClone(d);
      fresh.feature.projection = { ...p, observedAt: now };
      const src2 = memSource(() => list, () => { if (fail) throw new Error("synthetic detail failure"); return fresh; });
      await src2.overview(signal);
      tick(5_000);
      fail = true;
      list = { ...list, serverSeq: list.serverSeq + 1, features: [{ ...d.feature, projection: { ...p, sourceSeq: p.sourceSeq + 1, observedAt: now + 5_000 } }] };
      ov = await src2.overview(signal);
      expect(ov.tasks.find((t) => t.id === key)!.team!.mirror).toBe("stale");
    } finally { console.warn = warn; }
  });
});

test("复现测试：reason 追加主场镜像过期 / 阻塞提问，不丢原来的出问题理由；本机卡 reason 不变", () => {
  const { d, key } = withTask({ stage: "fix", asks: [{ kind: "question", state: "open", blocking: true }] });
  const ov = one(d, fx.now + 11 * 60_000).ov;
  const t = ov.tasks.find((x) => x.id === key)!;
  // 读到时新鲜、显示时已过 10 分钟：同样报过期（走表的 now，不是读到时的判定）
  expect(teamNote(one(d).ov.tasks.find((x) => x.id === key)!, fx.now + 11 * 60_000)).toBe("主场 11 分钟前同步 · 主场有 1 个阻塞提问");
  expect(teamNote(t, fx.now + 11 * 60_000)).toBe("主场 11 分钟前同步 · 主场有 1 个阻塞提问");
  const withReview = { ...t, lastReview: { round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0, text: "P1：边页出 1970", ts: fx.now } };
  expect(lineOf(withReview, ov, new Map(), fx.now + 11 * 60_000).reason).toBe("P1：边页出 1970 · 主场 11 分钟前同步 · 主场有 1 个阻塞提问");
  const local = fx.local.tasks.find((x) => x.stage === "fix")!;
  expect(local.team).toBeUndefined();
  expect(lineOf({ ...local, lastReview: withReview.lastReview }, fx.local, new Map(), fx.now).reason).toBe("P1：边页出 1970");
  // 本机首页（同一份夹具）没有任何团队句子
  expect(JSON.stringify(homeView(fx.local, fx.now))).not.toMatch(/主场镜像|阻塞提问/);
});

test("复现测试：steps（step:round）→ stepLine：保留真实步骤与轮次，当前步按阶段，不编执行者 / head / 结论", () => {
  expect(parseStepId("write:2")).toEqual({ step: "write", round: 2 });
  expect(parseStepId("final_review:1")).toEqual({ step: "final_review", round: 1 });
  for (const bad of ["step-a", "write", "write:x", "coffee:1", "write:-1", ""]) expect(parseStepId(bad)).toBeNull();
  const steps = (ids: [string, string][]) => ids.map(([id, state]) => ({ sourceStepId: id, sourceRev: 1, sourceSeq: 1, state }));
  // 审查：初审 / 终审取轮次大的，同一轮终审优先（和主场 currentReview 同口径）
  expect(teamStepLine(steps([["write:1", "done"], ["review:1", "done"], ["review:2", "assigned"]]), "review")!.active).toEqual({ step: "review", round: 2 });
  expect(teamStepLine(steps([["review:2", "done"], ["final_review:2", "assigned"]]), "review")!.active).toEqual({ step: "final_review", round: 2 });
  // 返工没有修那一步就退到写；blocked 不知道 stageBefore = 没有当前步
  expect(teamStepLine(steps([["write:1", "done"]]), "fix")!.active).toEqual({ step: "write", round: 1 });
  expect(teamStepLine(steps([["write:1", "assigned"]]), "blocked")!.active).toBeNull();
  // 认不出的丢掉，一行都没有 = null（视图不画）
  expect(teamStepLine(steps([["step-a", "active"]]), "build")).toBeNull();
  expect(teamStepLine([], "build")).toBeNull();

  const line = teamStepLine(steps([["write:1", "done"], ["review:1", "done"], ["fix:1", "done"], ["review:2", "assigned"]]), "review")!;
  expect(line.steps.map((s) => `${s.step}:${s.round}:${s.state}`)).toEqual(["write:1:done", "review:1:done", "fix:1:done", "review:2:assigned"]);
  const v = stepLineView(line, "review")!;
  expect(v.current).toMatchObject({ key: "review", round: 2, state: "assigned", executor: UNKNOWN_EXECUTOR, heads: null, verdict: null, model: null, verified: null });
  expect(v.slots.find((s) => s.key === "fix")).toMatchObject({ filled: true, round: 1, state: "done", verdict: null });
  expect(v.slots.find((s) => s.key === "merge")!.filled).toBe(false);
});

test("复现测试：适配层把 steps 挂到卡和详情上；夹具里没有步骤的卡没有 stepLine", () => {
  const team = teamOverview(fx.list, new Map(fx.details.map((d) => [d.feature.id, d])), fx.now);
  const d = fx.details[0]!;
  const review = d.tasks.find((t) => t.stage === "review")!;
  const t = team.ov.tasks.find((x) => x.id === review.sourceTaskId)!;
  expect(t.stepLine).toEqual(teamStepLine(review.steps, "review"));
  expect(teamTaskDetail(team, t.id, fx.now)!.stepLine).toEqual(t.stepLine);
  const unbound = team.ov.tasks.find((x) => x.stage === "spec" && !x.team);
  if (unbound) expect(unbound.stepLine).toBeUndefined();
});

test("复现测试：边的建立者 / 时间是 null，不再是 feature 的 updatedBy / updatedAt", () => {
  const ov = one(fx.details[0]!).ov;
  expect(ov.deps!.length).toBeGreaterThan(0);
  for (const e of ov.deps!) {
    expect(e.createdBy).toBeNull();
    expect(e.createdAt).toBeNull();
    expect(e.updatedAt).toBeNull();
    expect(e.createdBy).not.toBe(fx.details[0]!.feature.updatedBy);
  }
  // 夹具的本地总览也是从规划推出来的，边同样没有建立者 / 时间
  expect(fx.local.deps!.every((e) => e.createdBy === null && e.createdAt === null && e.updatedAt === null)).toBe(true);
});
