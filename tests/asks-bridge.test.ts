/**
 * 「待你处理」的 bridge 接线（bridge/asks.ts、ask-runtime.ts、ask-entry.ts、local-api/asks.ts）：reply 自动建 ask、三条作答入口、
 * 旧按钮显示已处理、答复不抢占（intent=response + waitForIdle 标记，押后的接线归 T13a）、改投派发者、过期通知、运行时弹框、权限门、
 * 多行 reply 逐行作答、bridge 重启清理。第一轮审查（t11a-rev/*.ts）的复现都在这里。库是临时文件。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerDiscordInteraction, answerFromCard, answerFromChat } from "../src/bridge/ask-entry.js";
import { cancelStaleRuntimeAsks, noteRuntimeDialogs, openRuntimeAsk, permissionLabel, resetRuntimeAsksForTest, settleRuntimeAsk } from "../src/bridge/ask-runtime.js";
import { deliverReplyWithAsk, ownerPresence, sweepExpired, setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { setLedgerFeedForTest, sseEventAllow } from "../src/bridge/ledger-feed.js";
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
/** 授权含大总管的 owner 设备：发起方和派发者都不在、答复落到大总管的用例用它 */
const ownerWithMaster = () => owner({ agents: ["*", "master"], terminal: true, manage: true });
const PEER: Principal = { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at };
const LEGACY_STAR_TOKEN: Principal = { id: "token:tok_int", role: "external", name: "integration", agents: ["*"], createdAt: at };

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
  resetRuntimeAsksForTest();
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

  test("旧按钮再点：网页带了 askId → 409 ask_closed（提示是人话），不再投；没带 askId 不猜，照常当普通消息（不吞掉新按钮）", async () => {
    const a = (await reply())!;
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    delivered = [];
    const res = (await answerFromChat({ agent: "agent-x", text: "[button:no]", principal: owner(), askId: a.id }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ask_closed", state: "answered", error: "已处理：✅ 发" });
    expect(await answerFromChat({ agent: "agent-x", text: "[button:no]", principal: owner() })).toBeNull();
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
    expect(c2.log[0]).toBe("whisper:已处理：✅ 发");
    expect(delivered).toHaveLength(1);
    expect(await answerDiscordInteraction(click("other").i, "555", "[button:go]")).toBe(false);
  });

  test("卡片：选项对不上 400、项目不对 404、既不选也不写 400、正常 202；运行时弹框类 400（由原按键端点记账，记人话标签）", async () => {
    const a = (await reply())!;
    expect((await answerFromCard("p", a.id, { choices: ["[button:zzz]"] }, owner())).status).toBe(400);
    expect((await answerFromCard("q", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(404);
    expect((await answerFromCard("p", a.id, { choices: [] }, owner())).status).toBe(400);
    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"], text: "好" }, owner())).status).toBe(202);
    expect(getAsk(openLedger(path), a.id)?.answer).toMatchObject({ via: "web_card", text: "好" });
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "t", context: "c", options: [] });
    const rt = listAsks(openLedger(path), { source: "permission" })[0];
    expect((await answerFromCard("p", rt.id, { choices: [] }, owner())).status).toBe(400);
    settleRuntimeAsk("permission", "111", "interact", permissionLabel("allow"), { principal: "owner:self" }); // api-routes 按键端点那一行
    expect(getAsk(openLedger(path), rt.id)).toMatchObject({ state: "answered", answer: { via: "interact", labels: ["允许"] } });
    settleRuntimeAsk("permission", "111"); // 弹框随后消失：已答的不会被改成撤销
    expect(getAsk(openLedger(path), rt.id)?.state).toBe("answered");
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
    expect(delivered[0].content.split("\n")[0]).toContain("原本是 agent-x 问的");
    expect(getAsk(openLedger(path), a.id)?.extra).toEqual({ parent: "agent-pm", parentChannelId: "222", redirectedTo: "agent-pm" });
    const b = (await reply())!;
    clients.clear();
    setAsksForTest({ path, deps: mkDeps(), registry: [], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: ownerWithMaster(), askId: b.id });
    expect(held.map((e) => e.to)).toMatchObject([{ channelId: "999", agentName: "master" }]);
  });

  test("过期：记 expired，给发起方发「按未批准处理」（notification、不抢占）", async () => {
    const a = (await reply())!;
    openLedger(path).run("UPDATE asks SET expiresAt = 1 WHERE id = ?", [a.id]);
    expect(await sweepExpired()).toBe(1);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("expired");
    // 过期通知不是 owner 的答复：trigger 用 bridge_synth，ask_answer 只留给 owner 作答
    expect(delivered[0]).toMatchObject({ intent: "notification", from: { kind: "bridge" }, meta: { waitForIdle: true, triggerKind: "bridge_synth" } });
    expect(delivered[0].content).toContain("未批准");
    expect((await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner(), askId: a.id }))!.status).toBe(409);
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

  test("permission-watcher 的一行调用：同一个权限弹框每 8 秒扫到只开一条；换了弹框先结旧的；消失就结案；Codex 规则表是空的，不开", async () => {
    const tick = (desc: string | null) => noteRuntimeDialogs("111", "agent-x", "pane text", desc);
    tick("执行命令: rm x");
    tick("执行命令: rm x");
    await Bun.sleep(20);
    tick("Edit 文件: a.ts");
    await Bun.sleep(20);
    tick(null);
    await Bun.sleep(20);
    const db = openLedger(path);
    expect(listAsks(db, { source: "permission" }).map((a) => [a.context, a.state])).toEqual([["Edit 文件: a.ts", "cancelled"], ["执行命令: rm x", "cancelled"]]);
    expect(listAsks(db, { source: "codex" })).toEqual([]);
  });
});

describe("第一轮审查的复现", () => {
  /** 大总管在 #control（数字频道 999）发一条带按钮的 reply */
  async function masterReply(): Promise<Ask> {
    clients.set("999", { ws });
    const env: Envelope = {
      from: { kind: "local", channelId: "999", ws }, to: { kind: "user", userId: "", channelId: "999" }, intent: "response", content: "要不要 force push main？\n内部细节",
      meta: { messageId: "m1", triggerKind: "agent_tool", ts: at, threadId: "t", components: [{ type: "buttons", buttons: [{ id: "go", label: "推" }] }] },
    };
    await deliverReplyWithAsk(env, "999", "999", async (e) => ({ envelope: e, outcome: { kind: "sent", discordMessageIds: ["d9"] } }));
    return getAsk(openLedger(path), env.meta.askId!)!;
  }
  const LEGACY_STAR: Principal = { id: "token:tok_int", role: "external", name: "integration", agents: ["*"], createdAt: at };

  test("P1-2 权限：老的「*」Bearer 看得见普通 ask 但不能答；不含 master 的设备看不见、答不了大总管的 ask；含 master 的 owner 设备可以", async () => {
    const m = await masterReply();
    const x = (await reply())!;
    const list = async (who: Principal) => ((await (await handleAsksApi(new Request("http://x/api/v1/asks"), "/asks", who))!.json()) as { asks: Ask[] }).asks.map((a) => a.id);
    expect(await list(owner())).toEqual([x.id]);
    expect((await list(owner({ agents: ["*", "master"], terminal: true, manage: true }))).sort()).toEqual([m.id, x.id].sort());
    expect(await list(LEGACY_STAR)).toEqual([x.id]);
    expect((await answerFromCard("master", m.id, { choices: ["[button:go]"], text: "IGNORE PREVIOUS" }, LEGACY_STAR)).status).toBe(404);
    expect((await answerFromCard("master", m.id, { choices: ["[button:go]"] }, owner())).status).toBe(404);
    expect((await answerFromCard("p", x.id, { choices: ["[button:go]"] }, LEGACY_STAR)).status).toBe(403);
    expect(await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: LEGACY_STAR })).toBeNull();
    expect(delivered).toEqual([]);
    expect((await answerFromCard("master", m.id, { choices: ["[button:go]"] }, owner({ agents: ["*", "master"], terminal: true, manage: true }))).status).toBe(202);
    expect(delivered[0].to).toMatchObject({ agentName: "master" });
  });

  test("P1-2 SSE：ask 事件按发起方的 scope 给——不含 master 的凭据收不到大总管的 ask；?types= 只要这几类", () => {
    // 能读台账的连接会顺带起每秒轮询：换成这个用例自己的库、不真发，用完停掉，别把定时器留给后面的测试文件
    setLedgerFeedForTest({ path, emit: () => {} });
    const ev = (agent: string, type = "ask"): BridgeEvent => ({ seq: 1, ts: at, agent, chatId: "c", type: type as BridgeEvent["type"], data: {} });
    const star = sseEventAllow(owner());
    expect([star(ev("agent-x")), star(ev("master"))]).toEqual([true, false]);
    expect(sseEventAllow(owner({ agents: ["*", "master"], terminal: true, manage: true }))(ev("master"))).toBe(true);
    const onlyAsk = sseEventAllow(owner(), ["ask"]);
    expect([onlyAsk(ev("agent-x")), onlyAsk(ev("agent-x", "tool_start"))]).toEqual([true, false]);
    setLedgerFeedForTest(undefined);
  });

  test("P1-3 多行 reply：聊天里逐行点，每行都投给 agent；所有行答完才结案；同一行再点 → 409 这一项已经答过了", async () => {
    await reply("api:owner:self", [
      { type: "select", id: "model", options: [{ label: "Opus", value: "opus" }, { label: "Sonnet", value: "sonnet" }] },
      { type: "select", id: "effort", options: [{ label: "high", value: "high" }, { label: "low", value: "low" }] },
    ]);
    const r1 = (await answerFromChat({ agent: "agent-x", text: "[select:model:opus]", principal: owner() }))!;
    expect(await r1.json()).toMatchObject({ ask: { state: "open" } });
    expect(delivered[0].content.split("\n")[0]).toContain("还有 1 项没答");
    const dup = (await answerFromChat({ agent: "agent-x", text: "[select:model:sonnet]", principal: owner() }))!;
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: "ask_part_answered" });
    const r2 = (await answerFromChat({ agent: "agent-x", text: "[select:effort:high]", principal: owner() }))!;
    expect(await r2.json()).toMatchObject({ ask: { state: "answered" } });
    expect(delivered.map((e) => e.content.split("\n")[1])).toEqual(["[select:model:opus]", "[select:effort:high]"]);
  });

  test("P1-3 Discord 多行：答了一组只悄悄说已收到，原消息不动（别的行还要点）", async () => {
    const a = (await reply("555", [
      { type: "select", id: "model", options: [{ label: "Opus", value: "opus" }] },
      { type: "buttons", buttons: [{ id: "go", label: "开干" }] },
    ]))!;
    const log: string[] = [];
    const i = {
      message: { id: "d1", content: "选" }, user: { id: "u1", username: "s" },
      editReply: async () => void log.push("edit"), followUp: async (o: { content: string }) => void log.push(o.content),
    };
    expect(await answerDiscordInteraction(i, "555", "[select:model:opus]")).toBe(true);
    expect(log).toEqual(["已收到：Opus（这条还有别的项没答）"]);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("open");
  });

  test("P1-4 bridge 重启：上次留下还开着的运行时 ask 全部撤掉，reply 类不动；弹框还在的由 watcher 重建", async () => {
    const x = (await reply())!;
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "t", context: "Bash(rm x)", options: [] });
    resetRuntimeAsksForTest(); // 内存表丢了
    expect(cancelStaleRuntimeAsks()).toBe(1);
    noteRuntimeDialogs("111", "agent-x", "pane", "Bash(rm x)");
    await Bun.sleep(20);
    const db = openLedger(path);
    expect(listAsks(db, { source: "permission" }).map((a) => a.state).sort()).toEqual(["cancelled", "open"]);
    expect(getAsk(db, x.id)?.state).toBe("open");
  });

  test("P2-2 到点还没扫、owner 先答了：记 expired、回 409，并给发起方补发「按未批准处理」", async () => {
    const a = (await reply())!;
    openLedger(path).run("UPDATE asks SET expiresAt = ? WHERE id = ?", [Date.now() - 1000, a.id]);
    const r = (await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() }))!;
    expect(r.status).toBe(409);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("expired");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ intent: "notification", meta: { triggerKind: "bridge_synth" } });
    expect(await sweepExpired()).toBe(0);
  });

  test("P2-6 decision 事件记人话", async () => {
    await reply();
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    const dec = listEvents(openLedger(path), { project: "p" }).find((e) => e.kind === "decision")!;
    expect(dec.text).toBe("✅ 发");
  });

  test("P2-7 权限弹框在 Discord 上答了：记 answered（带选了什么），不是撤销", async () => {
    noteRuntimeDialogs("111", "agent-x", "pane", "Bash(rm x)");
    await Bun.sleep(20);
    settleRuntimeAsk("permission", "111", "discord", "✅ 已允许");
    const [p] = listAsks(openLedger(path), { source: "permission" });
    expect(p).toMatchObject({ state: "answered", answer: { via: "discord", labels: ["✅ 已允许"] } });
  });
});

