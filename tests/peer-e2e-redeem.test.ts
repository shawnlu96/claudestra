import { describe, expect, test } from "bun:test";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { isSealedRedeem, openRedeemRequest, openRedeemResponse, sealRedeemRequest, sealRedeemResponse } from "../src/lib/peer-e2e-redeem.ts";

const FP = "abcd-ef01-2345-6789";
const payload = { join: "j".repeat(32), name: "bob", idk: "k".repeat(43) };

describe("兑换邀请的 HPKE 信封", () => {
  test("往返：邀请方解开请求，兑换方解开响应；中继看到的请求里没有 join 口令", async () => {
    const m = await generateEcdh();
    const { body, session } = await sealRedeemRequest(m.pub, FP, payload);
    expect(isSealedRedeem(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(payload.join);
    const got = (await openRedeemRequest(m, FP, body))!;
    expect(got.payload).toEqual(payload);
    const res = await sealRedeemResponse(got.session, { ok: true, token: "secret-token" });
    expect(JSON.stringify(res)).not.toContain("secret-token");
    expect(await openRedeemResponse(session, res)).toEqual({ ok: true, token: "secret-token" });
  });

  test("封给别的机器、指纹对不上、密文被改、套件不对 → 解不开", async () => {
    const [m, other] = await Promise.all([generateEcdh(), generateEcdh()]);
    const { body } = await sealRedeemRequest(m.pub, FP, payload);
    expect(await openRedeemRequest(other, FP, body)).toBeNull();
    expect(await openRedeemRequest(m, "0000-0000-0000-0000", body)).toBeNull();
    const ct = Buffer.from(body.ct, "base64url");
    ct[0] ^= 1;
    expect(await openRedeemRequest(m, FP, { ...body, ct: ct.toString("base64url") })).toBeNull();
    expect(await openRedeemRequest(m, FP, { ...body, suite: { kem: 16, kdf: 1, aead: 1 } as never })).toBeNull();
  });

  test("中继重放同一个兑换请求：两次导出同一把密钥，但 nonce 每次随机，不会一次一密被重用", async () => {
    const m = await generateEcdh();
    const { body, session } = await sealRedeemRequest(m.pub, FP, payload);
    const r1 = (await openRedeemRequest(m, FP, body))!, r2 = (await openRedeemRequest(m, FP, body))!;
    const a = await sealRedeemResponse(r1.session, { ok: true, token: "t1" });
    const b = await sealRedeemResponse(r2.session, { ok: true, token: "t1" });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
    expect(await openRedeemResponse(session, b)).toEqual({ ok: true, token: "t1" });
  });

  test("响应绑定这一次兑换：拿另一次兑换的响应来解 → null；老版本明文体不算加密兑换", async () => {
    const m = await generateEcdh();
    const one = await sealRedeemRequest(m.pub, FP, payload);
    const two = await sealRedeemRequest(m.pub, FP, payload);
    const r2 = (await openRedeemRequest(m, FP, two.body))!;
    const res2 = await sealRedeemResponse(r2.session, { ok: true });
    expect(await openRedeemResponse(one.session, res2)).toBeNull();
    expect(await openRedeemResponse(two.session, { ...res2, nonce: "AAAA" })).toBeNull();
    expect(isSealedRedeem({ join: "x", name: "bob" })).toBe(false);
    expect(isSealedRedeem(null)).toBe(false);
  });
});
