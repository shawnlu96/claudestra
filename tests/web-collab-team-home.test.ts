/**
 * team-project-TEAMVIS0：团队视图里卡所在 feature 的主场实例就是本机（团队键 homeInstanceId = feature.homeInstanceId）时，
 * 详情直接读本机台账（GET /ledger/<本机项目>/tasks/<主场卡号>），homeOnly 为空集；主场是别的机器或键里没有 homeInstanceId 时与 main 逐字一致。
 * 旧红新绿：main 上同一夹具（主场 = 本机）详情 events 为空、homeOnly 全集（界面「仅主场可见」）。
 * fetch 全部拦在本文件，只回环夹具；纯模块，不挂 React（界面按 homeOnlyOf 取值，见 collab-detail.tsx）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { homeCardOf, sharedCollabSource } from "@/features/collab/team-source-shared";
import { sharedCollabProject } from "@/features/collab/team-source-key";
import { setAppConfigForTest } from "@/lib/app-config";
import { SharedLedgerSession, type FeatureDetail, type FeatureList, type Identity, type Transport } from "@/lib/api/shared-ledger";
import type { LedgerEventView, LedgerTaskView } from "@/features/collab/collab-model";
import type { TaskDetail } from "@/features/collab/collab-detail-model";

const PROJECT = "home-proj", HOME = "home-1", NOW = 1_800_000_000_000, MIN = 60_000;
const BASE: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local" };
const ALL: string[] = ["events.text", "review.text", "sessions", "say", "spec.full", "replay"];

const localTask = (id: string, stage: LedgerTaskView["stage"], agent: string | null): LedgerTaskView =>
  ({ id, itemId: "item-1", title: `本机 ${id}`, kind: "code", stage, round: 1, agent, pm: "agent-pm", updatedAt: NOW, metrics: { totalMs: 30 * MIN } });

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, text = "", actor = "agent-dev"): LedgerEventView =>
  ({ seq: ++seq, ts: NOW - 30 * MIN + seq * MIN, actor, target: "R1", kind, text, data });

/** 本机台账里同一张卡的完整详情：事件、审查、会话、执行者都有 */
const LOCAL: TaskDetail = {
  task: localTask("R1", "review", "agent-dev"), now: NOW, timeline: [],
  events: [
    ev("task", { op: "new", patch: { stage: "spec" }, rev: 1 }, "建卡", "agent-pm"),
    ev("stage", { from: "spec", to: "build" }),
    ev("deliver", { headSHA: "0b7b79c1234" }),
    ev("stage", { from: "build", to: "review" }),
    ev("review", { round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0, reviewer: "agent-review" }, "一处边界要改", "agent-review"),
  ],
  sessions: { author: { agent: "agent-dev" } },
};

