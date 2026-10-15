/**
 * agents-NOTICETYPE1 验收线 2 / 3：oneShot 按发送方标的级别分流，不看正文；没标级别的 oneShot 不送、进 pm-todo；
 * 本项目入口标 info 的不送、标 action 的立即送，归类记录 levelSource=structured。走 deliverPmLocal 全路径，拉取模式（缺省）开着。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { pmDigest } from "../src/bridge/pm-digest.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { classifyPmPush, type DigestInput } from "../src/lib/pm-digest.js";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { frameLevel } from "../src/lib/pm-notice-level.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import { ONESHOT_TODO_KIND } from "../src/lib/pm-todo-oneshot.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import type { PmNoticeLevel } from "../src/lib/pm-notice-level.js";
import { B, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const defaults = { ...pmDigest.deps };
beforeEach(() => rmSync(new PmDigestStore().path, { force: true })); // 摘要队列 / 归类记录每条用例从空开始
afterEach(async () => {
  for (const f of fixtures.splice(0)) f.close();
  const store = new PmDigestStore();
  await store.setMode(P, "observe");
  await store.setRouteMode(P, "observe");
  await store.setPullMode(P, "on");
  pmDigest.stop();
  Object.assign(pmDigest.deps, defaults);
});
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const toB: LocalEndpoint = { kind: "local", agentName: B, channelId: "channel-b", ws };
let seq = 0;
const env = (sender: string, content: string, opts: { oneShot?: boolean; level?: PmNoticeLevel } = {}): Envelope => ({
  from: { kind: "local", agentName: sender, channelId: sender === "scheduler" ? "" : `ch-${sender}`, ws }, to: toB, intent: "request", content,
  meta: { messageId: `nt${++seq}`, threadId: `t${seq}`, ts: "2026-10-16T00:00:00Z", triggerKind: "agent_tool",
    ...(opts.oneShot === false ? {} : { skipInterAgentWatchdog: true }), ...(opts.level ? { pmLevel: opts.level } : {}) } });

async function world(route: "on" | "observe" = "observe") {
  const f = pmFixture();
  fixtures.push(f);
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const store = new PmDigestStore();
  await store.setMode(P, "on");
  await store.setRouteMode(P, route);
  expect(store.pullMode(P)).toBe("on"); // 拉取模式（缺省）
  const state = await f.deps.read(), book = new AgentCallBook(null), receipts = new Map();
  const clients = new Map([["channel-b", { ws }]]), sent: string[] = [];
  const send = async (e: Envelope): Promise<Delivery> => { sent.push(e.content); return { envelope: e, outcome: { kind: "sent" } }; };
  const deliver = (e: Envelope) => deliverPmLocal(e, toB, clients, book, receipts, send, { db: f.db, agents: state.agents });
  const todos = () => pmTodos(f.db, P, () => null, Date.now()).filter((t) => t.kind === ONESHOT_TODO_KIND);
  return { f, store, sent, deliver, todos };
}

for (const route of ["observe", "on"] as const) {
  test(`[验收线 2] pull mode, route ${route}: an English oneShot approval marked action is delivered now; unmarked oneShots are held and listed in pm-todo`, async () => {
    const w = await world(route);
    const approve = "agents-FOO1: Please approve the schema migration plan (PR #12)";
    expect((await w.deliver(env("agent-task-1", approve, { level: "action" }))).outcome).toEqual({ kind: "sent" });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.endsWith(approve)).toBe(true);

    // 没标级别：英文审批措辞、中文「要你拍板」措辞都不送，都进 pm-todo（发送方、卡号、首行）
    const en = "agents-FOO2: Please approve X before I continue?", zh = "agents-FOO3 要你拍板：方案 A 还是 B？失败了怎么办";
    expect((await w.deliver(env("agent-task-2", en))).outcome).toEqual({ kind: "sent", note: "digest" });
    expect((await w.deliver(env("agent-task-3", zh))).outcome).toEqual({ kind: "sent", note: "digest" });
    expect(w.sent).toHaveLength(1);
    expect(w.todos().map((t) => [t.task, t.what])).toEqual([
      ["agents-FOO2", `agent-task-2 · ${en}`], ["agents-FOO3", `agent-task-3 · ${zh}`]]);

    // oneShot + info：进摘要、不送，也不进 pm-todo 的待处理条目
    const progress = "agents-FOO4 进度：第 2 步失败后已自动重试通过";
    expect((await w.deliver(env("agent-task-4", progress, { level: "info" }))).outcome).toEqual({ kind: "sent", note: "digest" });
    expect(w.sent).toHaveLength(1);
    expect(w.store.queued(P).map((e) => e.firstLine)).toEqual([en, zh, progress]);
    expect(w.todos()).toHaveLength(2);
  });
}

test("[验收线 3] project entries: scheduler info is not delivered, action is delivered now, both recorded as structured", async () => {
  const w = await world();
  const info = "[调度引擎] 卡 worktree 下有 2 个残留进程（observe 模式：只记录）请 PM 看", action = "[engine] agents-FOO5 handed back to manual";
  expect((await w.deliver(env("scheduler", info, { level: "info" }))).outcome).toEqual({ kind: "sent", note: "digest" });
  expect((await w.deliver(env("scheduler", action, { level: "action" }))).outcome).toEqual({ kind: "sent" });
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.endsWith(action)).toBe(true);
  expect(w.todos()).toEqual([]); // 标了级别的系统通知不进 oneShot 待办
  const log = w.store.read().log.filter((r) => r.project === P);
  expect(log.map((r) => [r.send, r.levelSource])).toEqual([["digest", "structured"], ["now", "structured"]]);
});

test("a waiting (non-oneShot) agent message keeps the body rules; its level is not trusted and the record says regex", () => {
  const m = (body: string, level?: PmNoticeLevel): DigestInput => ({ fromKind: "local", sender: "agent-x", intent: "request", triggerKind: "agent_tool",
    oneShot: false, body, ...(level ? { level } : {}) });
  expect(classifyPmPush(m("只同步：进度 3/5", "action"))).toMatchObject({ send: "digest", levelSource: "regex" });
  expect(classifyPmPush(m("只同步：第 3 步失败", "info"))).toMatchObject({ send: "now", levelSource: "regex" });
  expect(classifyPmPush(m("请看一下"))).toEqual({ send: "now", reason: "agent 消息等回复" });
});

test("route classification of agent oneShots looks only at the level, never at the body", () => {
  const m = (body: string, level?: PmNoticeLevel): DigestInput => ({ fromKind: "local", sender: "agent-x", intent: "request", triggerKind: "agent_tool",
    oneShot: true, body, ...(level ? { level } : {}) });
  const rule = (x: DigestInput) => classifyPmRoute(x).tags[0]!.rule;
  expect(classifyPmRoute(m("progress 3/5", "action"))).toMatchObject({ immediate: true });
  expect(rule(m("P0 事故，需要 owner 拍板", "info"))).toBe("level.info");
  expect(rule(m("P0 事故，需要 owner 拍板"))).toBe("oneshot.unleveled");
  expect(classifyPmRoute(m("P0 事故，需要 owner 拍板")).immediate).toBeUndefined();
  // 系统发送方不算「其他 agent」：没标级别时照旧规则
  expect(rule({ ...m("[调度引擎] 退回人工，请接手"), sender: "scheduler" })).toBe("protect.action");
});

test("frameLevel: scheduler frames unchanged; agent frames only for oneShot; illegal values dropped", () => {
  expect(frameLevel({ pmLevel: "info" }, false)).toBe("info");
  expect(frameLevel({ pmLevel: "action", oneShot: true }, false)).toBe("action");
  expect(frameLevel({ pmLevel: "action" }, true)).toBeUndefined(); // agent 非 oneShot：丢
  expect(frameLevel({ pmLevel: "action", oneShot: false }, true)).toBeUndefined();
  expect(frameLevel({ pmLevel: "info", oneShot: true }, true)).toBe("info");
  for (const bad of ["urgent", "ACTION", 1, null, undefined, {}]) {
    expect(frameLevel({ pmLevel: bad, oneShot: true }, true)).toBeUndefined();
    expect(frameLevel({ pmLevel: bad }, false)).toBeUndefined();
  }
});
