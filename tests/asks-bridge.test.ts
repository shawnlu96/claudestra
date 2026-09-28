/**
 * 「待你处理」的 bridge 接线（bridge/asks.ts、ask-entry.ts、local-api/asks.ts）：reply 自动建 ask、三条作答入口、
 * 旧按钮显示已处理、答复不抢占（intent=response + waitForIdle）、改投派发者、过期通知、运行时弹框、权限门。库是临时文件。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerDiscordInteraction, answerFromCard, answerFromChat } from "../src/bridge/ask-entry.js";
import { deliverReplyWithAsk, openRuntimeAsk, ownerPresence, sweepExpired, setAsksForTest, settleRuntimeAsk, type AsksDeps } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { flushHeld } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Delivery, Envelope } from "../src/bridge/router.js";
import { effectivePrincipal, type Grant } from "../src/lib/devices.js";
import { getAsk, listAsks, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { Principal } from "../src/lib/principals.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const at = "2026-09-28T00:00:00Z";
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const owner = (grant: Grant = { agents: ["*"], terminal: true, manage: true }) =>
  effectivePrincipal({ principal: OWNER_BASE, credential: { id: "dev_1", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" } });
const PEER: Principal = { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at };

const ws = { tag: "ws" } as never;
const COMPONENTS = [{ type: "buttons", buttons: [{ id: "go", label: "✅ 发" }, { id: "no", label: "取消" }] }];
const REGISTRY: RegistryAgent[] = [
  { name: "agent-x", channelId: "111", status: "active", projectId: "p", parent: "agent-pm" } as RegistryAgent,
  { name: "agent-pm", channelId: "222", status: "active", projectId: "p" } as RegistryAgent,
];

let path = "";
let delivered: Envelope[] = [];
let held: Envelope[] = [];
let events: BridgeEvent[] = [];
let unsub = () => {};
let clients: AsksDeps["clients"];
let deliverResult: (env: Envelope) => Delivery = (env) => ({ envelope: env, outcome: { kind: "sent", discordMessageIds: ["d1", "d2"] } });

const mkDeps = (): AsksDeps => ({
  clients, controlChannelId: "999",
  deliver: async (env) => (delivered.push(env), deliverResult(env)),
  hold: (env) => void held.push(env),
});

function setup(registry = REGISTRY) {
  unsub(); // 同一用例里再 setup 一次：先退掉上一个订阅、关掉上一个库
  if (path) closeLedger(path);
  path = tempLedgerPath("asks-bridge-");
  openLedger(path);
  delivered = [];
  held = [];
  events = [];
  clients = new Map([["111", { ws }], ["222", { ws }]]);
  setAsksForTest({ path, deps: mkDeps(), registry, ownerChats: ["api:owner:self"] });
  unsub = subscribeEvents({}, (e) => void (e.type === "ask" && events.push(e)));
}
beforeEach(() => setup());
afterEach(() => {
  unsub();
  setAsksForTest(undefined);
  closeLedger(path);
  path = "";
  unsub = () => {};
  deliverResult = (env) => ({ envelope: env, outcome: { kind: "sent", discordMessageIds: ["d1", "d2"] } });
});

const replyEnv = (content: string, components?: unknown[]): Envelope => ({
  from: { kind: "local", channelId: "111", ws }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content,
  meta: { messageId: "reply_1", triggerKind: "agent_tool", ts: at, threadId: "thr_1", components },
});

async function reply(chatId = "api:owner:self", components: unknown[] | undefined = COMPONENTS): Promise<Ask | null> {
  const env = replyEnv("**发 v2.31.0 吗？**\n改动见 PR #150", components);
  await deliverReplyWithAsk(env, chatId, "111", async (e) => (delivered.push(e), deliverResult(e)));
  delivered = [];
  return env.meta.askId ? getAsk(openLedger(path), env.meta.askId) : null;
}

describe("reply → ask", () => {
  test("带按钮、发给 owner：建 ask（发起方由频道推导、挂项目）、askId 进 env.meta、补记 Discord 消息 id、发 SSE ask", async () => {
    const a = (await reply())!;
    expect(a).toMatchObject({ project: "p", fromAgent: "agent-x", source: "reply", kind: "decide", blocking: null, title: "发 v2.31.0 吗？", state: "open", discordMessageIds: ["d1", "d2"] });
    expect(events.map((e) => (e.data as { askId: string }).askId)).toEqual([a.id]);
  });

  test("不建：没有选项、发给 peer / 别的 token、发起频道不认识", async () => {
    expect(await reply("api:owner:self", [])).toBeNull();
    expect(await reply("api:tok_peer")).toBeNull();
    setup([]);
    expect(await reply()).toBeNull();
  });

  test("reply 没发出去 → ask 撤掉", async () => {
    deliverResult = (env) => ({ envelope: env, outcome: { kind: "dropped", reason: "x" } });
    const env = replyEnv("发吗", COMPONENTS);
    await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => deliverResult(e));
    expect(getAsk(openLedger(path), env.meta.askId!)?.state).toBe("cancelled");
  });
});

describe("作答 → 答复不抢占", () => {
  test("聊天里点按钮：答复是 response + waitForIdle + trigger ask_answer，正文带说明行与原 wire；台账记 decision", async () => {
    const a = (await reply())!;
    const res = (await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() }))!;
    expect(res.status).toBe(202);
    expect(delivered).toHaveLength(1);
    const env = delivered[0];
    expect(env).toMatchObject({ intent: "response", from: { kind: "api", tokenId: "owner:self" }, to: { channelId: "111" }, meta: { waitForIdle: true, triggerKind: "ask_answer", askId: a.id } });
    expect(env.content.split("\n").slice(1)).toEqual(["[button:go]"]);
    expect(env.content).toContain(a.id);
    const after = getAsk(openLedger(path), a.id)!;
    expect(after).toMatchObject({ state: "answered", outboxMessageId: env.meta.messageId, answer: { via: "web_chat", choices: ["[button:go]"] } });
    expect(listEvents(openLedger(path), { project: "p" }).map((e) => e.kind)).toEqual(["ask", "decision"]);
  });

  test("旧按钮再点：409 ask_closed，不再投给 agent", async () => {
    await reply();
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    delivered = [];
    const res = (await answerFromChat({ agent: "agent-x", text: "[button:no]", principal: owner() }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ask_closed", state: "answered" });
    expect(delivered).toEqual([]);
  });

  test("表单同步行 + 补充文字：算作答，补充进 answer.text 与正文", async () => {
    await reply("api:owner:self", [{ type: "multiselect", id: "f", options: [{ label: "甲", value: "a" }, { label: "乙", value: "b" }] }]);
    const res = (await answerFromChat({ agent: "agent-x", text: "[select:f:a,b]\n顺便先别发 release", principal: owner() }))!;
    expect(res.status).toBe(202);
    // 第一行给 agent 的说明，之后是 owner 发的原文（网页回显 / 历史只去掉第一行，和乐观气泡对得上）
    expect(delivered[0].content.split("\n").slice(1).join("\n")).toBe("[select:f:a,b]\n顺便先别发 release");
  });

  test("历史里 trigger=ask_answer 的入站只留 owner 原文；别的入站不动", () => {
    const wrap = (trigger: string, body: string) => `<channel source="claudestra" chat_id="api:owner:self" trigger="${trigger}" user="owner">\n${body}\n</channel>`;
    expect(unwrapChannelMessage(wrap("ask_answer", "[✅ owner 回复了你 …]\n[button:go]"))?.text).toBe("[button:go]");
    expect(unwrapChannelMessage(wrap("system", "第一行\n第二行"))?.text).toBe("第一行\n第二行");
  });

  test("不接管：没 wire 的普通消息、对不上任何 ask 的 wire、非 owner 凭据（peer / 部分 scope）", async () => {
    await reply();
    expect(await answerFromChat({ agent: "agent-x", text: "你好", principal: owner() })).toBeNull();
    expect(await answerFromChat({ agent: "agent-x", text: "[button:other]", principal: owner() })).toBeNull();
    expect(await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: PEER })).toBeNull();
    expect(await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner({ agents: ["agent-x"], terminal: false, manage: true }) })).toBeNull();
    expect(delivered).toEqual([]);
  });

  test("同一个按钮 id 用在两条 ask 上：没带 askId 取最新开着的；网页带了 askId 就按它", async () => {
    const first = (await reply())!;
    const second = (await reply())!;
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner(), askId: first.id });
    expect(getAsk(openLedger(path), first.id)?.state).toBe("answered");
    await answerFromChat({ agent: "agent-x", text: "[button:no]", principal: owner() });
    expect(getAsk(openLedger(path), second.id)?.state).toBe("answered");
  });

  test("押后队列：目标主回合在忙时答复留着（不是人类 request），空闲才投", async () => {
    await reply();
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    const q = new HeldQueue(null);
    q.holdEnv(delivered[0]);
    const out: string[] = [];
    const deps = {
      held: q, compacting: () => false, working: async () => true, client: () => ({ ws }), touch: () => {},
      isHumanRequest: (env: Envelope) => (env.from.kind === "user" || (env.from.kind === "api" && !env.from.peer)) && env.intent === "request",
      deliver: async (env: Envelope) => (out.push(env.content), { envelope: env, outcome: { kind: "sent" as const } }),
    };
    await flushHeld(deps, "111", "scan");
    expect(out).toEqual([]);
    await flushHeld({ ...deps, working: async () => false }, "111", "stop");
    expect(out).toHaveLength(1);
  });
});

describe("Discord 与卡片", () => {
  const click = (messageId: string) => {
    const log: string[] = [];
    const i = {
      message: { id: messageId, content: "发吗" }, user: { id: "u1", username: "shawn" },
      editReply: async (o: { content: string }) => void log.push(`edit:${o.content}`),
      followUp: async (o: { content: string }) => void log.push(`whisper:${o.content}`),
    };
    return { i, log };
  };

  test("Discord 按原消息 id 认 ask：开着 → 作答（from 是 Discord 用户）并改原消息；再点 → 只告诉点的人已处理", async () => {
    const a = (await reply("555"))!;
    const c1 = click("d2");
    expect(await answerDiscordInteraction(c1.i, "555", "[button:go]")).toBe(true);
    expect(delivered[0]).toMatchObject({ intent: "response", from: { kind: "user", userId: "u1" }, meta: { askId: a.id } });
    expect(c1.log[0]).toContain("✅");
    const c2 = click("d1");
    expect(await answerDiscordInteraction(c2.i, "555", "[button:no]")).toBe(true);
    expect(c2.log[0]).toMatch(/^whisper:/);
    expect(delivered).toHaveLength(1);
    expect(await answerDiscordInteraction(click("other").i, "555", "[button:go]")).toBe(false);
  });

  test("卡片：选项对不上 400、项目不对 404、既不选也不写 400、正常 202；运行时弹框类让走按键端点", async () => {
    const a = (await reply())!;
    expect((await answerFromCard("p", a.id, { choices: ["[button:zzz]"] }, owner())).status).toBe(400);
    expect((await answerFromCard("q", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(404);
    expect((await answerFromCard("p", a.id, { choices: [] }, owner())).status).toBe(400);
    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"], text: "好" }, owner())).status).toBe(202);
    expect(getAsk(openLedger(path), a.id)?.answer).toMatchObject({ via: "web_card", text: "好" });
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "t", context: "c", options: [] });
    const rt = listAsks(openLedger(path), { source: "permission" })[0];
    expect((await answerFromCard("p", rt.id, { choices: [] }, owner())).status).toBe(400);
  });

  test("HTTP：门是 canReadLedger；列表跨项目；presence 按设备记", async () => {
    await reply();
    const get = (p: string, who: Principal) => handleAsksApi(new Request(`http://x/api/v1${p}`), p, who);
    expect((await get("/asks", PEER))!.status).toBe(403);
    const body = (await (await get("/asks", owner()))!.json()) as { asks: Ask[] };
    expect(body.asks).toHaveLength(1);
    expect(((await (await get("/ledger/q/asks", owner()))!.json()) as { asks: Ask[] }).asks).toEqual([]);
    const post = (v: unknown) => handleAsksApi(new Request("http://x/api/v1/presence", { method: "POST", body: JSON.stringify(v) }), "/presence", owner());
    expect((await post({ visible: "yes" }))!.status).toBe(400);
    expect(await (await post({ visible: true }))!.json()).toMatchObject({ presence: "active" });
    ownerPresence.setVisible("dev_1", false);
    expect(await get("/nope", owner())).toBeNull();
  });
});

describe("改投、过期、运行时弹框", () => {
  test("发起方被 kill：答复改投它的派发者，ask 上记一笔；派发者也不在 → 大总管；谁都不在线就进押后队列", async () => {
    const a = (await reply())!;
    clients.delete("111");
    setAsksForTest({ path, deps: mkDeps(), registry: [{ ...REGISTRY[0], status: "stopped" } as RegistryAgent, REGISTRY[1]], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    expect(delivered[0].to).toMatchObject({ channelId: "222", agentName: "agent-pm" });
    expect(getAsk(openLedger(path), a.id)?.extra).toEqual({ redirectedTo: "agent-pm" });
    const b = (await reply())!;
    clients.clear();
    setAsksForTest({ path, deps: mkDeps(), registry: [], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner(), askId: b.id });
    expect(held.map((e) => e.to)).toMatchObject([{ channelId: "999", agentName: "master" }]);
  });

  test("过期：记 expired，给发起方发「按未批准处理」（notification、不抢占）", async () => {
    const a = (await reply())!;
    openLedger(path).run("UPDATE asks SET expiresAt = 1 WHERE id = ?", [a.id]);
    expect(await sweepExpired()).toBe(1);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("expired");
    expect(delivered[0]).toMatchObject({ intent: "notification", from: { kind: "bridge" }, meta: { waitForIdle: true } });
    expect(delivered[0].content).toContain("未批准");
    expect((await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() }))!.status).toBe(409);
  });

  test("运行时弹框：同频道同来源只开一条；有下游挂在它名下算急；提交记 answered、其余关掉记 cancelled；换新弹框先结旧的", async () => {
    await openRuntimeAsk({ source: "auq", channelId: "222", agentName: "agent-pm", kind: "decide", title: "选哪个", context: "", options: [] });
    await openRuntimeAsk({ source: "auq", channelId: "222", agentName: "agent-pm", kind: "decide", title: "选哪个", context: "", options: [] });
    const db = openLedger(path);
    const [auq] = listAsks(db, { source: "auq" });
    expect(listAsks(db, { source: "auq" })).toHaveLength(1);
    expect(auq).toMatchObject({ blocking: true, urgency: "urgent", fromAgent: "agent-pm", allowText: false });
    settleRuntimeAsk("auq", "222", "interact");
    expect(getAsk(db, auq.id)?.state).toBe("answered");
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "a", context: "", options: [] });
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "b", context: "", options: [], replace: true });
    expect(listAsks(db, { source: "permission" }).map((a) => [a.title, a.state])).toEqual([["b", "open"], ["a", "cancelled"]]);
    settleRuntimeAsk("permission", "111");
    expect(listAsks(db, { source: "permission", states: ["open"] })).toEqual([]);
  });
});
