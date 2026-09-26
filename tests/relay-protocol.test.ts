/**
 * 中继协议共享模块（src/lib/relay-protocol.ts）：docs/relay/protocol.md §10 的向量、帧形状校验、slug / 短码 / 路径规则。
 * 向量由固定种子生成，服务端与客户端都必须复现——这是两端对拍的依据，改协议先改文档再改这里。
 */
import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { signedHeaders, SIG_HEADERS } from "../src/lib/instance-key.js";
import {
  apiPathOk, asAuth, asCode, asContacts, asData, asEndOrCancel, asPeerError, asReq, asRes, authSignature, formatCode, isPublicKey,
  isRedeemRequest, keyFingerprint, LIMITS, newRequestId, normalizeCode, normalizeHeaders, parseFrame, randomCode, slugCandidates, slugify,
  verifyAuthSignature,
} from "../src/lib/relay-protocol.js";

const SEED = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED, "hex")]), format: "der", type: "pkcs8" });
const pub = String(createPublicKey(priv).export({ format: "jwk" }).x);
const NOW = 1790000000 * 1000;
const NONCE = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8";
const FP = "65b6-0673-d6ed-884b";

describe("§10 测试向量", () => {
  test("公钥与指纹", () => {
    expect(pub).toBe("ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ");
    expect(isPublicKey(pub)).toBe(true);
    expect(keyFingerprint(pub)).toBe(FP);
  });
  test("请求签名（claudestra-req-v1，与 instance-key.ts 同一算法）", () => {
    const key = { publicKey: pub, privateKey: priv };
    const post = signedHeaders("POST", "/api/v1/agents/claudestra/messages", '{"text":"hello","wait":25}', key, NOW);
    expect(post[SIG_HEADERS.ts]).toBe("1790000000");
    expect(post[SIG_HEADERS.sig]).toBe("iScsvxVcjcHTN-zENfr5fVsaqqEAI23msC0jUqoeQ0ECnqWXGctckYWbKmMtj30TbJLI5g4r1ktbAvZ_mMNAAA");
    expect(signedHeaders("GET", "/api/v1/agents", "", key, NOW)[SIG_HEADERS.sig]).toBe("bDtmKeo0J-44eoYMOZsgi2yUv22AKDemJD5TdlzZsh1yKD3UeenhiXjo0DBZuTo9Rm2HF-pa3q6sDhjkn0aKCQ");
    const q = signedHeaders("GET", "/api/v1/threads/thr_x?since=1790000000", "", key, NOW);
    expect(q[SIG_HEADERS.sig]).toBe("65JZXOkY7qidttZ1Udt_W1cMeWz5nO8_IP9N9W9jcdFb7tGfgNoCxb5KlDi5ImuK2RVafiA_44IP_rw4EfDPCw");
  });
  test("握手签名（claudestra-relay-auth-v2）", () => {
    const sig = authSignature(priv, NONCE, pub, "MacBook-A", "macbook-a");
    expect(sig).toBe("JaWyysd1-D9wa1rQt94MjYMgmNzu1vEboFjmBzHR78LpfcOwEBJrYlb-MJvt4dt6LRCSRfvq6eyaTawFj5x4Ag");
    expect(verifyAuthSignature(pub, NONCE, "MacBook-A", "macbook-a", sig)).toBe(true);
    expect(verifyAuthSignature(pub, NONCE, "MacBook-A", "other", sig)).toBe(false);
    expect(verifyAuthSignature(pub, "x" + NONCE.slice(1), "MacBook-A", "macbook-a", sig)).toBe(false);
    expect(verifyAuthSignature("not-a-key", NONCE, "MacBook-A", "macbook-a", sig)).toBe(false);
    expect(verifyAuthSignature(pub, NONCE, "MacBook-A", "macbook-a", "!!!")).toBe(false);
  });
});

