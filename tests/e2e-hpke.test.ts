import { describe, expect, test } from "bun:test";
import { setupBaseR, setupBaseS } from "../src/lib/e2e/hpke.ts";
import { hkdfBytes, importPair } from "../src/lib/e2e/primitives.ts";
import vec from "./fixtures/hpke-p256-aes256.json";

const h = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("HPKE base 模式（RFC 9180，CFRG 官方向量）", () => {
  test("发送方：enc、逐条密文、export 都与向量一致", async () => {
    const eph = await importPair(h(vec.skEm), h(vec.pkEm));
    const { enc, ctx } = await setupBaseS(h(vec.pkRm), h(vec.info), eph);
    expect(hex(enc)).toBe(vec.enc);
    for (const e of vec.encryptions) expect(hex(await ctx.seal(h(e.aad), h(e.pt)))).toBe(e.ct);
    for (const x of vec.exports) expect(hex(await ctx.export(h(x.exporter_context), x.L))).toBe(x.exported_value);
  });

  test("接收方：按序解开，export 相同", async () => {
    const r = await importPair(h(vec.skRm), h(vec.pkRm));
    const ctx = (await setupBaseR(h(vec.enc), r, h(vec.info)))!;
    for (const e of vec.encryptions) expect(hex((await ctx.open(h(e.aad), h(e.ct)))!)).toBe(e.pt);
    expect(hex(await ctx.export(new Uint8Array(0), 32))).toBe(vec.exports[0].exported_value);
  });

  test("篡改密文或 AAD 解不开，失败不推进序号", async () => {
    const r = await importPair(h(vec.skRm), h(vec.pkRm));
    const ctx = (await setupBaseR(h(vec.enc), r, h(vec.info)))!;
    const e0 = vec.encryptions[0];
    const bad = h(e0.ct);
    bad[0] ^= 1;
    expect(await ctx.open(h(e0.aad), bad)).toBeNull();
    expect(await ctx.open(h("00"), h(e0.ct))).toBeNull();
    expect(hex((await ctx.open(h(e0.aad), h(e0.ct)))!)).toBe(e0.pt);
  });

  test("enc 不是曲线上的点 → null；收件公钥无效 → 抛", async () => {
    const r = await importPair(h(vec.skRm), h(vec.pkRm));
    const off = h(vec.enc);
    off[64] ^= 1;
    expect(await setupBaseR(off, r, h(vec.info))).toBeNull();
    expect(await setupBaseR(h(vec.enc).subarray(1), r, h(vec.info))).toBeNull();
    await expect(setupBaseS(off, h(vec.info))).rejects.toThrow();
  });

  test("随机临时密钥往返", async () => {
    const r = await importPair(h(vec.skRm), h(vec.pkRm));
    const info = new TextEncoder().encode("cstra-redeem-v1");
    const s = await setupBaseS(r.pub, info);
    const ct = await s.ctx.seal(new Uint8Array(0), new TextEncoder().encode("join-secret"));
    const rc = (await setupBaseR(s.enc, r, info))!;
    expect(new TextDecoder().decode((await rc.open(new Uint8Array(0), ct))!)).toBe("join-secret");
    expect(hex(await rc.export(new TextEncoder().encode("redeem-response"), 32))).toBe(hex(await s.ctx.export(new TextEncoder().encode("redeem-response"), 32)));
  });
});

describe("HKDF-SHA256（RFC 5869 附录 A.1、A.3）", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  test("A.1：带 salt 与 info", async () => {
    expect(hex(await hkdfBytes(ikm, h("000102030405060708090a0b0c"), h("f0f1f2f3f4f5f6f7f8f9"), 42))).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });
  test("A.3：salt、info 都为空", async () => {
    expect(hex(await hkdfBytes(ikm, new Uint8Array(0), new Uint8Array(0), 42))).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });
});
