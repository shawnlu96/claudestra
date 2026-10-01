/**
 * i28-M11：check_inbox 领 owner 消息、卡片答复（ask_answer）、peer 消息，和 agent 消息同一套租约 / ack / 渲染；
 * owner 和卡片答复排批首；bridge 通知、guest 不领；领走的在租约内 Stop / 扫描不投，ack 才出队并报送达。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, INBOX_LEASE_MS, onHeldSettled, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";

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
let off: () => void = () => {};
beforeEach(() => {
  settled.length = 0;
  off = onHeldSettled((env, outcome) => settled.push(`${env.content}:${outcome}`));
  clearOpenedBy();
});
afterEach(() => off());

function setup(items: HeldItem[]) {
  const held = new HeldQueue(null);
  held.set("c-me", items);
  const mirrored: string[] = [];
  initInbox({
    clients: new Map([["c-me", { ws: me }]]),
    held,
    calls: new AgentCallBook(null),
    render: async (env) => `[来自 ${env.from.kind}]\n${env.content}`,
    emitIn: (_c, env) => mirrored.push(String(env.content)),
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
    expect(s.mirrored).toEqual(["ask1", "o1", "a1", "p1", "a2"]);
    expect(s.contents()).toEqual(["a1", "p1", "n1", "ask1", "g1", "o1", "a2"]); // 领取不出队
    expect(settled).toEqual([]);
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
