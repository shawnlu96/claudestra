/** i28-TV1：中心共享台账 → 协作视图的形状（验收 1），以及不注入时走本机台账（验收 2）。 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { looksLikeId, stageOf, teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { localCollabSource } from "@/features/collab/team-source";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, type Transport } from "@/lib/api/shared-ledger";
import { setAppConfigForTest } from "@/lib/app-config";

const fx = generateTeamFixture();
const details = new Map(fx.details.map((d) => [d.feature.id, d]));

test("夹具是生产形状：20+ 节点、UUID 形式的 id、长依赖链", () => {
  const nodes = fx.details.flatMap((d) => d.dag.nodes);
  expect(nodes.length).toBeGreaterThanOrEqual(20);
  expect(fx.details.every((d) => looksLikeId(d.feature.id) && d.tasks.every((t) => looksLikeId(t.taskId)))).toBe(true);
  expect(Math.max(...nodes.map((n) => n.oneLine.length))).toBeGreaterThan(40);
});

test("feature 列表 / 详情 / 任务 → LedgerOverview：卡号 + 标题，没有一处拿 UUID 当标题或卡号", () => {
  const { ov, index } = teamOverview(fx.list, details, fx.now);
  expect(ov.items.map((i) => i.title)).toEqual(fx.list.features.map((f) => f.title));
  expect(ov.tasks.length).toBe(fx.details.reduce((n, d) => n + d.dag.nodes.length, 0));
  for (const t of ov.tasks) {
    expect(looksLikeId(t.id)).toBe(false);
    expect(looksLikeId(t.title)).toBe(false);
    expect(t.id).toMatch(/^i28-[A-Z]\d+$/);
  }
  const strings = JSON.stringify({ items: ov.items.map((i) => i.title), tasks: ov.tasks.map((t) => [t.id, t.title, t.extra?.goal ?? ""]) });
  for (const d of fx.details) for (const t of d.tasks) expect(strings).not.toContain(t.taskId);
  // 计划节点（没开卡）是规格阶段；绑了卡的用执行镜像的阶段
  const first = fx.details.find((d) => d.dag.nodes.some((n) => !d.dag.bindings.some((b) => b.nodeKey === n.key)))!;
  const unbound = first.dag.nodes.find((n) => !first.dag.bindings.some((b) => b.nodeKey === n.key))!;
  expect(ov.tasks.find((t) => t.id === unbound.key)!.stage).toBe("spec");
  expect(index.get(unbound.key)).toEqual({ featureId: first.feature.id, key: unbound.key, taskId: null });
  // 依赖边 = 节点 deps；前置没完成的进 blockedBy
  expect(ov.deps!.length).toBe(fx.details.reduce((n, d) => n + d.dag.nodes.reduce((m, x) => m + x.deps.length, 0), 0));
  const blocked = ov.tasks.find((t) => t.id === unbound.key)!;
  expect(blocked.blockedBy?.length ?? 0).toBeGreaterThan(0);
});

test("主场卡号像 UUID 时退回节点代号；没节点的执行镜像用 feature 标题编号，不显示 id", () => {
  const d = structuredClone(fx.details[0]!);
  d.tasks[0]!.sourceTaskId = d.tasks[0]!.taskId;
  d.tasks.push({ ...d.tasks[1]!, taskId: "11111111-2222-4333-a444-555555555555", sourceTaskId: "aaaaaaaabbbbbbbbccccccccdddddddd", specSummary: "孤立的执行镜像" });
  const { ov } = teamOverview({ ...fx.list, features: [d.feature] }, new Map([[d.feature.id, d]]), fx.now);
  const key = d.dag.bindings.find((b) => b.taskId === d.tasks[0]!.taskId)!.nodeKey;
  expect(ov.tasks.some((t) => t.id === key)).toBe(true);
  const loose = ov.tasks.find((t) => t.title === "孤立的执行镜像")!;
  expect(looksLikeId(loose.id)).toBe(false);
  expect(loose.id.startsWith(d.feature.title)).toBe(true);
});

test("任务详情：中心没有的事件 / 时间线留空（视图显示暂无），不编", () => {
  const team = teamOverview(fx.list, details, fx.now);
  const id = team.ov.tasks[0]!.id;
  expect(teamTaskDetail(team, id, fx.now)).toEqual({ task: team.ov.tasks[0]!, events: [], timeline: [], now: fx.now });
  expect(teamTaskDetail(team, "nope", fx.now)).toBeNull();
});

test("阶段：本地阶段原样，步骤名折到阶段，认不出的按开发", () => {
  expect(stageOf("review")).toBe("review");
  expect(stageOf("write")).toBe("build");
  expect(stageOf("???")).toBe("build");
});

test("团队数据源：读列表 + 每个 feature 详情，详情按水位复用；任务详情按卡号找", async () => {
  let detailReads = 0;
  const transport: Transport = {
    list: async () => fx.list,
    detail: async (id) => { detailReads++; return details.get(id)!; },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team-key", "label", 10);
  const ov = await src.overview(new AbortController().signal);
  expect(ov.tasks.length).toBeGreaterThanOrEqual(20);
  expect(detailReads).toBe(fx.details.length);
  await src.overview(new AbortController().signal);
  expect(detailReads).toBe(fx.details.length);
  expect((await src.task(ov.tasks[3]!.id, new AbortController().signal)).task.id).toBe(ov.tasks[3]!.id);
  // 轮询：连上先 onOpen；serverSeq 不变不发事件
  const ctrl = new AbortController(), events: string[] = [];
  let opened = 0;
  const done = src.follow({ signal: ctrl.signal, onOpen: () => opened++, onEvent: (e) => events.push(`${e.type}:${String(e.data.project)}`) });
  await Bun.sleep(40);
  src.poke();
  ctrl.abort();
  await done;
  expect(opened).toBe(1);
  expect(events).toEqual(["ledger:team-key"]);
});

const realFetch = globalThis.fetch;
const urls: string[] = [];
beforeAll(() => {
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "test" });
  globalThis.fetch = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ ok: true, exists: true, now: 1, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
      items: [], tasks: [], task: { id: "T1" }, events: [], timeline: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

test("不注入数据源 = 本机台账：同样的三条接口（总览、任务详情、/events）", async () => {
  const src = localCollabSource("proj");
  await src.overview(new AbortController().signal);
  await src.task("T1", new AbortController().signal);
  expect(urls[0]).toMatch(/\/api\/v1\/ledger\/proj\?dayStart=\d+$/);
  expect(urls[1]).toMatch(/\/api\/v1\/ledger\/proj\/tasks\/T1$/);
  const { followCollabEvents } = await import("@/lib/api/ledger");
  expect(src.follow).toBe(followCollabEvents);
});
