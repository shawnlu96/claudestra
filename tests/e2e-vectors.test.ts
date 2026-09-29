/**
 * 握手与记录流的冻结向量（tests/fixtures/e2e-vectors.json）。两条独立的路都要算出同一组值：
 * src/lib/e2e（WebCrypto，P2 会原样搬去 web 做 twin），和这里用 node:crypto 手写的参照实现（按 e2e-design.md §4.1.3/§4.1.4 逐字照抄）。
 * 两边一致，才说明实现和设计稿是同一个意思，而不只是「自己跟自己一致」。
 */
import { describe, expect, test } from "bun:test";
import { createCipheriv, createECDH, createHash, createHmac, hkdfSync } from "node:crypto";
import { finish, respond } from "../src/lib/e2e/handshake.ts";
import { importPair } from "../src/lib/e2e/primitives.ts";
import { DIR_REQ, DIR_RES, openAll, recordAad, recordNonce, sealMessage } from "../src/lib/e2e/records.ts";
import v from "./fixtures/e2e-vectors.json";

const h = (s: string) => Buffer.from(s, "hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const lp = (...xs: (Buffer | string)[]) => Buffer.concat(xs.flatMap((x) => { const b = Buffer.from(x); return [u16(b.length), b]; }));
const be = (n: bigint, len: number) => Buffer.from(n.toString(16).padStart(len * 2, "0"), "hex");

/** node:crypto 参照实现：只照设计稿写，不引 src/lib/e2e 的任何东西 */
function reference() {
  const dh = (d: string, pub: string) => { const e = createECDH("prime256v1"); e.setPrivateKey(h(d)); return e.computeSecret(h(pub)); };
  const ikm = lp(dh(v.ce.d, v.be.pub), dh(v.D.d, v.be.pub), dh(v.ce.d, v.M.pub), dh(v.D.d, v.M.pub));
  const th = createHash("sha256").update(lp(v.label, v.fp, h(v.devId), h(v.ce.pub), h(v.be.pub), h(v.sid))).digest();
  const sub = (info: string) => Buffer.from(hkdfSync("sha256", ikm, th, info, 32));
  const confirm = createHmac("sha256", sub("confirm")).update(th).digest();
  const seal = (key: Buffer, dir: number, rid: bigint, parts: string[]) => Buffer.concat(parts.map((p, i) => {
    const nonce = Buffer.concat([Buffer.from([dir]), be(rid, 7), be(BigInt(i), 4)]);
    const aad = Buffer.concat([lp(v.label), h(v.sid), Buffer.from([dir]), be(rid, 7), be(BigInt(i), 4), Buffer.from([i === parts.length - 1 ? 1 : 0])]);
    const c = createCipheriv("aes-256-gcm", key, nonce).setAAD(aad);
    const ct = Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
    return Buffer.concat([be(BigInt(ct.length), 4), ct]);
  }));
  return {
    th, confirm,
    req: seal(sub("c2b"), 1, 1n, [v.request.head, v.request.body]),
    res: seal(sub("b2c"), 2, 1n, [v.response.head, v.response.body]),
  };
}

async function webcrypto() {
  const scope = { fp: v.fp, devId: h(v.devId), label: v.label };
  const [m, d, ce, bep] = await Promise.all([importPair(h(v.M.d), h(v.M.pub)), importPair(h(v.D.d), h(v.D.pub)), importPair(h(v.ce.d), h(v.ce.pub)), importPair(h(v.be.d), h(v.be.pub))]);
  const r = await respond(scope, { local: m, remoteStatic: d.pub, ce: ce.pub, ephemeral: bep, sid: h(v.sid) });
  const k = (await finish(scope, { local: d, ephemeral: ce, remoteStatic: m.pub, be: r.be, sid: r.sid, confirm: r.confirm }))!;
  return { r, k };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("E2E 冻结向量", () => {
  test("参照实现（node:crypto）算出的 th / confirm / 记录流与向量一致", () => {
    const ref = reference();
    expect(hex(ref.th)).toBe(v.th);
    expect(hex(ref.confirm)).toBe(v.confirm);
    expect(hex(ref.req)).toBe(v.request.stream);
    expect(hex(ref.res)).toBe(v.response.stream);
  });

  test("src/lib/e2e（WebCrypto）算出同一组值，两端派生出同一对密钥", async () => {
    const { r, k } = await webcrypto();
    expect(hex(r.keys.th)).toBe(v.th);
    expect(hex(r.confirm)).toBe(v.confirm);
    expect(hex(k.th)).toBe(v.th);
    const sid = h(v.sid);
    expect(hex(await sealMessage({ key: k.c2b, sid, dir: DIR_REQ, rid: 1n }, enc(v.request.head), enc(v.request.body)))).toBe(v.request.stream);
    expect(hex(await sealMessage({ key: r.keys.b2c, sid, dir: DIR_RES, rid: 1n }, enc(v.response.head), enc(v.response.body)))).toBe(v.response.stream);
    // 对向解开：bridge 用自己那份 c2b 解请求，发起方用 b2c 解响应
    expect((await openAll({ key: r.keys.c2b, sid, dir: DIR_REQ, rid: 1n }, h(v.request.stream))).map(dec)).toEqual([v.request.head, v.request.body]);
    expect((await openAll({ key: k.b2c, sid, dir: DIR_RES, rid: 1n }, h(v.response.stream))).map(dec)).toEqual([v.response.head, v.response.body]);
  });

  test("nonce 与 AAD 的字节布局", () => {
    expect(hex(recordNonce(DIR_REQ, 1n, 0))).toBe(v.nonceReq_rid1_i0);
    expect(hex(recordNonce(DIR_REQ, 1n, 0))).toBe("01" + "00000000000001" + "00000000");
    expect(hex(recordAad(v.label, h(v.sid), DIR_RES, 1n, 1, true))).toBe(v.aadRes_rid1_i1_final);
    expect(hex(recordAad(v.label, h(v.sid), DIR_RES, 1n, 1, true))).toBe(hex(lp(v.label)) + v.sid + "02" + "00000000000001" + "00000001" + "01");
  });
});
