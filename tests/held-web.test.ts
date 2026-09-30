/**
 * 人发的消息被押在对方这一轮之后：bridge 发 chat_held（src/bridge/held-web.ts，HeldQueue 新入队 / 作罢时），
 * 网页翻成 user-in + held（lib/chat/stream-shape.ts），在那条气泡下标「排队中」，真送达的回声 / 作罢摘掉（features/chat/held-echo.ts）。
 * owner 2026-10-01：一条按钮答复排了 19 分钟，网页上和已送达的一模一样。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { subscribeEvents, type BridgeEvent as BusEvent } from "../src/bridge/event-bus.js";
import { heldEventData } from "../src/bridge/held-web.js";
import { ageHeld, HELD_GIVE_UP_MS, HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope } from "../src/bridge/router.js";
import { translate, type BridgeEvent } from "@/lib/chat/stream-shape";
import { claimEcho, findEchoTarget } from "@/features/chat/held-echo";
import { PENDING_KEEP_MS, survivingPending } from "@/features/chat/view-compose";
import type { ChatMessage } from "@/features/chat/type";

const ws = { send: () => undefined } as never;
const to = { kind: "local", agentName: "agent-a", channelId: "c-a", ws } as const;
const env = (from: Envelope["from"], content: string, meta: Partial<Envelope["meta"]> = {}): Envelope =>
  ({ from, to, intent: "request", content, meta: { messageId: `m-${content}`, triggerKind: "system", ts: "t", threadId: "thr", ...meta } }) as Envelope;
const owner = { kind: "api", tokenId: "owner:self", name: "owner", owner: true } as Envelope["from"];
const agent = { kind: "local", agentName: "agent-b", channelId: "c-b", ws } as Envelope["from"];

const seen: BusEvent[] = [];
const stop = subscribeEvents({ agent: "agent-a" }, (e) => void (e.type === "chat_held" && seen.push(e)));
afterAll(stop);

describe("bridge：押后队列报给网页", () => {
  test("人发的新入队报 queued（负载同入站镜像）；flush 押回同一封不再报；agent 发的不报", () => {
    seen.length = 0;
    const q = new HeldQueue(null);
    const e = env(owner, "继续");
    q.holdEnv(e);
    q.holdEnv(e);
    q.holdEnv(env(agent, "复核"));
    expect(seen.map((x) => [x.chatId, x.data.state, x.data.text, x.data.srcKind, x.data.fromId])).toEqual([["c-a", "queued", "继续", "api", "api:owner:self"]]);
    expect(heldEventData(env(agent, "x"), "queued")).toBeNull();
  });

  test("目标被 kill / 押满 24 小时放弃报 dropped", () => {
    seen.length = 0;
    const q = new HeldQueue(null);
    q.holdEnv(env(owner, "一"));
    q.discard("c-a");
    q.hold("c-a", { env: env({ kind: "user", userId: "u1", channelId: "d1", username: "he" }, "二"), to, heldAt: 0 });
    ageHeld(q, HELD_GIVE_UP_MS + 1);
    expect(seen.map((x) => `${x.data.text}:${x.data.state}`)).toEqual(["一:queued", "一:dropped", "二:queued", "二:dropped"]);
  });
});

const ev = (type: string, data: Record<string, unknown>): BridgeEvent => ({ seq: 1, ts: "t", agent: "agent-a", chatId: "c-a", type, data });
const self = new Set(["api:owner:self"]);
const inData = (text: string, extra: Record<string, unknown> = {}) => ({ srcKind: "api", from: "owner", fromId: "api:owner:self", text, ...extra });

describe("网页：chat_held → user-in + held", () => {
  test("本人的押着 / 作罢照入站镜像翻译；外源的、不认识的 state 不翻（外源回声不去重，标了会多画一条）", () => {
    expect(translate(ev("chat_held", { ...inData("继续"), state: "queued" }), "zh", self)).toEqual({ t: "user-in", text: "继续", held: "queued" });
    expect(translate(ev("chat_held", { ...inData("继续"), state: "dropped" }), "zh", self)).toMatchObject({ held: "dropped" });
    expect(translate(ev("chat_held", { ...inData("继续"), from: "peer-x", fromId: "api:peer", state: "queued" }), "zh", self)).toBeNull();
    expect(translate(ev("chat_held", { ...inData("继续"), state: "delivered" }), "zh", self)).toBeNull();
  });
  test("按钮作答：按原文 wire 对账", () => {
    const e = translate(ev("chat_held", { ...inData("答复正文", { askId: "ask_1", echo: "✅ 发版", wire: "[button:go]" }), state: "queued" }), "zh", self);
    expect(e).toMatchObject({ t: "user-in", text: "✅ 发版", wire: "[button:go]", askId: "ask_1", held: "queued" });
  });
});

/** chat-store addRemoteUserMessage 的对账：有回声就认领，没有就画一条（押着的带 queued） */
function remote(list: ChatMessage[], text: string, held?: "queued" | "dropped"): ChatMessage[] {
  const hit = findEchoTarget(list, text, undefined, undefined, held);
  if (hit) claimEcho(hit, text, undefined, held);
  else if (held !== "dropped") list.push({ id: `ru_${list.length}`, role: "user", content: text, ...(held ? { queued: true } : {}) });
  return list;
}

describe("网页：气泡上的排队标记", () => {
  test("乐观气泡：押着标 queued，送达回声摘掉，不多画", () => {
    const list: ChatMessage[] = [{ id: "l1", role: "user", content: "继续", local: true }];
    remote(list, "继续", "queued");
    expect(list).toHaveLength(1);
    expect(list[0].queued).toBe(true);
    remote(list, "继续");
    expect(list).toHaveLength(1);
    expect(list[0].queued).toBeUndefined();
  });
  test("作罢摘掉排队和额度闸的「押着」；这端没画过的作罢不补画", () => {
    const list: ChatMessage[] = [{ id: "l1", role: "user", content: "停", local: true, held: true }];
    remote(list, "停", "queued");
    remote(list, "停", "dropped");
    expect(list[0]).toMatchObject({ queued: undefined, held: undefined });
    expect(remote([], "别的", "dropped")).toEqual([]);
  });
  test("另一台设备：押着先画出来带 queued，送达回声认领同一条", () => {
    const list = remote([], "继续", "queued");
    expect(list[0].queued).toBe(true);
    remote(list, "继续");
    expect(list.map((m) => [m.id, m.queued])).toEqual([["ru_0", undefined]]);
  });
  test("同一句话两遍：押着落在最新那条，送达先摘还排着的", () => {
    const list: ChatMessage[] = [{ id: "h1", role: "user", content: "继续" }, { id: "l2", role: "user", content: "继续", local: true }];
    remote(list, "继续", "queued");
    expect(list.map((m) => !!m.queued)).toEqual([false, true]);
    remote(list, "继续");
    expect(list.map((m) => !!m.queued)).toEqual([false, false]);
  });
  test("排队中的乐观气泡过了 30 分钟也不丢（一轮能跑几个小时）", () => {
    const at = Date.parse("2026-10-01T00:00:00Z");
    const q: ChatMessage = { id: "l1", role: "user", content: "排着的", local: true, queued: true, ts: new Date(at).toISOString() };
    const plain: ChatMessage = { ...q, id: "l2", content: "普通的", queued: undefined };
    expect(survivingPending([q, plain], [], at + PENDING_KEEP_MS + 60_000).map((m) => m.id)).toEqual(["l1"]);
  });
});