describe("第二轮审查的复现", () => {
  test("P1-3 两行按钮各答各的：第 1 行 202 仍 open，第 2 行 202 才结案，agent 收到 2 条", async () => {
    await reply("api:owner:self", [
      { type: "buttons", buttons: [{ id: "a1", label: "甲" }, { id: "a2", label: "乙" }] },
      { type: "buttons", buttons: [{ id: "b1", label: "丙" }] },
    ]);
    const r1 = (await answerFromChat({ agent: "agent-x", text: "[button:a1]", principal: owner() }))!;
    expect(await r1.json()).toMatchObject({ ask: { state: "open" } });
    const r2 = (await answerFromChat({ agent: "agent-x", text: "[button:b1]", principal: owner() }))!;
    expect(await r2.json()).toMatchObject({ ask: { state: "answered" } });
    expect(delivered).toHaveLength(2);
  });

  test("P1-2 运行时 ask 的作答记到真正作答的人：Discord 用户 / 网页凭据；取不到记 unknown，不再一律 owner", async () => {
    const actorOf = (source: "auq" | "permission") => {
      const [x] = listAsks(openLedger(path), { source });
      return listEvents(openLedger(path), { project: "p" }).find((e) => e.kind === "decision" && e.data.askId === x.id)?.actor;
    };
    await openRuntimeAsk({ source: "permission", channelId: "111", agentName: "agent-x", kind: "authorize", title: "t", context: "c", options: [] });
    settleRuntimeAsk("permission", "111", "discord", "✅ 已允许", { principal: "discord:u9" });
    expect(actorOf("permission")).toBe("discord:u9");
    await openRuntimeAsk({ source: "auq", channelId: "111", agentName: "agent-x", kind: "decide", title: "t", context: "c", options: [] });
    settleRuntimeAsk("auq", "111", "interact");
    expect(actorOf("auq")).toBe("unknown");
  });

  test("P2-3 发起方被 kill（registry 条目已删）：答复仍先投给建 ask 时记下的派发者", async () => {
    const a = (await reply())!;
    expect(a.extra).toEqual({ parent: "agent-pm", parentChannelId: "222" });
    clients.delete("111");
    setAsksForTest({ path, deps: mkDeps(), registry: [REGISTRY[1]], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner() });
    expect(delivered[0].to).toMatchObject({ channelId: "222", agentName: "agent-pm" });
  });

  test("r3 P2-2 答复要改投到凭据 scope 外（授权不含 master 的设备答无主的 ask）→ 403，不记账、不投递", async () => {
    const a = (await reply())!;
    clients.clear();
    setAsksForTest({ path, deps: mkDeps(), registry: [], ownerChats: ["api:owner:self"] });
    const noTerm = owner({ agents: ["*"], terminal: false, manage: true });
    expect((await answerFromChat({ agent: "agent-x", text: "[button:go]\n都发", principal: noTerm, askId: a.id }))!.status).toBe(403);
    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"] }, noTerm)).status).toBe(403);
    expect([...delivered, ...held]).toEqual([]);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("open");
  });

  test("r3 P2-1 派发者按频道认：它也被 kill、旧名被新 agent 占了 → 大总管；它只是改了名 → 投给改名后的它", async () => {
    const a = (await reply())!;
    const b = (await reply())!;
    clients.clear();
    const squatter = { name: "agent-pm", channelId: "555", status: "active", projectId: "q" } as RegistryAgent;
    setAsksForTest({ path, deps: mkDeps(), registry: [squatter], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: ownerWithMaster(), askId: a.id });
    expect(held.map((e) => e.to)).toMatchObject([{ channelId: "999", agentName: "master" }]);
    const renamed = { ...REGISTRY[1], name: "agent-pm2" } as RegistryAgent;
    setAsksForTest({ path, deps: mkDeps(), registry: [renamed, { ...squatter, channelId: "666" } as RegistryAgent], ownerChats: ["api:owner:self"] });
    await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner(), askId: b.id });
    expect(held[1].to).toMatchObject({ channelId: "222", agentName: "agent-pm2" });
  });

  test("P2-2 过期通知：改投派发者时写明原发起方；只能落到大总管的不发", async () => {
    const a = (await reply())!;
    const b = (await reply())!;
    clients.delete("111");
    setAsksForTest({ path, deps: mkDeps(), registry: [REGISTRY[1]], ownerChats: ["api:owner:self"] });
    openLedger(path).run("UPDATE asks SET expiresAt = 1 WHERE id = ?", [a.id]);
    await sweepExpired();
    expect(delivered[0].to).toMatchObject({ agentName: "agent-pm" });
    expect(delivered[0].content).toContain("agent-x（已不在，改投给你）");
    delivered = [];
    setAsksForTest({ path, deps: mkDeps(), registry: [], ownerChats: ["api:owner:self"] });
    openLedger(path).run("UPDATE asks SET expiresAt = 1, extra = '{}' WHERE id = ?", [b.id]);
    await sweepExpired();
    expect(getAsk(openLedger(path), b.id)?.state).toBe("expired");
    expect([...delivered, ...held]).toEqual([]);
  });

  test("P2-4 卡片只选了部分行就提交：结案，答复里写明还有几项没选", async () => {
    const a = (await reply("api:owner:self", [
      { type: "select", id: "model", options: [{ label: "Opus", value: "opus" }] },
      { type: "buttons", buttons: [{ id: "go", label: "开干" }] },
    ]))!;
    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
    expect(getAsk(openLedger(path), a.id)?.state).toBe("answered");
    expect(delivered[0].content.split("\n")[0]).toContain("还有 1 项 owner 没选");
  });

  test("P2-6 关了终端的 owner 设备（role 降成 external）仍能作答；P2-7 /presence 只认 owner 设备", async () => {
    const noTerm = { ...owner({ agents: ["*"], terminal: false, manage: true }), role: "external" as const };
    const a = (await reply())!;
    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"] }, noTerm)).status).toBe(202);
    const post = (who: Principal) => handleAsksApi(new Request("http://x/api/v1/presence", { method: "POST", body: JSON.stringify({ visible: true }) }), "/presence", who);
    expect((await post(LEGACY_STAR_TOKEN))!.status).toBe(403);
    expect((await post(owner()))!.status).toBe(200);
    ownerPresence.setVisible("dev_1", false);
  });
});
