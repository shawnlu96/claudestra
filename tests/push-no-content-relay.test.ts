/**
 * 「推送不带正文」经中继的集成测试（docs/relay/e2e-design.md §6.1 P1a；T21a 的验收口径：进程内集成 + owner 真机检查单）。
 * 真中继（src/relay，带 VAPID）+ 真 relay 客户端 + 真派发器与出口（bridge/push/dispatcher、sender）；推送投到本地 TLS 假推送服务，
 * 再像浏览器那样用订阅私钥解开（push-test-helpers.webPushTestBrowser）。两处逐字节检查：
 *   - 中继看得到的 push 帧 payload（录下客户端发出的帧）；
 *   - 推送服务之后、浏览器解开的正文。
 * APNs 这一路需要真的 p8 和 Apple 的 HTTP/2 服务，这里不起；它的改写由 tests/push-dispatcher.test.ts 逐字节钉住。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, OWNER_CHAT_ID, type Dispatcher } from "../src/bridge/push/dispatcher.ts";
import { createPushSender } from "../src/bridge/push/sender.ts";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.ts";
import { savePushSubscription } from "../src/lib/push-store.ts";
import { connect, type RelayClient } from "../src/lib/relay-client.ts";
import type { PushRequest } from "../src/lib/relay-client-types.ts";
import { markAgentRead } from "../src/lib/unread-store.ts";
import { loadOrCreateVapidKeys } from "../src/lib/web-push.ts";
import { closeWebState, openWebState } from "../src/lib/web-state.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { selfSignedCert, webPushTestBrowser } from "./push-test-helpers.ts";

const SECRETS = ["secretproj", "机密内容", "tok_live_123", "测试机 iPhone", "guest-bob", "ask_42", "发版"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await sleep(20);
  }
}

let relay: Relay;
let pushSrv: ReturnType<typeof Bun.serve>;
let client: RelayClient;
let dispatcher: Dispatcher;
let fp: string;
let hide = true;
let now = 1_790_000_000_000;
const received: Uint8Array[] = [];
const frames: PushRequest[] = [];
const dir = mkdtempSync(join(tmpdir(), "push-no-content-"));
const db = openWebState(":memory:");
let browser: ReturnType<typeof webPushTestBrowser>;

beforeAll(async () => {
  const tls = await selfSignedCert(dir);
  pushSrv = Bun.serve({
    port: 0, hostname: "127.0.0.1", tls,
    async fetch(req) {
      received.push(new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: 201 });
    },
  });
  const vapid = loadOrCreateVapidKeys(join(dir, "vapid.json"));
  relay = createRelay({
    base: "relay.test", port: 0, db: ":memory:", trustProxy: true, log: () => {},
    limits: { authPerIpPerMinute: 1000, idleTimeoutMs: 60_000, pushPerFpPerMinute: 1000 },
    push: { vapid: { ...vapid, subject: "mailto:t@relay.test" }, allowPrivateEndpoints: true, insecureTls: true },
  });
  const key = instanceKeySync(join(dir, "state"))!;
  fp = keyFingerprint(key.publicKey);
  client = connect({ relayUrl: `ws://127.0.0.1:${relay.port}/v1/ws`, key, name: "Mini", slug: "mini", log: () => {} });
  await waitFor(() => client.info().connected && !!client.info().push?.vapidPublicKey);
  // 录下中继看得到的每一帧：发出去的还是真客户端，中继照常加密投递
  const recording = { info: () => client.info(), push: (f: PushRequest) => (frames.push(f), client.push(f)) };
  const sender = createPushSender({ relay: () => recording, direct: () => ({ vapidPublicKey: null, webPush: null, apns: null }) });
  browser = webPushTestBrowser(`https://127.0.0.1:${pushSrv.port}/push/mac`);
  savePushSubscription(db, browser.subscription, "Mozilla/5.0 (Macintosh)");
  dispatcher = createDispatcher({ db, sender, fp, noContent: () => hide, isOwnerChat: (id) => id === OWNER_CHAT_ID, now: () => now, log: () => {} });
});

afterAll(() => {
  dispatcher?.stop();
  client?.close();
  relay?.stop();
  pushSrv?.stop(true);
  closeWebState(":memory:");
});

/** 触发一次，等推送服务收到，返回 [中继看到的帧 payload, 浏览器解开的正文] */
async function roundTrip(fire: () => Promise<unknown>): Promise<[string, Record<string, unknown>]> {
  const [f0, r0] = [frames.length, received.length];
  await fire();
  await waitFor(() => received.length > r0);
  const frame = frames[f0] as { payload: string };
  return [frame.payload, JSON.parse(browser.decrypt(received[r0]))];
}
const leaked = (s: string) => SECRETS.filter((w) => s.includes(w));

describe("推送不带正文：经真中继投到推送服务", () => {
  test("回复：中继看到的帧和浏览器解开的正文都只有「Claudestra · 有新消息」+ 角标 + 时间 + fp", async () => {
    now += 1000;
    const [seen, got] = await roundTrip(() =>
      dispatcher.onEvent({ type: "chat_message", agent: "agent-secretproj", chatId: OWNER_CHAT_ID, data: { direction: "out", text: "机密内容：tok_live_123" } }));
    expect(leaked(seen)).toEqual([]);
    expect(got).toEqual({ fp, title: "Claudestra", body: "有新消息", url: "/chat", tag: `cstra-${now}`, agent: "", ts: now, badge: 1 });
  });

  test("系统提醒（新设备配对）与待你处理：设备名、guest 名、ask id 都不出本机", async () => {
    now += 1000;
    const [s1, g1] = await roundTrip(() => dispatcher.notice({ title: "新设备已配对", body: "「测试机 iPhone」刚配对了这台电脑（给 guest-bob 用）" }));
    now += 1000;
    const ask = { id: "ask_42", fromAgent: "agent-secretproj", title: "发版吗", state: "open", kind: "decide", blocking: true, urgency: "normal" } as never;
    const [s2, g2] = await roundTrip(() => dispatcher.onAsk(ask, "away"));
    for (const s of [s1, s2, JSON.stringify(g1), JSON.stringify(g2)]) expect(leaked(s)).toEqual([]);
    expect(g2).toMatchObject({ fp, title: "Claudestra", body: "有新消息", url: "/chat", agent: "" });
  });

  test("已读 dismiss：只剩 type / ts / badge / fp", async () => {
    now += 1000;
    const [seen, got] = await roundTrip(async () => {
      markAgentRead(db, "secretproj", now);
    });
    expect(leaked(seen)).toEqual([]);
    expect(got).toEqual({ fp, type: "dismiss", ts: now, badge: 0 });
  });

  test("对照：关掉开关，同一条路上解得出正文（证明上面的检查确实看得到内容）", async () => {
    hide = false;
    now += 1000;
    const [seen, got] = await roundTrip(() =>
      dispatcher.onEvent({ type: "chat_message", agent: "agent-secretproj", chatId: OWNER_CHAT_ID, data: { direction: "out", text: "机密内容" } }));
    expect(seen).toContain("机密内容");
    expect(got).toMatchObject({ fp, title: "secretproj", body: "机密内容", agent: "secretproj" });
    hide = true;
  });
});
