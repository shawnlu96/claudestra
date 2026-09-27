/**
 * 共享 APNs 发送器（src/lib/apns.ts）：JWT 头 / 声明 / 签名可验；aps 正文；payload 解析；env → 配置；
 * 真实 http2 往返打本地 h2 假 APNs（自签名，注入 connect）：200 / 410 Unregistered / 403 ExpiredProviderToken 换 token 重发 / 超时。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApnsClient, apnsBody, apnsConfigFromEnv, apnsJwt, apnsTokenDead, parseApnsMessage, type ApnsConfig } from "../src/lib/apns.ts";
import { selfSignedCert } from "./push-test-helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "apns-"));
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const p8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const keyPath = join(dir, "AuthKey_ABC123DEF4.p8");
writeFileSync(keyPath, p8);
const msg = { title: "alpha", body: "hi", agent: "alpha", url: "/chat?agent=alpha", ts: 1700000000000, tag: "cstra-alpha-1", badge: 2 };

describe("JWT 与正文", () => {
  test("ES256 JWT：header {alg,kid}、claims {iss,iat}、签名 ieee-p1363 可用公钥验", () => {
    const jwt = apnsJwt(privateKey, "ABC123DEF4", "TEAM000001", 1700000000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEF4" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "TEAM000001", iat: 1700000000 });
    const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(Buffer.from(s, "base64url").length).toBe(64);
  });
  test("aps 正文：alert + sound + thread-id + badge；silent 只有 thread-id + badge；自定义字段在顶层", () => {
    const aps = { alert: { title: "alpha", body: "hi" }, sound: "default", "thread-id": "alpha", badge: 2 };
    expect(JSON.parse(apnsBody(msg))).toEqual({ aps, agent: "alpha", url: "/chat?agent=alpha", ts: 1700000000000, tag: "cstra-alpha-1" });
    expect(JSON.parse(apnsBody({ ...msg, silent: true, badge: 0 })).aps).toEqual({ "thread-id": "alpha", badge: 0 });
    expect(JSON.parse(apnsBody({ ...msg, badge: undefined })).aps.badge).toBeUndefined();
  });
  test("parseApnsMessage：形状齐全才算；帧级 badge 覆盖；坏 JSON / 缺字段 → null", () => {
    expect(parseApnsMessage(JSON.stringify(msg))).toEqual(msg);
    expect(parseApnsMessage(JSON.stringify(msg), 7)!.badge).toBe(7);
    expect(parseApnsMessage(JSON.stringify({ ...msg, silent: true, collapseId: "c" }))).toMatchObject({ silent: true, collapseId: "c" });
    expect(parseApnsMessage(JSON.stringify({ title: "x" }))).toBeNull();
    expect(parseApnsMessage("{")).toBeNull();
    expect(parseApnsMessage("[]")).toBeNull();
  });
  test("apnsTokenDead：410 或三种永久失效 reason", () => {
    expect(apnsTokenDead({ ok: false, status: 410 })).toBe(true);
    for (const reason of ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]) expect(apnsTokenDead({ ok: false, status: 400, reason })).toBe(true);
    expect(apnsTokenDead({ ok: false, status: 403, reason: "ExpiredProviderToken" })).toBe(false);
    expect(apnsTokenDead({ ok: true, status: 200 })).toBe(false);
  });
});

describe("apnsConfigFromEnv", () => {
  test("显式路径 + KEY_ID 从文件名解析 + TEAM_ID 必填；ENV 默认 sandbox；TOPIC 默认", () => {
    const env: Record<string, string> = { RELAY_APNS_KEY_PATH: keyPath, RELAY_APNS_TEAM_ID: "TEAM000001" };
    expect(apnsConfigFromEnv((k) => env[k], { prefix: "RELAY_APNS_" })).toEqual({ config: { keyPath, keyId: "ABC123DEF4", teamId: "TEAM000001", topic: "com.claudestra.app", env: "sandbox" } });
    env.RELAY_APNS_ENV = "Production";
    env.RELAY_APNS_TOPIC = "com.x.y";
    env.RELAY_APNS_KEY_ID = "OVERRIDE";
    expect(apnsConfigFromEnv((k) => env[k], { prefix: "RELAY_APNS_" }).config).toMatchObject({ keyId: "OVERRIDE", topic: "com.x.y", env: "production" });
    expect(apnsConfigFromEnv((k) => ({ RELAY_APNS_KEY_PATH: keyPath })[k], { prefix: "RELAY_APNS_" })).toMatchObject({ config: null, why: expect.stringContaining("TEAM_ID") });
    expect(apnsConfigFromEnv(() => undefined, { prefix: "APNS_" })).toMatchObject({ config: null, why: expect.stringContaining("AuthKey") });
  });
  test("keyDir 里找 AuthKey_*.p8（bridge 直发的默认目录）；目录里没有 → null", () => {
    const keyDir = join(dir, "apns");
    mkdirSync(keyDir);
    writeFileSync(join(keyDir, "AuthKey_DIRKEY0001.p8"), p8);
    expect(apnsConfigFromEnv((k) => ({ APNS_TEAM_ID: "T" })[k], { prefix: "APNS_", keyDir }).config).toMatchObject({ keyPath: join(keyDir, "AuthKey_DIRKEY0001.p8"), keyId: "DIRKEY0001" });
    expect(apnsConfigFromEnv((k) => ({ APNS_TEAM_ID: "T" })[k], { prefix: "APNS_", keyDir: join(dir, "nope") }).config).toBeNull();
  });
});

describe("ApnsClient 打本地 h2 假 APNs", () => {
  let server: http2.Http2SecureServer;
  let port = 0;
  const seen: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
  let script: Array<{ status: number; body?: string; delayMs?: number }> = [];
  const cfg: ApnsConfig = { keyPath, keyId: "ABC123DEF4", teamId: "TEAM000001", topic: "com.claudestra.app", env: "sandbox" };
  const mk = (opts: { timeoutMs?: number; now?: () => number } = {}) =>
    new ApnsClient(cfg, { connect: () => http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false }), timeoutMs: opts.timeoutMs, now: opts.now });

  beforeAll(async () => {
    const tls = await selfSignedCert(dir);
    server = http2.createSecureServer(tls, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ path: req.url, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body });
        const step = script.shift() ?? { status: 200 };
        setTimeout(() => {
          res.writeHead(step.status, { "content-type": "application/json" });
          res.end(step.body ?? "");
        }, step.delayMs ?? 0);
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  test("200 → ok；头带 bearer JWT、topic、push-type alert、collapse-id；正文是 aps", async () => {
    const c = mk();
    const r = await c.send("ab".repeat(32), { ...msg, collapseId: "x".repeat(70) });
    expect(r).toEqual({ ok: true, status: 200, reason: undefined });
    const s = seen[0];
    expect(s.path).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(s.headers.authorization).toMatch(/^bearer ey/);
    expect(s.headers["apns-topic"]).toBe("com.claudestra.app");
    expect(s.headers["apns-push-type"]).toBe("alert");
    expect(s.headers["apns-collapse-id"]).toHaveLength(64);
    expect(JSON.parse(s.body).aps.alert.title).toBe("alpha");
    c.close();
  });
  test("410 Unregistered → 不 ok + reason，apnsTokenDead 为真；非 JSON 错误体截成 reason", async () => {
    const c = mk();
    script = [{ status: 410, body: JSON.stringify({ reason: "Unregistered" }) }, { status: 500, body: "<html>oops</html>" }];
    const r = await c.send("cd".repeat(32), msg);
    expect(r).toEqual({ ok: false, status: 410, reason: "Unregistered" });
    expect(apnsTokenDead(r)).toBe(true);
    expect(await c.send("cd".repeat(32), msg)).toEqual({ ok: false, status: 500, reason: "<html>oops</html>" });
    c.close();
  });
  test("403 ExpiredProviderToken → 换 JWT 重发一次（第二次用新 token）；再 403 就放弃", async () => {
    let t = 1_700_000_000_000;
    const c = mk({ now: () => (t += 1000) });
    const before = seen.length;
    script = [{ status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) }, { status: 200 }];
    expect(await c.send("ef".repeat(32), msg)).toMatchObject({ ok: true, status: 200 });
    expect(seen.length - before).toBe(2);
    expect(seen[before].headers.authorization).not.toBe(seen[before + 1].headers.authorization);
    script = [{ status: 403, body: JSON.stringify({ reason: "InvalidProviderToken" }) }, { status: 403, body: JSON.stringify({ reason: "InvalidProviderToken" }) }];
    expect(await c.send("ef".repeat(32), msg)).toEqual({ ok: false, status: 403, reason: "InvalidProviderToken" });
    c.close();
  });
  test("provider token 50 分钟内复用，之后换", () => {
    let t = 1_700_000_000_000;
    const c = mk({ now: () => t });
    const a = c.providerToken();
    t += 49 * 60_000;
    expect(c.providerToken()).toBe(a);
    t += 2 * 60_000;
    expect(c.providerToken()).not.toBe(a);
  });
  test("服务器不回 → Timeout", async () => {
    const c = mk({ timeoutMs: 150 });
    script = [{ status: 200, delayMs: 1000 }];
    expect(await c.send("aa".repeat(32), msg)).toEqual({ ok: false, status: 0, reason: "Timeout" });
    c.close();
  });
});
