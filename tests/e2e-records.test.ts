import { describe, expect, test } from "bun:test";
import { fromB64url, lp, toB64url, uintBE } from "../src/lib/e2e/encoding.ts";
import { finish, respond } from "../src/lib/e2e/handshake.ts";
import { aesKey, generateEcdh, randomBytes } from "../src/lib/e2e/primitives.ts";
import { DIR_REQ, DIR_RES, RECORD_MAX, RecordError, RecordOpener, RecordSealer, openAll, sealMessage } from "../src/lib/e2e/records.ts";
import { ReplayWindow } from "../src/lib/e2e/replay-window.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** 把记录流拆回一条条带长度头的记录 */
function split(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < stream.length;) {
    const len = new DataView(stream.buffer, stream.byteOffset + at).getUint32(0);
    out.push(stream.subarray(at, at + 4 + len));
    at += 4 + len;
  }
  return out;
}
const join = (xs: Uint8Array[]) => new Uint8Array(Buffer.concat(xs));

describe("encoding", () => {
  test("lp：u16 大端长度前缀；超长直接抛", () => {
    expect(Buffer.from(lp("ab", new Uint8Array([7]))).toString("hex")).toBe("00026162" + "000107");
    expect(() => lp(new Uint8Array(0x10000))).toThrow(RangeError);
  });
  test("uintBE 放不下就抛，不截断", () => {
    expect(Buffer.from(uintBE(1n, 7)).toString("hex")).toBe("00000000000001");
    expect(() => uintBE(1n << 56n, 7)).toThrow(RangeError);
    expect(() => uintBE(-1, 4)).toThrow(RangeError);
  });
  test("base64url 只认规范写法", () => {
    const b = randomBytes(33);
    expect(fromB64url(toB64url(b))).toEqual(b);
    expect(fromB64url("AQ==")).toBeNull(); // 带填充
    expect(fromB64url("AR")).toBeNull(); // 多余的位不为 0：与 "AQ" 解出同一字节
    expect(fromB64url("A+Q")).toBeNull();
  });
});

