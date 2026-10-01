/**
 * i28-M11：check_inbox 领 owner 消息、卡片答复（ask_answer）、peer 消息，和 agent 消息同一套租约 / ack / 渲染；
 * owner 和卡片答复排批首；bridge 通知、guest 不领；领走的在租约内 Stop / 扫描不投，ack 才出队并报送达。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, INBOX_LEASE_MS, onHeldSettled, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { withInterruptNote } from "../src/lib/turn-cuts.js";

const me = { tag: "claudestra-ws" } as never;
const to = { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me } as LocalEndpoint;
const OWNER_API: Envelope["from"] = { kind: "api", tokenId: "owner:self", name: "owner", owner: true };

function mk(content: string, from: Envelope["from"], meta: Partial<Envelope["meta"]> = {}, intent: Envelope["intent"] = "request"): HeldItem {
  const env = { from, to, intent, content, meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-10-01T00:00:00Z", threadId: `thr-${content}`, ...meta } } as Envelope;
  return { env, to, heldAt: 0 };
}
const agent = (c: string) => mk(c, { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws: me });
const peer = (c: string) => mk(c, { kind: "api", tokenId: "tok-p", name: "He", peer: "He" });
const owner = (c: string) => mk(c, { kind: "user", userId: "u1", channelId: "c-me", username: "owner" });
const ask = (c: string) => mk(c, OWNER_API, { triggerKind: "ask_answer", waitForIdle: true, askId: "ask_1" }, "response");
const bridgeNote = (c: string) => mk(c, { kind: "bridge", label: "ledger" }, { triggerKind: "bridge_synth", waitForIdle: true }, "notification");
const guest = (c: string) => mk(c, { kind: "api", tokenId: "tok-g", name: "guest" });

const settled: string[] = [];
const events: BridgeEvent[] = [];
let off: (() => void)[] = [];
beforeEach(() => {
  settled.length = 0;
  events.length = 0;
  off = [onHeldSettled((env, outcome) => settled.push(`${env.content}:${outcome}`)), subscribeEvents({}, (e) => e.chatId === "c-me" && events.push(e))];
  clearOpenedBy();
});
afterEach(() => off.forEach((f) => f()));

function setup(items: HeldItem[], stoppedAt: (c: string) => number | undefined = () => undefined) {
  const held = new HeldQueue(null);
  held.set("c-me", items);
  const mirrored: string[] = [];
  initInbox({
    clients: new Map([["c-me", { ws: me }]]),
    held,
    calls: new AgentCallBook(null),
    // 和 bridge.ts renderContentForLocal 一样：叫停抬头（interruptNote）放在正文前
    render: async (env) => (env.meta.interruptNote ? withInterruptNote : (t: string) => t)(`[来自 ${env.from.kind}]\n${env.content}`, env.meta.interruptNote!),
    emitIn: (_c, env) => mirrored.push(String(env.content)),
    stoppedAt,
  });
  return { held, mirrored, contents: () => (held.get("c-me") ?? []).map((i) => String(i.env.content)) };
}
const take = async (now: number, opts: Parameters<typeof takeInbox>[2] = {}) => {
  const r = await takeInbox(me, now, opts);
  if ("error" in r) throw new Error(r.error);
  return r.result;
};
const batchOf = (text: string) => /inbox_[\w-]+/.exec(text)![0];

describe("check_inbox 领全部押后消息", () => {
  test("agent / peer / owner / 卡片答复都领，owner 和卡片答复排批首（各自保持到达顺序）；bridge 通知和 guest 不领", async () => {
    const s = setup([agent("a1"), peer("p1"), bridgeNote("n1"), ask("ask1"), guest("g1"), owner("o1"), agent("a2")]);
    const r = await take(60_000);
    expect(r.n).toBe(5);
    const order = [...r.text.matchAll(/message_id=m-(\w+)/g)].map((m) => m[1]);
    expect(order).toEqual(["ask1", "o1", "a1", "p1", "a2"]);
    expect(r.text).toContain("来自 owner 的卡片答复 · message_id=m-ask1");
    expect(r.text).toContain("来自 owner · message_id=m-o1");
    expect(r.text).toContain("来自 peer He · message_id=m-p1");
    expect(r.text).toContain("[来自 api]\nask1"); // 正文走和正常投递同一个 render
    expect(s.mirrored).toEqual(["a1", "a2"]); // 本机 agent 的照旧走 emitIn
    expect(events.map((e) => [e.type, e.agent, (e.data as { text: string }).text])).toEqual([
      ["chat_message", "agent-claudestra", "ask1"], ["chat_message", "agent-claudestra", "o1"], ["chat_message", "agent-claudestra", "p1"],
    ]);
    expect(s.contents()).toEqual(["a1", "p1", "n1", "ask1", "g1", "o1", "a2"]); // 领取不出队
    expect(settled).toEqual([]);
  });

  test("inbox-reply-route：owner / 卡片答复 / peer 每条带正常投递同一规则的回程 chat_id；agent 的抬头不变", async () => {
    setup([agent("a1"), peer("p1"), ask("ask1"), owner("o1")]);
    const r = await take(60_000);
    expect(r.text).toContain("来自 peer He · message_id=m-p1 · 排队 1 分钟 · 回复用 reply，chat_id=api:tok-p ──");
    expect(r.text).toContain("message_id=m-ask1 · 排队 1 分钟 · 回复用 reply，chat_id=api:owner:self ──");
    expect(r.text).toContain("message_id=m-o1 · 排队 1 分钟 · 回复用 reply，chat_id=c-me ──");
    expect(r.text).toContain("来自 agent-codex · message_id=m-a1 · 排队 1 分钟 ──");
    const id = "m-long-peer";
    setup([mk("y".repeat(20_000), { kind: "api", tokenId: "tok-p", name: "He", peer: "He" }, { messageId: id })]);
    expect((await take(1_000, { read: id })).text).toContain("chat_id=api:tok-p"); // 分页读第 1 页带着抬头
  });

  test("inbox-stop-note：叫停之前押下的 owner 卡片答复 / agent 请求，领取时和补投一样加「先别照做」抬头；叫停之后押的不加", async () => {
    const before = { ...ask("ask-before"), heldAt: 1_000 };
    const after = { ...ask("ask-after"), heldAt: 3_000 };
    const req = { ...agent("a-before"), heldAt: 1_000 };
    const s = setup([before, after, req], (c) => (c === "c-me" ? 2_000 : undefined));
    const r = await take(4_000);
    const part = (id: string) => r.text.split("── ").find((x) => x.includes(`message_id=m-${id} `))!;
    expect(part("ask-before")).toContain("先别照做");
    expect(part("a-before")).toContain("先别照做");
    expect(part("ask-after")).not.toContain("先别照做");
    expect(s.held.get("c-me")!.find((i) => i.env.content === "ask-before")!.env.meta.interruptNote).toBeTruthy(); // 之后再补投也不重复加
  });

  test("inbox-web-echo：卡片答复领取后的入站镜像带 askId / wire 回声和附件，和「排队中」标记同一 agent 名", async () => {
    const a = ask("[owner 回复了你的「待你处理」] 选择：部署");
    a.env.meta.askEcho = { askId: "ask_review", echo: "部署", wire: "[button:deploy]" } as never;
    a.env.meta.attachments = ["/tmp/a.png"];
    setup([a]);
    await take(1_000);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ agent: "agent-claudestra", type: "chat_message" });
    expect(events[0].data).toMatchObject({ direction: "in", from: "owner", fromId: "api:owner:self", srcKind: "api", askId: "ask_review", wire: "[button:deploy]", attachments: ["/tmp/a.png"] });
  });

  test("ack 才出队并报送达；不 ack 再调原样重给；租约过期后可重领", async () => {
    const s = setup([peer("p1"), ask("ask1")]);
    const first = await take(1_000);
    const again = await take(2_000);
    expect(again.text).toContain(`收件箱 ${batchOf(first.text)}：2 条。这是你领过还没确认的一批`);
    expect(s.contents()).toEqual(["p1", "ask1"]);
    const relet = await take(1_000 + INBOX_LEASE_MS + 1);
    expect(relet.n).toBe(2);
    expect(batchOf(relet.text)).not.toBe(batchOf(first.text));
    const acked = await take(1_000 + INBOX_LEASE_MS + 2, { ack: batchOf(relet.text) });
    expect(acked.text).toContain("2 条出队");
    expect(s.contents()).toEqual([]);
    expect(settled.sort()).toEqual(["ask1:delivered", "p1:delivered"]);
  });

  test("分页读一条长的 owner 消息：打租约、ack 出队", async () => {
    const s = setup([mk("x".repeat(20_000), { kind: "user", userId: "u1", channelId: "c-me", username: "owner" }, { messageId: "m-long" })]);
    const id = "m-long";
    const r = await take(1_000, { read: id });
    expect(r.text).toContain(`message_id=${id} 第 1/2 页`);
    await take(2_000, { ack: /ack: "(inbox_[\w-]+)"/.exec(r.text)![1] });
    expect(s.contents()).toEqual([]);
  });

  test("领走的 owner 消息 / 卡片答复：租约内目标忙时扫描不投（不会投两遍），租约过期后照投", async () => {
    const s = setup([owner("o1"), ask("ask1")]);
    await take(Date.now());
    const delivered: string[] = [];
    const deps: FlushDeps = {
      held: s.held,
      compacting: () => false,
      working: async () => true,
      isHumanRequest: (env) => env.from.kind === "user" && env.intent === "request",
      client: () => ({ ws: me }),
      deliver: async (env) => (delivered.push(String(env.content)), { envelope: env, outcome: { kind: "sent" } }),
      touch: () => {},
      now: () => 10 * 60_000, // 两条都押满了 owner 时限
    };
    await flushHeld(deps, "c-me", "sweep");
    expect(delivered).toEqual([]);
    for (const i of s.held.get("c-me")!) i.lease!.at -= INBOX_LEASE_MS + 1;
    await flushHeld(deps, "c-me", "sweep");
    expect(delivered).toEqual(["o1"]); // Discord owner 和网页 owner 算两个发送人：一轮只投一个人的（跨 principal 规则不变）
    await flushHeld(deps, "c-me", "sweep");
    expect(delivered).toEqual(["o1", "ask1"]);
  });
});
