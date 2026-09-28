/** 推送订阅（src/lib/push-store.ts）与未读 / 已读（src/lib/unread-store.ts）两个存取模块，:memory: 库 */
import { afterEach, describe, expect, test } from "bun:test";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import {
  deleteApnsDevice, deletePushSubscription, dismissSafe, listApnsDevices, listPushSubscriptions, pruneLegacyApnsDevices, saveApnsDevice, savePushSubscription, setPushSubscriptionKey,
} from "../src/lib/push-store.js";
import { bumpUnread, countsUnread, markAgentRead, onAgentRead, pruneUnread, readMarks, totalUnread, unreadCounts, unreadOrphans, type ReadEvent } from "../src/lib/unread-store.js";

const fresh = () => {
  closeWebState(":memory:");
  return openWebState(":memory:");
};
afterEach(() => closeWebState(":memory:"));
const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p-${n}`, auth: `a-${n}` } });

describe("push-store", () => {
  test("订阅 upsert（同 endpoint 换密钥 / UA）、列出、删除；坏 keys 行跳过", () => {
    const db = fresh();
    savePushSubscription(db, sub("a"), "Mozilla iPhone", null, new Date("2026-01-01T00:00:00Z"));
    savePushSubscription(db, sub("b"), "Mozilla Mac");
    savePushSubscription(db, { ...sub("a"), keys: { p256dh: "new", auth: "new" } }, "Mozilla Mac");
    db.prepare("INSERT INTO push_subscriptions (endpoint, keys, ua, created_at) VALUES (?, ?, ?, ?)").run("https://x/bad", "{not json", "", "");
    const rows = listPushSubscriptions(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.endpoint.endsWith("/a"))).toEqual({
      endpoint: "https://push.example/a", keys: { p256dh: "new", auth: "new" }, ua: "Mozilla Mac", vapidKey: null, audience: "owner", principal: null, credential: null,
    });
    expect(deletePushSubscription(db, "https://push.example/a")).toBe(true);
    expect(deletePushSubscription(db, "https://push.example/a")).toBe(false);
    expect(listPushSubscriptions(db)).toHaveLength(1);
  });
  test("订阅记着 VAPID 公钥：登记时写、重订覆盖、投成功后改正", () => {
    const db = fresh();
    savePushSubscription(db, sub("a"), "ua", "RELAY");
    expect(listPushSubscriptions(db)[0].vapidKey).toBe("RELAY");
    savePushSubscription(db, sub("a"), "ua", "OWN");
    expect(listPushSubscriptions(db)[0].vapidKey).toBe("OWN");
    setPushSubscriptionKey(db, sub("a"), "RELAY");
    expect(listPushSubscriptions(db)[0].vapidKey).toBe("RELAY");
    // 发送途中被重新订阅（密钥变了）：旧投递结果不覆盖新登记
    savePushSubscription(db, { ...sub("a"), keys: { p256dh: "re", auth: "re" } }, "ua", "OWN");
    setPushSubscriptionKey(db, sub("a"), "RELAY");
    expect(listPushSubscriptions(db)[0].vapidKey).toBe("OWN");
  });
  test("dismissSafe：UA 为空或 iOS 的不发 dismiss", () => {
    expect(dismissSafe({ ...sub("x"), ua: "", vapidKey: null, audience: "owner", principal: null, credential: null })).toBe(false);
    expect(dismissSafe({ ...sub("x"), ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", vapidKey: null, audience: "owner", principal: null, credential: null })).toBe(false);
    expect(dismissSafe({ ...sub("x"), ua: "Mozilla/5.0 (iPad; CPU OS 17_0)", vapidKey: null, audience: "owner", principal: null, credential: null })).toBe(false);
    expect(dismissSafe({ ...sub("x"), ua: "Mozilla/5.0 (Macintosh)", vapidKey: null, audience: "owner", principal: null, credential: null })).toBe(true);
  });
  test("APNs 设备：token 小写存、upsert 刷 last_seen、删除", () => {
    const db = fresh();
    saveApnsDevice(db, "AB".repeat(32), "iPhone", new Date("2026-01-01T00:00:00Z"));
    saveApnsDevice(db, "ab".repeat(32), "iPhone 2", new Date("2026-01-02T00:00:00Z"));
    expect(listApnsDevices(db)).toEqual([{ token: "ab".repeat(32), principal: null, credential: null }]);
    expect(db.prepare("SELECT device, created_at, last_seen FROM apns_devices").get()).toEqual({ device: "iPhone 2", created_at: "2026-01-01T00:00:00.000Z", last_seen: "2026-01-02T00:00:00.000Z" });
    expect(deleteApnsDevice(db, "AB".repeat(32))).toBe(true);
    expect(listApnsDevices(db)).toEqual([]);
  });
  test("没记凭据的 APNs 老行超过 7 天没重新登记就清掉；记了凭据的、7 天内的留着（adv2 P2-4）", () => {
    const db = fresh();
    const now = new Date("2026-10-10T00:00:00Z");
    const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600_000);
    saveApnsDevice(db, "aa".repeat(32), "旧", daysAgo(8));
    saveApnsDevice(db, "bb".repeat(32), "旧但刚见过", daysAgo(6));
    saveApnsDevice(db, "cc".repeat(32), "新", daysAgo(30), { audience: "owner", principal: "owner:self", credential: "dev_1" });
    expect(pruneLegacyApnsDevices(db, now)).toBe(1);
    expect(listApnsDevices(db).map((r) => r.token).sort()).toEqual(["bb".repeat(32), "cc".repeat(32)]);
  });
});

describe("unread-store", () => {
  test("bump 返回全局总数；counts 只含 >0；master 不计", () => {
    const db = fresh();
    expect(bumpUnread(db, "alpha", 1)).toBe(1);
    expect(bumpUnread(db, "alpha", 2)).toBe(2);
    expect(bumpUnread(db, "beta", 3)).toBe(3);
    expect(unreadCounts(db)).toEqual({ alpha: 2, beta: 1 });
    expect(totalUnread(db)).toBe(3);
    expect(countsUnread("master")).toBe(false);
    expect(countsUnread("")).toBe(false);
    expect(countsUnread("alpha")).toBe(true);
  });
  test("markAgentRead：落 push_read（ISO 读出）、归零、通知监听器带 hadUnread；agent- 前缀剥掉", () => {
    const db = fresh();
    const seen: ReadEvent[] = [];
    const off = onAgentRead((e) => seen.push(e));
    bumpUnread(db, "alpha", 1);
    expect(markAgentRead(db, "agent-alpha", 1700000000000)).toEqual({ agent: "alpha", ts: 1700000000000, hadUnread: true });
    expect(markAgentRead(db, "alpha", 1700000001000)).toEqual({ agent: "alpha", ts: 1700000001000, hadUnread: false });
    expect(unreadCounts(db)).toEqual({});
    expect(readMarks(db)).toEqual({ alpha: "2023-11-14T22:13:21.000Z" });
    expect(seen).toHaveLength(2);
    off();
    markAgentRead(db, "alpha");
    expect(seen).toHaveLength(2);
  });
  test("监听器抛错不影响落库与其它监听器", () => {
    const db = fresh();
    const seen: string[] = [];
    const off1 = onAgentRead(() => { throw new Error("boom"); });
    const off2 = onAgentRead((e) => seen.push(e.agent));
    markAgentRead(db, "x", 5);
    expect(seen).toEqual(["x"]);
    expect(readMarks(db)).toEqual({ x: new Date(5).toISOString() });
    off1(); off2();
  });
  test("unreadOrphans / pruneUnread：不在列表里的与 master 删掉；真有未读的按已读事件通知", () => {
    const db = fresh();
    expect(unreadOrphans([{ agent: "a", count: 1 }, { agent: "master", count: 4 }, { agent: "gone", count: 0 }], ["agent-a", "b"])).toEqual({ agents: ["master", "gone"], hadUnread: true });
    bumpUnread(db, "a", 1); bumpUnread(db, "master", 1); bumpUnread(db, "gone", 1);
    db.prepare("INSERT INTO agent_unread (agent, count, last_reply_ts) VALUES ('zero', 0, 0)").run();
    const seen: ReadEvent[] = [];
    const off = onAgentRead((e) => seen.push(e));
    expect(pruneUnread(db, [], 9)).toEqual({ agents: [], hadUnread: false }); // 空列表不动
    expect(pruneUnread(db, ["a"], 9)).toEqual({ agents: ["master", "gone", "zero"], hadUnread: true });
    expect(unreadCounts(db)).toEqual({ a: 1 });
    expect(seen.map((e) => e.agent).sort()).toEqual(["gone", "master"]);
    expect(seen.every((e) => e.hadUnread && e.ts === 9)).toBe(true);
    off();
  });
});