describe("ReplayWindow", () => {
  test("首次通过、重复拒、rid ≤ 最大值 − 1024 拒、0 拒", () => {
    const w = new ReplayWindow();
    expect(w.accept(0n)).toBe(false);
    expect(w.accept(5n)).toBe(true);
    expect(w.accept(5n)).toBe(false);
    expect(w.accept(3n)).toBe(true);
    expect(w.accept(2000n)).toBe(true);
    expect(w.accept(976n)).toBe(false); // 2000 − 1024
    expect(w.accept(977n)).toBe(true);
    expect(w.accept(977n)).toBe(false);
  });
  test("前进时清掉被复用的槽位；跳得比窗口还远时整体清空", () => {
    const w = new ReplayWindow();
    expect(w.accept(10n)).toBe(true);
    expect(w.accept(1034n)).toBe(true); // 与 10 同槽：10 已跌出窗口
    expect(w.accept(10n)).toBe(false);
    expect(w.accept(100n)).toBe(true);
    expect(w.accept(100_000n)).toBe(true);
    expect(w.accept(100n)).toBe(false);
    expect(w.accept(99_000n)).toBe(true);
    expect(w.accept(99_000n)).toBe(false);
  });
  test("同一个 rid 的并发副本只有一份通过（accept 同步，中间没有 await）", async () => {
    const w = new ReplayWindow();
    const results = await Promise.all([1, 2, 3].map(async () => w.accept(42n)));
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("记录流", () => {
  const scope = async (dir: 1 | 2 = DIR_REQ, rid = 1n) => ({ key: await aesKey(randomBytes(32)), sid: randomBytes(16), dir, rid } as const);

  test("大正文按 64 KiB 分块，流式小块喂入也能按序解开", async () => {
    const s = await scope();
    const body = randomBytes(RECORD_MAX * 2 + 10);
    const stream = await sealMessage(s, enc("head"), body);
    expect(split(stream).length).toBe(4);
    const o = new RecordOpener(s);
    const got: Uint8Array[] = [];
    for (let at = 0; at < stream.length; at += 1000) got.push(...(await o.push(stream.subarray(at, at + 1000))));
    o.end();
    expect(dec(got[0])).toBe("head");
    expect(Buffer.from(join(got.slice(1))).equals(Buffer.from(body))).toBe(true);
  });

  test("截掉最后一条 → 截断；中间某条被当成最后一条也不行", async () => {
    const s = await scope();
    const recs = split(await sealMessage(s, enc("h"), randomBytes(RECORD_MAX + 1)));
    await expect(openAll(s, join(recs.slice(0, -1)))).rejects.toThrow(RecordError);
    await expect(openAll(s, join(recs.slice(0, 1)))).rejects.toThrow(RecordError);
  });

  test("重排、final 之后多出字节、长度头超限 → 拒", async () => {
    const s = await scope();
    const recs = split(await sealMessage(s, enc("h"), randomBytes(RECORD_MAX + 1)));
    await expect(openAll(s, join([recs[1], recs[0], recs[2]]))).rejects.toThrow(RecordError);
    await expect(openAll(s, join([...recs, recs[2]]))).rejects.toThrow("data after final");
    await expect(openAll(s, new Uint8Array([0, 2, 0, 0x20]))).rejects.toThrow("bad record length");
  });

  test("响应绑定请求：换 rid、换方向、换 sid 都解不开", async () => {
    const s = await scope(DIR_RES, 7n);
    const stream = await sealMessage(s, enc("{\"status\":200}"));
    await expect(openAll({ ...s, rid: 8n }, stream)).rejects.toThrow(RecordError);
    await expect(openAll({ ...s, dir: DIR_REQ }, stream)).rejects.toThrow(RecordError);
    await expect(openAll({ ...s, sid: randomBytes(16) }, stream)).rejects.toThrow(RecordError);
    await expect(openAll({ ...s, label: "cstra-other-v1" }, stream)).rejects.toThrow(RecordError);
    expect((await openAll(s, stream)).map(dec)).toEqual(["{\"status\":200}"]);
  });

  test("编码器：final 之后不许再加密，明文超 64 KiB 抛，rid 越界抛", async () => {
    const s = await scope();
    const sealer = new RecordSealer(s);
    await sealer.seal(enc("x"), true);
    await expect(sealer.seal(enc("y"), false)).rejects.toThrow("finalized");
    await expect(new RecordSealer(s).seal(new Uint8Array(RECORD_MAX + 1), true)).rejects.toThrow(RangeError);
    expect(() => new RecordSealer({ ...s, rid: 1n << 56n })).toThrow(RangeError);
    expect(() => new RecordSealer({ ...s, rid: 0n })).toThrow(RangeError);
  });
});

describe("握手", () => {
  const scope = { fp: "aaaa-bbbb-cccc-dddd", devId: randomBytes(32) };

  test("双方派生出同一对密钥，th 一致", async () => {
    const [m, d, ce] = await Promise.all([generateEcdh(), generateEcdh(), generateEcdh()]);
    const r = await respond(scope, { local: m, remoteStatic: d.pub, ce: ce.pub });
    const k = (await finish(scope, { local: d, ephemeral: ce, remoteStatic: m.pub, be: r.be, sid: r.sid, confirm: r.confirm }))!;
    expect(k).not.toBeNull();
    expect(Buffer.from(k.th).equals(Buffer.from(r.keys.th))).toBe(true);
    const sealed = await sealMessage({ key: k.c2b, sid: r.sid, dir: DIR_REQ, rid: 1n }, enc("ping"));
    expect((await openAll({ key: r.keys.c2b, sid: r.sid, dir: DIR_REQ, rid: 1n }, sealed)).map(dec)).toEqual(["ping"]);
  });

  test("对面不持有 M（中间人用自己的钥匙应答）→ confirm 对不上", async () => {
    const [m, evil, d, ce] = await Promise.all([generateEcdh(), generateEcdh(), generateEcdh(), generateEcdh()]);
    const r = await respond(scope, { local: evil, remoteStatic: d.pub, ce: ce.pub });
    expect(await finish(scope, { local: d, ephemeral: ce, remoteStatic: m.pub, be: r.be, sid: r.sid, confirm: r.confirm })).toBeNull();
  });

  test("be / sid / fp / devId 任何一项被改 → confirm 对不上", async () => {
    const [m, d, ce, other] = await Promise.all([generateEcdh(), generateEcdh(), generateEcdh(), generateEcdh()]);
    const r = await respond(scope, { local: m, remoteStatic: d.pub, ce: ce.pub });
    const base = { local: d, ephemeral: ce, remoteStatic: m.pub, be: r.be, sid: r.sid, confirm: r.confirm };
    expect(await finish(scope, { ...base, be: other.pub })).toBeNull();
    expect(await finish(scope, { ...base, sid: randomBytes(16) })).toBeNull();
    expect(await finish({ ...scope, fp: "aaaa-bbbb-cccc-0000" }, base)).toBeNull();
    expect(await finish({ ...scope, devId: randomBytes(32) }, base)).toBeNull();
    expect(await finish({ ...scope, label: "cstra-peer-e2e-v1" }, base)).toBeNull();
    expect(await finish(scope, { ...base, sid: randomBytes(15) })).toBeNull();
  });

  test("响应方拿到的 ce / 静态公钥不是合法点 → 抛", async () => {
    const [m, d] = await Promise.all([generateEcdh(), generateEcdh()]);
    const bad = new Uint8Array(d.pub);
    bad[64] ^= 1;
    await expect(respond(scope, { local: m, remoteStatic: d.pub, ce: bad })).rejects.toThrow("invalid");
    await expect(respond(scope, { local: m, remoteStatic: bad, ce: d.pub })).rejects.toThrow("invalid");
  });
});
