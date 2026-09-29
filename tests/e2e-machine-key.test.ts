import { afterAll, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareE2eKey, e2eKeyBlobMessage, machineE2eKey, signE2eKey, verifyE2eKey } from "../src/lib/e2e-machine-key.ts";
import { toB64url } from "../src/lib/e2e/encoding.ts";
import { ecdh, generateEcdh, importPub } from "../src/lib/e2e/primitives.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cstra-e2e-key-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const identity = () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
};

describe("本机 E2E 密钥文件", () => {
  test("第一次生成 0600 的 PEM，之后读回同一把；能做 ECDH", async () => {
    const dir = tmp();
    const a = (await machineE2eKey(dir))!;
    expect(statSync(join(dir, "e2e-key.pem")).mode & 0o777).toBe(0o600);
    expect(a.pair.pub.length).toBe(65);
    const other = await generateEcdh();
    const s1 = await ecdh(a.pair.priv, (await importPub(other.pub))!);
    const s2 = await ecdh(other.priv, (await importPub(a.pair.pub))!);
    expect(Buffer.from(s1).equals(Buffer.from(s2))).toBe(true);
    const again = (await machineE2eKey(dir))!;
    expect(Buffer.from(again.pair.pub).equals(Buffer.from(a.pair.pub))).toBe(true);
  });

  test("文件坏了返回 null，不缓存失败", async () => {
    const dir = tmp();
    await Bun.write(join(dir, "e2e-key.pem"), "not a pem");
    expect(await machineE2eKey(dir)).toBeNull();
  });
});

describe("签名公钥块", () => {
  test("消息布局：lp(label, u32 版本, u64 时间, 公钥)", () => {
    const pub = new Uint8Array(65).fill(4);
    const hex = Buffer.from(e2eKeyBlobMessage(1, 0x01020304, pub)).toString("hex");
    expect(hex).toBe("000c" + Buffer.from("peer-e2e-key").toString("hex") + "0004" + "00000001" + "0008" + "0000000001020304" + "0041" + "04".repeat(65));
  });

  test("Ed25519 签名是确定性的：固定身份钥 + 固定块 → 固定签名（冻结向量）", () => {
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"); // RFC 8032 测试 1 的私钥
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const b = signE2eKey({ privateKey }, new Uint8Array(65).fill(4), 1, 1790000000);
    expect(b.sig).toBe("Q9XVXnSdY9S9RjnBHmDG1hBjhhMdePngwhyqe0HgSdpOvMdC3OqMlUaQVZiA186WfJIZAJ2R6k97C6pCJ5HcBg");
  });

  test("用钉住的身份公钥验签；换身份、改版本 / 时间 / 公钥都不行", async () => {
    const id = identity();
    const pub = (await generateEcdh()).pub;
    const b = signE2eKey(id, pub, 1, 1790000000);
    expect((await verifyE2eKey(id.publicKey, b))?.pub).toBe(toB64url(pub));
    expect(await verifyE2eKey(identity().publicKey, b)).toBeNull();
    expect(await verifyE2eKey(id.publicKey, { ...b, v: 2 })).toBeNull();
    expect(await verifyE2eKey(id.publicKey, { ...b, ts: b.ts + 1 })).toBeNull();
    expect(await verifyE2eKey(id.publicKey, { ...b, pub: toB64url((await generateEcdh()).pub) })).toBeNull();
    expect(await verifyE2eKey(id.publicKey, { ...b, sig: `${b.sig.slice(0, -1)}${b.sig.endsWith("A") ? "Q" : "A"}` })).toBeNull();
    expect(await verifyE2eKey(id.publicKey, { ...b, pub: toB64url(new Uint8Array(65).fill(4)) })).toBeNull(); // 不在曲线上
    expect(await verifyE2eKey(id.publicKey, null)).toBeNull();
    expect(await verifyE2eKey("not-a-key", b)).toBeNull();
  });

  test("只收版本更新的：同版本同钥匙算 same，旧版本或同版本换钥匙拒", () => {
    expect(compareE2eKey(undefined, { v: 1, pub: "a" })).toBe("newer");
    expect(compareE2eKey({ v: 1, pub: "a" }, { v: 2, pub: "b" })).toBe("newer");
    expect(compareE2eKey({ v: 1, pub: "a" }, { v: 1, pub: "a" })).toBe("same");
    expect(compareE2eKey({ v: 2, pub: "b" }, { v: 1, pub: "a" })).toBe("stale");
    expect(compareE2eKey({ v: 1, pub: "a" }, { v: 1, pub: "c" })).toBe("stale");
  });
});
