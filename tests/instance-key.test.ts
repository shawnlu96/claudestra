/**
 * 实例签名密钥 + 对方公钥钉住规则（现阶段只记录不拦截）。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, isPublicKey, keyFingerprint, signedHeaders, SIG_HEADERS, verifySigned } from "../src/lib/instance-key.js";
import { judgeSignature } from "../src/lib/peer-keys.js";

const dir = mkdtempSync(join(tmpdir(), "ikey-"));
const key = instanceKeySync(dir)!;
const NOW = Date.parse("2026-09-25T00:00:00Z");

describe("instanceKeySync", () => {
  test("生成一次、之后读回同一把；私钥文件 0600；公钥 43 字符 base64url", () => {
    expect(key).not.toBeNull();
    expect(instanceKeySync(dir)!.publicKey).toBe(key.publicKey);
    expect(isPublicKey(key.publicKey)).toBe(true);
    expect(statSync(join(dir, "instance-key.pem")).mode & 0o777).toBe(0o600);
  });
  test("指纹：四位一组的十六进制", () => {
    expect(keyFingerprint(key.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});

describe("签名 / 验签", () => {
  const body = JSON.stringify({ text: "hi", wait: 110 });
  const h = signedHeaders("POST", "/api/v1/agents/x/messages", body, key, NOW);
  const req = (o: Partial<{ method: string; path: string; body: string }> = {}) => ({
    method: o.method ?? "POST", path: o.path ?? "/api/v1/agents/x/messages", ts: h[SIG_HEADERS.ts], sig: h[SIG_HEADERS.sig], body: o.body ?? body,
  });
  test("原样对得上；改正文 / 路径 / 方法都对不上", () => {
    expect(h[SIG_HEADERS.key]).toBe(key.publicKey);
    expect(verifySigned(key.publicKey, req(), NOW)).toBe("ok");
    expect(verifySigned(key.publicKey, req({ body: body + " " }), NOW)).toBe("bad");
    expect(verifySigned(key.publicKey, req({ path: "/api/v1/agents/y/messages" }), NOW)).toBe("bad");
    expect(verifySigned(key.publicKey, req({ method: "GET" }), NOW)).toBe("bad");
  });
  test("时间戳超出 5 分钟当重放；别人的公钥对不上", () => {
    expect(verifySigned(key.publicKey, req(), NOW + 10 * 60_000)).toBe("stale");
    const other = instanceKeySync(mkdtempSync(join(tmpdir(), "ikey2-")))!;
    expect(verifySigned(other.publicKey, req(), NOW)).toBe("bad");
  });
});

describe("judgeSignature（TOFU）", () => {
  const T = "2026-09-25T00:00:00.000Z";
  const hdr = { key: key.publicKey, ts: "1", sig: "s" };
  test("没带签名：unsigned，不钉", () => {
    expect(judgeSignature(undefined, { key: null, ts: null, sig: null }, () => "ok", T)).toEqual({ lastCheck: { at: T, result: "unsigned" } });
  });
  test("第一次对得上就钉住；之后换钥匙 = key_changed，不替换", () => {
    const pinned = judgeSignature(undefined, hdr, () => "ok", T);
    expect(pinned).toMatchObject({ publicKey: key.publicKey, fingerprint: keyFingerprint(key.publicKey), pinnedAt: T, lastCheck: { result: "ok" } });
    const other = instanceKeySync(mkdtempSync(join(tmpdir(), "ikey3-")))!.publicKey;
    const changed = judgeSignature(pinned, { ...hdr, key: other }, () => "ok", T);
    expect(changed.lastCheck?.result).toBe("key_changed");
    expect(changed.publicKey).toBe(key.publicKey);
  });
  test("钉住后用钉住的钥匙验；对不上记 bad，第一次就对不上不钉", () => {
    const pinned = judgeSignature(undefined, hdr, () => "ok", T);
    expect(judgeSignature(pinned, hdr, () => "bad", T).lastCheck?.result).toBe("bad");
    expect(judgeSignature(undefined, hdr, () => "bad", T)).toEqual({ lastCheck: { at: T, result: "bad" } });
  });
});
