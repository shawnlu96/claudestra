/** 外部通知渠道的纯逻辑（src/lib/notify-channels.ts）：配置校验与密钥沿用、对外视图不漏密钥、ntfy / Bark / Webhook 的请求形状、签名、点开链接 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  buildRequest, channelView, normalizeChannel, normalizeFile, openLink, redactMessage, webhookSignature,
  type NotifyChannel, type NotifyMessage,
} from "../src/lib/notify-channels.js";

const NTFY = { id: "ntfy0001", kind: "ntfy", topic: "cstra-abc", token: "tk_secret1234" };
const BARK = { id: "bark0001", kind: "bark", deviceKey: "AbCdEf123456" };
const HOOK = { id: "hook0001", kind: "webhook", url: "https://hooks.example.com/x/TOKENzz99", secret: "s3cret-key" };
const msg = (over: Partial<NotifyMessage> = {}): NotifyMessage => ({
  type: "ask", title: "待你处理 · agent-x", body: "要不要发版？", url: "https://relay.example/chat?ask=a1&fp=f", tag: "cstra-ask-a1-open", ts: 1_790_000_000_000, ...over,
});
const ok = (c: NotifyChannel | string): NotifyChannel => {
  if (typeof c === "string") throw new Error(c);
  return c;
};

describe("normalizeChannel", () => {
  test("ntfy 缺省：公共服务器、待你处理 + 安全 + 系统、在不在都推、带正文", () => {
    const c = ok(normalizeChannel({ kind: "ntfy", topic: "t1" }));
    expect(c).toMatchObject({ kind: "ntfy", server: "https://ntfy.sh", topic: "t1", types: ["ask", "security", "system"], onlyWhenAway: false, hideContent: false, enabled: true });
    expect(c.id).toMatch(/^[a-z0-9]{8,24}$/);
  });
  test("「全部待你处理都推」缺省开（没有这个字段的旧配置也按开算）；关了以后不回传就沿用，对外视图带着它", () => {
    const fresh = ok(normalizeChannel({ id: "ntfy0002", kind: "ntfy", topic: "t1" }));
    expect(fresh.allAsks).toBe(true);
    const off = ok(normalizeChannel({ id: "ntfy0002", kind: "ntfy", topic: "t1", allAsks: false }, fresh));
    expect(off.allAsks).toBe(false);
    expect(ok(normalizeChannel({ id: "ntfy0002", kind: "ntfy", topic: "t1", name: "手机" }, off)).allAsks).toBe(false);
    expect(channelView(off)).toMatchObject({ allAsks: false });
  });
  test("不合法的拒掉：topic 带空格、地址带账号密码、Bark 没 key、Webhook 没地址、未知类型", () => {
    expect(normalizeChannel({ kind: "ntfy", topic: "a b" })).toBeString();
    expect(normalizeChannel({ kind: "ntfy", topic: "t", server: "https://u:p@ntfy.example" })).toBeString();
    expect(normalizeChannel({ kind: "bark" })).toBeString();
    expect(normalizeChannel({ kind: "webhook", url: "ftp://x" })).toBeString();
    expect(normalizeChannel({ kind: "ntfy", topic: "t", types: ["ask", "everything"] })).toBeString();
    expect(normalizeChannel({ kind: "slack" })).toBeString();
  });
  test("密钥不传沿用同 id 旧值，空串清除；换了类型不沿用", () => {
    const prev = ok(normalizeChannel(NTFY));
    expect(ok(normalizeChannel({ id: "ntfy0001", kind: "ntfy", topic: "cstra-abc", name: "手机" }, prev))).toMatchObject({ token: "tk_secret1234", name: "手机" });
    expect(ok(normalizeChannel({ id: "ntfy0001", kind: "ntfy", topic: "cstra-abc", token: "" }, prev))).not.toHaveProperty("token");
    expect(normalizeChannel({ id: "ntfy0001", kind: "bark" }, prev)).toBeString();
  });
});

describe("normalizeFile", () => {
  test("按 id 对上旧渠道沿用密钥；重复 id、超过 10 个拒；openUrl 空串清除", () => {
    const prev = { channels: [ok(normalizeChannel(BARK))], openUrl: "https://ts.example" };
    const next = normalizeFile({ channels: [{ id: "bark0001", kind: "bark", name: "iPhone" }], openUrl: "" }, prev);
    expect(next).toEqual({ channels: [expect.objectContaining({ deviceKey: "AbCdEf123456", name: "iPhone" })] });
    expect(normalizeFile({ channels: [BARK, BARK] }, { channels: [] })).toBeString();
    expect(normalizeFile({ channels: Array.from({ length: 11 }, () => ({ kind: "ntfy", topic: "t" })) }, { channels: [] })).toBeString();
  });
});

describe("channelView", () => {
  test("密钥字段不出现，只给尾四位；webhook 地址只露主机", () => {
    const views = [NTFY, BARK, HOOK].map((x) => channelView(ok(normalizeChannel(x))));
    const text = JSON.stringify(views);
    for (const s of ["tk_secret1234", "AbCdEf123456", "/x/TOKENzz99", "s3cret-key"]) expect(text).not.toContain(s);
    expect(views[0]).toMatchObject({ tokenSet: true, tokenHint: "…1234", topic: "cstra-abc" });
    expect(views[1]).toMatchObject({ deviceKeySet: true, deviceKeyHint: "…3456" });
    expect(views[2]).toMatchObject({ urlHint: "hooks.example.com/…zz99", secretSet: true });
  });
});

describe("buildRequest", () => {
  test("ntfy：JSON 发布到服务器根，中文标题在 body 里，Bearer token，待你处理优先级 4、急件 5", () => {
    const r = buildRequest(ok(normalizeChannel(NTFY)), msg());
    expect(r.url).toBe("https://ntfy.sh/");
    expect(r.headers.authorization).toBe("Bearer tk_secret1234");
    expect(JSON.parse(r.body)).toEqual({ topic: "cstra-abc", title: "待你处理 · agent-x", message: "要不要发版？", priority: 4, tags: ["bell"], click: msg().url });
    expect(JSON.parse(buildRequest(ok(normalizeChannel(NTFY)), msg({ urgent: true })).body).priority).toBe(5);
    expect(JSON.parse(buildRequest(ok(normalizeChannel(NTFY)), msg({ type: "system", url: undefined })).body)).not.toHaveProperty("click");
  });
  test("Bark：POST /push，待你处理与安全提醒 timeSensitive、系统提醒 active，id 用 tag", () => {
    const c = ok(normalizeChannel(BARK));
    const r = buildRequest(c, msg());
    expect(r.url).toBe("https://api.day.app/push");
    expect(JSON.parse(r.body)).toMatchObject({ device_key: "AbCdEf123456", level: "timeSensitive", group: "Claudestra", id: "cstra-ask-a1-open", url: msg().url });
    expect(JSON.parse(buildRequest(c, msg({ type: "system" })).body).level).toBe("active");
  });
  test("Webhook：签名 = HMAC-SHA256(secret, 时间戳.原文)；没 secret 不带签名头", () => {
    const r = buildRequest(ok(normalizeChannel(HOOK)), msg());
    const ts = r.headers["x-claudestra-timestamp"];
    expect(ts).toBe(String(Math.floor(msg().ts / 1000)));
    expect(r.headers["x-claudestra-signature"]).toBe(`sha256=${createHmac("sha256", "s3cret-key").update(`${ts}.${r.body}`).digest("hex")}`);
    expect(webhookSignature("s3cret-key", ts, r.body)).toBe(r.headers["x-claudestra-signature"].slice(7));
    expect(JSON.parse(r.body)).toMatchObject({ source: "claudestra", type: "ask", title: "待你处理 · agent-x", url: msg().url });
    const bare = buildRequest(ok(normalizeChannel({ kind: "webhook", url: "https://h.example/a" })), msg());
    expect(bare.headers).not.toHaveProperty("x-claudestra-signature");
  });
});

describe("redactMessage / openLink", () => {
  test("不带正文：谁发的、标题、ask id 都不剩", () => {
    const r = redactMessage(msg(), "https://relay.example/chat");
    const text = JSON.stringify(r);
    for (const s of ["agent-x", "要不要发版", "a1"]) expect(text).not.toContain(s);
    expect(r.url).toBe("https://relay.example/chat");
  });
  test("相对拼接（基址带子路径不丢）、带 fp；没有基址不给链接", () => {
    expect(openLink("https://h.example/cs/", "/chat?ask=a1", "fp1")).toBe("https://h.example/cs/chat?ask=a1&fp=fp1");
    expect(openLink("https://relay.example", "/talk?room=r%2F1")).toBe("https://relay.example/talk?room=r%2F1");
    expect(openLink(null, "/chat")).toBeUndefined();
  });
});