function team(home: string): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true } };
  const feature = { id: "F1", projectId: PROJECT, title: "事项", description: "一句话", rev: 1, version: 1, authorityMode: "planning", homeInstanceId: home,
    executorInstanceIds: [home], status: "active", counts: { total: 3, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: home, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const task = (taskId: string, sourceTaskId: string, stage: string) => ({ taskId, sourceTaskId, sourceRev: 1, sourceSeq: 9, stage, assigneeCode: "dev",
    executorInstanceId: home, pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only", steps: [], asks: [] });
  const detail = { schemaVersion: 1, teamId: BASE.team, serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: ["R1", "B1", "P1"].map((key) => ({ key, oneLine: `节点 ${key}`, deps: [], fileGlobs: [], estimate: "" })),
      bindings: [{ nodeKey: "R1", taskId: "task-r1" }, { nodeKey: "B1", taskId: "task-b1" }] },
    tasks: [task("task-r1", "R1", "review"), task("task-b1", "B1", "build")] } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: BASE.team, serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}

const calls: string[] = [];
let localStatus = 200;
/** 本机 /events：null 时回 404（本机事件连不上）；否则用这条流（测试往里推帧） */
let localEvents: ReadableStream<Uint8Array> | null = null;
/** 非 null 时本机详情请求等它放行（模拟详情还在路上） */
let localGate: Promise<void> | null = null;
const realFetch = globalThis.fetch;
beforeAll(() => {
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    calls.push(`${url.host} ${decodeURIComponent(url.pathname)}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/events" && localEvents) return new Response(localEvents, { headers: { "content-type": "text/event-stream" } });
    if (url.pathname === `/api/v1/ledger/${PROJECT}/tasks/R1` && localStatus === 200) { await localGate; return json({ ok: true, ...LOCAL }); }
    return json({ ok: false, error: "not in fixture" }, localStatus === 200 ? 404 : localStatus);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
});

/** 团队源：中心数据走注入 transport（不经 fetch），本机台账走被拦的 fetch */
function source(featureHome: string, local: string | undefined) {
  const t = team(featureHome);
  const transport: Transport = {
    list: async () => t.list, detail: async () => structuredClone(t.detail),
    command: async () => { throw new Error("unused"); }, receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity: Identity = local ? { ...BASE, homeInstanceId: local } : BASE;
  return sharedCollabSource(new SharedLedgerSession(identity, transport), sharedCollabProject(identity), PROJECT, 1, { now: () => NOW });
}
async function open(featureHome: string, local: string | undefined, id = "R1") {
  const src = source(featureHome, local);
  await src.overview(new AbortController().signal);
  calls.length = 0;
  const d = await src.task(id, new AbortController().signal);
  return { d, homeOnly: [...(src.homeOnlyOf?.(d) ?? src.homeOnly ?? [])].sort() as string[], calls: [...calls] };
}

test("复现测试:主场 id = 本机 id 时详情就是本机台账详情，homeOnly 为空集", async () => {
  localStatus = 200;
  const got = await open(HOME, HOME);
  expect(got.homeOnly).toEqual([]);
  // 与本机协作视图同一份输入：事件（含审查）、会话、执行者 / PM 逐字段相等，卡号保持团队视图里的那个
  // 事项号换成中心 feature（团队总览 ov.items 的口径），其余与本机台账逐字段相等
  expect(got.d as unknown).toEqual({ ok: true, ...LOCAL, task: { ...LOCAL.task, itemId: "F1" } });
  expect(got.d.task.agent).toBe("agent-dev");
  expect(got.d.events.filter((e) => e.kind === "review")).toHaveLength(1);
  // 只读了本机（回环）台账这一张卡，没有别的请求
  expect(got.calls).toEqual([`localhost /api/v1/ledger/${PROJECT}/tasks/R1`]);
});

test("防回归:主场 ≠ 本机、键里没有 homeInstanceId 时与 main 逐字一致（中心详情 + 仅主场全集），不读本机台账", async () => {
  localStatus = 200;
  const main = await open(HOME, undefined);
  expect(main.homeOnly).toEqual([...ALL].sort());
  expect(main.d.events).toEqual([]);
  expect(main.d.task.agent).toBeNull();
  expect(main.calls).toEqual([]);
  for (const [home, local] of [[HOME, "other-instance"], ["other-instance", HOME]] as const) {
    const got = await open(home, local);
    expect(got.homeOnly).toEqual(main.homeOnly);
    expect(got.calls).toEqual([]);
    // 镜像证据里的实例 id 随夹具变，其余逐字一致
    // now 是 teamTaskDetail 里的 Date.now()，两次读可能差 1ms
    if (home === HOME) expect({ ...got.d, now: 0 }).toEqual({ ...main.d, now: 0 });
    else expect({ ...got.d, now: 0, task: { ...got.d.task, team: undefined } }).toEqual({ ...main.d, now: 0, task: { ...main.d.task, team: undefined } });
  }
});

test("主场本机但本机台账读不到（404 / 5xx）：退回中心详情，仍按仅主场占位", async () => {
  for (const status of [404, 500]) {
    localStatus = status;
    const got = await open(HOME, HOME);
    expect(got.homeOnly).toEqual([...ALL].sort());
    expect(got.d.events).toEqual([]);
  }
  localStatus = 200;
});

test("homeCardOf：只认绑了执行镜像、所在 feature 主场等于本机实例的卡；未绑的规划节点 / 缺本机实例按非主场", async () => {
  const src = source(HOME, HOME);
  await src.overview(new AbortController().signal);
  const got = src.last()!;
  expect(homeCardOf(got, "R1", HOME)).toBe("R1");
  expect(homeCardOf(got, "B1", HOME)).toBe("B1");
  expect(homeCardOf(got, "P1", HOME)).toBeNull();
  expect(homeCardOf(got, "R1", undefined)).toBeNull();
  expect(homeCardOf(got, "R1", "other-instance")).toBeNull();
  expect(homeCardOf(got, "nope", HOME)).toBeNull();
});

/** 跑真实 follow 循环（轮询 1ms），中心水位始终不变；返回刷新计数与停止 */
function follow(src: ReturnType<typeof source>) {
  const ctrl = new AbortController();
  const got = { signals: 0 };
  const done = src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: (e) => { if (e.type === "ledger" && e.data?.project) got.signals++; } });
  return { got, stop: async () => { ctrl.abort(); await done.catch(() => {}); } };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("复现测试:主场本机卡打开后本机台账变了、中心水位不变，也会发刷新（本机 /events 连不上时按轮询间隔刷新）", async () => {
  localStatus = 200;
  localEvents = null;
  const src = source(HOME, HOME);
  await src.overview(new AbortController().signal);
  await src.task("R1", new AbortController().signal);
  const f = follow(src);
  await wait(60);
  await f.stop();
  expect(f.got.signals).toBeGreaterThan(0);
});

test("复现测试:主场本机卡订本机 /events：本项目的 ledger 事件发刷新，别的项目不发；连着时中心不变不空刷", async () => {
  localStatus = 200;
  let push!: (e: object) => void;
  localEvents = new ReadableStream<Uint8Array>({ start: (c) => { push = (e) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); } });
  const src = source(HOME, HOME);
  await src.overview(new AbortController().signal);
  await src.task("R1", new AbortController().signal);
  calls.length = 0;
  const f = follow(src);
  await wait(30);
  expect(calls.filter((c) => c.endsWith("/api/v1/events"))).toHaveLength(1);
  const opened = f.got.signals;
  expect(opened).toBeGreaterThan(0); // 连上补一次
  await wait(30);
  expect(f.got.signals).toBe(opened);
  push({ seq: 1, ts: "", agent: "", chatId: "", type: "ledger", data: { project: "elsewhere" } });
  await wait(20);
  expect(f.got.signals).toBe(opened);
  push({ seq: 2, ts: "", agent: "", chatId: "", type: "ledger", data: { project: PROJECT } });
  await wait(20);
  expect(f.got.signals).toBe(opened + 1);
  await f.stop();
  localEvents = null;
});

test("防回归:非主场 / 没读过主场卡时 follow 不订本机 /events、中心不变不发刷新", async () => {
  localStatus = 200;
  localEvents = null;
  for (const [home, local] of [[HOME, "other-instance"], [HOME, undefined], [HOME, HOME]] as const) {
    const src = source(home, local);
    await src.overview(new AbortController().signal);
    if (local !== HOME) await src.task("R1", new AbortController().signal);
    calls.length = 0;
    const f = follow(src);
    await wait(40);
    await f.stop();
    expect(f.got.signals).toBe(0);
    expect(calls).toEqual([]);
  }
});

test("复现测试:主场本机卡的执行者在本机 /events 里的动作进 homeActions，别的本机 agent 不进", async () => {
  localStatus = 200;
  let push!: (e: object) => void;
  localEvents = new ReadableStream<Uint8Array>({ start: (c) => { push = (e) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); } });
  const src = source(HOME, HOME);
  await src.overview(new AbortController().signal);
  const f = follow(src);
  await src.task("R1", new AbortController().signal); // follow 已在跑：第一次读到主场本机卡就订本机流
  await wait(20);
  let notified = 0;
  const off = src.homeActions!.subscribe(() => notified++);
  push({ seq: 1, ts: "", agent: "agent-other", chatId: "", type: "agent_status", data: { status: "thinking" } });
  push({ seq: 2, ts: "", agent: "agent-dev", chatId: "", type: "agent_status", data: { status: "thinking" } });
  await wait(20);
  expect([...src.homeActions!.get().keys()]).toEqual(["dev"]);
  expect(src.homeActions!.get().get("dev")?.kind).toBe("thinking");
  push({ seq: 3, ts: "", agent: "agent-dev", chatId: "", type: "tool_start", data: { name: "Edit", detail: "x.ts" } });
  await wait(20);
  expect(src.homeActions!.get().get("dev")?.kind).toBe("tool");
  expect(notified).toBe(2);
  off();
  await f.stop();
  localEvents = null;
});

test("复现测试:本机详情还在路上时执行者的动作先到，详情返回后照样进 homeActions（别的本机 agent 仍不进）", async () => {
  localStatus = 200;
  let push!: (e: object) => void;
  localEvents = new ReadableStream<Uint8Array>({ start: (c) => { push = (e) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); } });
  let release!: () => void;
  localGate = new Promise((r) => { release = r; });
  const src = source(HOME, HOME);
  await src.overview(new AbortController().signal);
  const f = follow(src);
  const pending = src.task("R1", new AbortController().signal); // 订本机流在详情请求之前
  await wait(20);
  expect(calls.filter((c) => c.endsWith("/api/v1/events")).length).toBeGreaterThan(0);
  push({ seq: 1, ts: "", agent: "agent-other", chatId: "", type: "agent_status", data: { status: "thinking" } });
  push({ seq: 2, ts: "", agent: "agent-dev", chatId: "", type: "agent_status", data: { status: "thinking" } });
  await wait(20);
  expect(src.homeActions!.get().size).toBe(0); // 执行者身份还没定：不提前放出任何本机 agent
  let notified = 0;
  const off = src.homeActions!.subscribe(() => notified++);
  release();
  localGate = null;
  await pending;
  expect([...src.homeActions!.get().keys()]).toEqual(["dev"]);
  expect(src.homeActions!.get().get("dev")?.kind).toBe("thinking");
  expect(notified).toBe(1);
  off();
  await f.stop();
  localEvents = null;
});

test("防回归:非主场卡不订本机流，homeActions 始终为空", async () => {
  localStatus = 200;
  localEvents = null;
  for (const local of ["other-instance", undefined]) {
    const src = source(HOME, local);
    await src.overview(new AbortController().signal);
    await src.task("R1", new AbortController().signal);
    calls.length = 0;
    const f = follow(src);
    await wait(30);
    await f.stop();
    expect(src.homeActions!.get().size).toBe(0);
    expect(calls.filter((c) => c.endsWith("/api/v1/events"))).toEqual([]);
  }
});
