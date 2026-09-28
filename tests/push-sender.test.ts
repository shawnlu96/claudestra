/**
 * 推送出口的 Web Push 选路（src/bridge/push/sender.ts）：订阅只认订它时的 VAPID 公钥——中继公钥的走中继、本机公钥的直发；
 * 不知道钥匙的老订阅先中继后直发，只有 401/403（钥匙对不上）才换路，投成功报回用的那把；gone / 其它错误不换路（免得重复投）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { PushAck, PushRequest } from "../src/lib/relay-client.js";
import { createPushSender, type PushSender } from "../src/bridge/push/sender.js";

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "p", auth: "a" } };
let relayOnline = true;
let relayAck: PushAck = { ok: true, status: 201 };
let directStatus = 201;
const calls: { via: "relay" | "direct"; sub: unknown }[] = [];

const relay = {
  info: () => ({ connected: relayOnline, push: { vapidPublicKey: "RELAY", apns: false } }),
  push: async (req: PushRequest): Promise<PushAck> => {
    calls.push({ via: "relay", sub: req.kind === "webpush" ? req.subscription : null });
    return relayAck;
  },
};
let sender: PushSender;
beforeEach(() => {
  relayOnline = true;
  relayAck = { ok: true, status: 201 };
  directStatus = 201;
  calls.length = 0;
  sender = createPushSender({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relay: () => relay as any,
    direct: () => ({
      vapidPublicKey: "OWN",
      webPush: async (sub) => {
        calls.push({ via: "direct", sub });
        return directStatus;
      },
      apns: null,
    }),
  });
});

describe("Web Push 按订阅的公钥选路", () => {
  test("中继公钥的订阅只走中继；本机公钥的只直发；投成功报回用的公钥", async () => {
    expect(await sender.sendWebPush({ ...SUB, vapidKey: "RELAY" }, "{}")).toMatchObject({ ok: true, vapidKey: "RELAY" });
    expect(calls.map((c) => c.via)).toEqual(["relay"]);
    calls.length = 0;
    expect(await sender.sendWebPush({ ...SUB, vapidKey: "OWN" }, "{}")).toMatchObject({ ok: true, vapidKey: "OWN" });
    expect(calls.map((c) => c.via)).toEqual(["direct"]);
  });
  test("不知道钥匙：中继 403 → 直发成功，报回本机公钥（今天的老订阅就是这样救回来的）", async () => {
    relayAck = { ok: false, status: 403, error: "upstream_error" };
    expect(await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}")).toMatchObject({ ok: true, status: 201, vapidKey: "OWN" });
    expect(calls.map((c) => c.via)).toEqual(["relay", "direct"]);
  });
  test("记着的钥匙错了（403）也会换另一把；两把都 403 就报最后一次失败", async () => {
    directStatus = 403;
    relayAck = { ok: true, status: 201 };
    expect(await sender.sendWebPush({ ...SUB, vapidKey: "OWN" }, "{}")).toMatchObject({ ok: true, vapidKey: "RELAY" });
    expect(calls.map((c) => c.via)).toEqual(["direct", "relay"]);
    calls.length = 0;
    relayAck = { ok: false, status: 403, error: "upstream_error" };
    const r = await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}");
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(r.vapidKey).toBeUndefined();
  });
  test("gone / 5xx / 中继自己的拒绝不换路（没被推送服务拒签名，换路可能重复投）", async () => {
    relayAck = { ok: false, status: 410, gone: true };
    expect(await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}")).toMatchObject({ ok: false, gone: true });
    relayAck = { ok: false, status: 500, error: "upstream_error" };
    await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}");
    relayAck = { ok: false, error: "rate_limited" };
    await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}");
    relayAck = { ok: false, status: 403, error: "some_future_relay_refusal" }; // 中继自己的 403 不是推送服务拒签名
    await sender.sendWebPush({ ...SUB, vapidKey: null }, "{}");
    expect(calls.map((c) => c.via)).toEqual(["relay", "relay", "relay", "relay"]);
  });
  test("中继离线：只剩直发；webPushKeys 中继在前、离线时只剩本机", async () => {
    expect(sender.webPushKeys()).toEqual(["RELAY", "OWN"]);
    relayOnline = false;
    expect(sender.webPushKeys()).toEqual(["OWN"]);
    await sender.sendWebPush({ ...SUB, vapidKey: "RELAY" }, "{}");
    expect(calls.map((c) => c.via)).toEqual(["direct"]);
  });
  test("直发前也验 endpoint（存量订阅没经过登记检查）：私网地址不发", async () => {
    const r = await sender.sendWebPush({ endpoint: "https://10.0.0.8/push", keys: SUB.keys, vapidKey: "OWN" }, "{}");
    expect(r).toMatchObject({ ok: false, error: "endpoint_forbidden" });
    expect(calls).toEqual([]);
  });
  test("交给后端的只有 endpoint + keys，本地字段（vapidKey / ua）不进 push 帧", async () => {
    await sender.sendWebPush({ ...SUB, vapidKey: "RELAY", ua: "Mozilla" } as never, "{}");
    expect(calls[0].sub).toEqual(SUB);
  });
});