describe("帧形状", () => {
  test("parseFrame 只认带字符串 t 的对象", () => {
    expect(parseFrame('{"t":"ping"}')).toEqual({ t: "ping" });
    expect(parseFrame("[1]")).toBeNull();
    expect(parseFrame('{"x":1}')).toBeNull();
    expect(parseFrame("{bad")).toBeNull();
    expect(parseFrame("42")).toBeNull();
  });
  test("auth", () => {
    expect(asAuth({ t: "auth", v: 2, key: pub, name: "A", slug: "a", sig: "s" })).toMatchObject({ v: 2, slug: "a" });
    expect(asAuth({ t: "auth", v: "2", key: pub, name: "A", slug: "a", sig: "s" })).toBeNull();
    expect(asAuth({ t: "auth", v: 2, key: pub, name: "A", sig: "s" })).toBeNull();
  });
  test("req：方法大写、头小写、from 只认指纹或 relay、to 只认指纹", () => {
    const r = asReq({ t: "req", id: "r1", to: FP, from: "relay", method: "post", path: "/api/v1/x?a=1", headers: { "X-A": "1", n: 2 }, body: "AA==", more: true, timeoutMs: 5 });
    expect(r).toEqual({ t: "req", id: "r1", to: FP, from: "relay", timeoutMs: 5, method: "POST", path: "/api/v1/x?a=1", headers: { "x-a": "1" }, body: "AA==", more: true });
    expect(asReq({ t: "req", id: "r1", method: "GET", path: "/x" })).toMatchObject({ headers: {}, more: false, from: undefined });
    expect(asReq({ t: "req", id: "r1", from: "someone", method: "GET", path: "/x" })).toBeNull();
    expect(asReq({ t: "req", id: "r1", to: "nope", method: "GET", path: "/x" })).toBeNull();
    expect(asReq({ t: "req", id: "bad id!", method: "GET", path: "/x" })).toBeNull();
    expect(asReq({ t: "req", id: "r1", method: "GET", path: "/x", body: 3 })).toBeNull();
    expect(asReq({ t: "req", id: "r1", path: "/x" })).toBeNull();
  });
  test("res / data / end / cancel / error", () => {
    expect(asRes({ t: "res", id: "r1", status: 200.7, headers: { A: "b" }, more: true })).toEqual({ t: "res", id: "r1", to: undefined, status: 200, headers: { a: "b" }, body: undefined, more: true });
    expect(asRes({ t: "res", id: "r1", status: 99 })).toBeNull();
    expect(asRes({ t: "res", id: "r1", status: "200" })).toBeNull();
    expect(asData({ t: "data", id: "r1", b64: "" })).toEqual({ t: "data", id: "r1", to: undefined, b64: "" });
    expect(asData({ t: "data", id: "r1" })).toBeNull();
    expect(asEndOrCancel({ t: "end", id: "r1", to: FP })).toEqual({ t: "end", id: "r1", to: FP });
    expect(asEndOrCancel({ t: "cancel", id: "r1" })).toEqual({ t: "cancel", id: "r1", to: undefined });
    expect(asEndOrCancel({ t: "res", id: "r1" })).toBeNull();
    expect(asPeerError({ t: "error", id: "r1", to: FP, code: "bad_signature", message: "m" })).toMatchObject({ code: "bad_signature", origin: "peer", to: FP });
    expect(asPeerError({ t: "error", id: "r1", code: "x" })).toMatchObject({ to: undefined });
    expect(asPeerError({ t: "error", code: "x" })).toBeNull();
    expect(normalizeHeaders(null)).toEqual({});
  });
  test("contacts：去重、超 500 拒、坏指纹拒", () => {
    expect(asContacts({ t: "contacts", fps: [FP, FP] })).toEqual({ t: "contacts", fps: [FP] });
    expect(asContacts({ t: "contacts", fps: [FP, "nope"] })).toBeNull();
    expect(asContacts({ t: "contacts", fps: Array.from({ length: LIMITS.maxContacts + 1 }, () => FP) })).toBeNull();
    expect(asContacts({ t: "contacts", fps: [] })).toEqual({ t: "contacts", fps: [] });
  });
  test("code：规整大小写与中划线；put 必须带 exp", () => {
    expect(asCode({ t: "code", op: "put", code: "k7pm-2xq9", exp: 1 })).toEqual({ t: "code", op: "put", code: "K7PM2XQ9", exp: 1 });
    expect(asCode({ t: "code", op: "del", code: "K7PM2XQ9" })).toEqual({ t: "code", op: "del", code: "K7PM2XQ9", exp: undefined });
    expect(asCode({ t: "code", op: "put", code: "K7PM2XQ9" })).toBeNull();
    expect(asCode({ t: "code", op: "put", code: "K7PM2XQ0", exp: 1 })).toBeNull();
    expect(asCode({ t: "code", op: "x", code: "K7PM2XQ9" })).toBeNull();
  });
});

describe("slug、短码、路径", () => {
  test("slugify：主机名规整、去 .local、太长截断、空退回 claudestra", () => {
    expect(slugify("Shawn’s Mac mini.local")).toBe("shawn-s-mac-mini");
    expect(slugify("MacBook-Pro")).toBe("macbook-pro");
    expect(slugify("---")).toBe("claudestra");
    expect(slugify("")).toBe("claudestra");
    expect(slugify("a".repeat(50)).length).toBe(32);
    expect(slugify("x-".repeat(20))).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
  });
  test("slugCandidates：原样 → -前 4 位 → -前 8 位，总长不超 32", () => {
    const c = slugCandidates("mini", FP);
    expect(c).toEqual(["mini", "mini-65b6", "mini-65b60673"]);
    for (const s of slugCandidates("a".repeat(32), FP)) expect(s.length).toBeLessThanOrEqual(32);
  });
  test("短码：字母表无 0/O/1/I；输入不分大小写可带中划线；展示 XXXX-XXXX", () => {
    expect(normalizeCode(" k7pm-2xq9 ")).toBe("K7PM2XQ9");
    expect(normalizeCode("K7PM2XQ")).toBeNull();
    expect(normalizeCode("K7PM2XQ0")).toBeNull();
    expect(formatCode("K7PM2XQ9")).toBe("K7PM-2XQ9");
    const code = randomCode((n) => new Uint8Array(n).map((_, i) => i * 37));
    expect(code).toHaveLength(8);
    expect(normalizeCode(code)).toBe(code);
  });
  test("apiPathOk / isRedeemRequest", () => {
    expect(apiPathOk("/api/v1/agents?x=1")).toBe(true);
    expect(apiPathOk("/api/v1")).toBe(true);
    expect(apiPathOk("/api/v1/../hook")).toBe(false);
    expect(apiPathOk("//api/v1/agents")).toBe(false); // 协议相对地址：URL 会把 //api 当主机，直接拒
    expect(apiPathOk("/hook")).toBe(false);
    expect(apiPathOk("/api/v10/x")).toBe(false);
    expect(isRedeemRequest("post", "/api/v1/peers/redeem?x")).toBe(true);
    expect(isRedeemRequest("GET", "/api/v1/peers/redeem")).toBe(false);
    expect(isRedeemRequest("POST", "/api/v1/peers/redeem/x")).toBe(false);
  });
  test("newRequestId 形状", () => {
    expect(newRequestId((n) => new Uint8Array(n))).toMatch(/^r_\d+_[A-Za-z0-9]{1,6}$/);
  });
});
