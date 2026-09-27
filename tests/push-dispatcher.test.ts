/**
 * 推送派发器（src/bridge/push/dispatcher.ts）的规则，假发送器记账：只推 owner 网页对话的出站回复、Discord 说话算已读、
 * master 不计未读、iOS 不发 dismiss、失效订阅随手清、正文截 180、agent- 前缀剥掉；ownerChatIds 的老 web-ui token 兼容。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ApnsMessage } from "../src/lib/apns.js";
import { listApnsDevices, listPushSubscriptions, saveApnsDevice, savePushSubscription } from "../src/lib/push-store.js";
import { markAgentRead, unreadCounts } from "../src/lib/unread-store.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { createDispatcher, notificationBody, OWNER_CHAT_ID, ownerChatIds, type Dispatcher } from "../src/bridge/push/dispatcher.js";
import type { PushSender, SendOutcome } from "../src/bridge/push/sender.js";

interface Sent { kind: "web" | "apns"; to: string; payload: Record<string, unknown> }
const sent: Sent[] = [];
let outcomes: Record<string, SendOutcome> = {};
let apnsOn = true;
const sender: PushSender = {
  config: () => ({ mode: "direct", webPush: { vapidPublicKey: "K" }, apns: apnsOn }),
  async sendWebPush(sub, payload) {
    sent.push({ kind: "web", to: sub.endpoint, payload: JSON.parse(payload) });
    return outcomes[sub.endpoint] ?? { ok: true, gone: false, status: 201 };
  },
  async sendApns(token, msg: ApnsMessage) {
    sent.push({ kind: "apns", to: token, payload: { ...msg } });
    return outcomes[token] ?? { ok: true, gone: false, status: 200 };
  },
};
const IOS = "https://push.example/ios", MAC = "https://push.example/mac", OLD = "https://push.example/old";
const TOK = "ab".repeat(32);
let db = openWebState(":memory:");
let dispatcher: Dispatcher;
let now = 1_700_000_000_000;
const evt = (over: Partial<{ type: string; agent: string; chatId: string; data: Record<string, unknown> }>) =>
  ({ type: "chat_message", agent: "alpha", chatId: OWNER_CHAT_ID, data: { direction: "out", text: "hello there" }, ...over });
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  closeWebState(":memory:");
  db = openWebState(":memory:");
  sent.length = 0;
  outcomes = {};
  apnsOn = true;
  savePushSubscription(db, { endpoint: IOS, keys: { p256dh: "p", auth: "a" } }, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)");
  savePushSubscription(db, { endpoint: MAC, keys: { p256dh: "p", auth: "a" } }, "Mozilla/5.0 (Macintosh)");
  savePushSubscription(db, { endpoint: OLD, keys: { p256dh: "p", auth: "a" } }, "");
  saveApnsDevice(db, TOK, "iPhone");
  dispatcher = createDispatcher({ db, sender, isOwnerChat: (id) => id === OWNER_CHAT_ID || id === "api:tok_web", now: () => now, log: () => {} });
});
afterEach(() => dispatcher.stop());

describe("出站回复 → 未读 + 推送", () => {
  test("owner 网页对话的回复：未读 +1，三份 Web Push + 一条 APNs，payload 形状与契约一致", async () => {
    await dispatcher.onEvent(evt({}));
    expect(unreadCounts(db)).toEqual({ alpha: 1 });
    const web = sent.filter((s) => s.kind === "web");
    expect(web.map((s) => s.to).sort()).toEqual([IOS, MAC, OLD].sort());
    expect(web[0].payload).toEqual({ title: "alpha", body: "hello there", badge: 1, url: "/chat?agent=alpha", agent: "alpha", ts: now, tag: `cstra-alpha-${now}` });
    const apns = sent.filter((s) => s.kind === "apns");
    expect(apns).toHaveLength(1);
    expect(apns[0].payload).toEqual({ title: "alpha", body: "hello there", agent: "alpha", url: "/chat?agent=alpha", ts: now, tag: `cstra-alpha-${now}`, badge: 1 });
  });
  test("旧 web-ui token 的 chatId 也算 owner；peer / 别的 token / Discord 的出站不推不计", async () => {
    await dispatcher.onEvent(evt({ chatId: "api:tok_web" }));
    expect(unreadCounts(db)).toEqual({ alpha: 1 });
    sent.length = 0;
    await dispatcher.onEvent(evt({ chatId: "api:tok_peer" }));
    await dispatcher.onEvent(evt({ chatId: "123456789" }));
    await dispatcher.onEvent(evt({ data: { direction: "out", text: "x", notice: true } }));
    await dispatcher.onEvent(evt({ type: "assistant_text" }));
    await dispatcher.onEvent(evt({ data: { direction: "out", text: "   " } }));
    expect(sent).toHaveLength(0);
    expect(unreadCounts(db)).toEqual({ alpha: 1 });
  });
  test("master：推送但不计未读（badge = 别人的总数）；agent- 前缀剥掉；正文一行截 180 字", async () => {
    await dispatcher.onEvent(evt({ agent: "agent-beta" }));
    sent.length = 0;
    await dispatcher.onEvent(evt({ agent: "master", data: { direction: "out", text: `a\n\n  b ${"x".repeat(300)}` } }));
    expect(unreadCounts(db)).toEqual({ beta: 1 });
    const web = sent.find((s) => s.kind === "web")!;
    expect(web.payload.agent).toBe("master");
    expect(web.payload.badge).toBe(1);
    expect(String(web.payload.body)).toHaveLength(181);
    expect(String(web.payload.body).startsWith("a b xxx")).toBe(true);
    expect(String(web.payload.body).endsWith("…")).toBe(true);
    expect(notificationBody("short")).toBe("short");
  });
  test("gone → 删订阅 / 设备；其它失败保留", async () => {
    outcomes = { [MAC]: { ok: false, gone: true, status: 410 }, [OLD]: { ok: false, gone: false, status: 500 }, [TOK]: { ok: false, gone: true, status: 410, error: "Unregistered" } };
    await dispatcher.onEvent(evt({}));
    expect(listPushSubscriptions(db).map((s) => s.endpoint).sort()).toEqual([IOS, OLD].sort());
    expect(listApnsDevices(db)).toEqual([]);
  });
  test("APNs 未配置就不查设备表也不发", async () => {
    apnsOn = false;
    await dispatcher.onEvent(evt({}));
    expect(sent.some((s) => s.kind === "apns")).toBe(false);
  });
});

describe("已读联动", () => {
  test("Discord 频道里用户说话 → 标已读：非 iOS 且 UA 非空的订阅收 dismiss（带 badge），原生壳收静默 APNs；未读归零", async () => {
    await dispatcher.onEvent(evt({}));
    await dispatcher.onEvent(evt({ agent: "beta" }));
    sent.length = 0;
    now += 1000;
    await dispatcher.onEvent(evt({ chatId: "987654321", data: { direction: "in", srcKind: "user", text: "看到了" } }));
    await flush();
    expect(unreadCounts(db)).toEqual({ beta: 1 });
    const web = sent.filter((s) => s.kind === "web");
    expect(web.map((s) => s.to)).toEqual([MAC]);
    expect(web[0].payload).toEqual({ type: "dismiss", agent: "alpha", ts: now, badge: 1 });
    const apns = sent.filter((s) => s.kind === "apns");
    expect(apns).toHaveLength(1);
    expect(apns[0].payload).toMatchObject({ silent: true, badge: 1, agent: "alpha", url: "/chat", ts: now, tag: `cstra-badge-${now}` });
  });
  test("Discord 里 bot / agent 的入站不算已读；api 入站不算", async () => {
    await dispatcher.onEvent(evt({}));
    sent.length = 0;
    await dispatcher.onEvent(evt({ chatId: "987654321", data: { direction: "in", srcKind: "agent", text: "x" } }));
    await dispatcher.onEvent(evt({ chatId: OWNER_CHAT_ID, data: { direction: "in", srcKind: "user", text: "x" } }));
    await flush();
    expect(sent).toHaveLength(0);
    expect(unreadCounts(db)).toEqual({ alpha: 1 });
  });
  test("没有未读时的已读（路由 markAgentRead）：只发不带 badge 的 dismiss，不发 APNs", async () => {
    markAgentRead(db, "alpha", now);
    await flush();
    expect(sent).toEqual([{ kind: "web", to: MAC, payload: { type: "dismiss", agent: "alpha", ts: now } }]);
  });
});

describe("ownerChatIds", () => {
  test("owner:self 永远在；名为 web-ui、未禁用、非 peer 的 token 也算", () => {
    const ids = ownerChatIds({ principals: [
      { id: "token:tok_web", role: "external", name: "web-ui", agents: ["*"], createdAt: "" },
      { id: "token:tok_old", role: "external", name: "web-ui", agents: ["*"], createdAt: "", disabled: true },
      { id: "token:tok_peer", role: "external", name: "web-ui", agents: ["*"], createdAt: "", peer: "other" },
      { id: "token:tok_x", role: "external", name: "phone", agents: ["*"], createdAt: "" },
    ] });
    expect([...ids].sort()).toEqual(["api:owner:self", "api:tok_web"]);
    expect([...ownerChatIds({ principals: [] })]).toEqual([OWNER_CHAT_ID]);
  });
});
