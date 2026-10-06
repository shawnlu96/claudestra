/**
 * cloud-PP1 抽取的行为等价：固定合成样本上，新纯入口与旧入口（ask-bind / instance-key / shared-ledger-join）的结果逐字节相同，
 * 期望值是抽取前（9ca60d84）旧代码跑出来的。Ed25519 签名是确定性的，同一把合成钥匙签出的串也一并钉住，证明签名原文 / wire 字节没变。
 * 钥匙只由一个测试标签哈希出种子，临时合成，不读本机钥匙。
 */
import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/lib/canonical-json.js";
import * as askBind from "../src/lib/ask-bind.js";
import * as pure from "../src/lib/instance-signature.js";
import * as legacy from "../src/lib/instance-key.js";
import { sharedLedgerCommandDigest, signSharedLedgerRequest } from "../src/lib/shared-ledger-auth.js";
import { sharedLedgerManifestDigest, sharedLedgerProjectionDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { SHARED_LEDGER_COMMAND_FIXTURES, SHARED_LEDGER_IMPORT_FIXTURE, SHARED_LEDGER_PROJECTION_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import * as protocol from "../src/lib/shared-ledger-join-protocol.js";
import * as join_ from "../src/lib/shared-ledger-join.js";
import { testChildEnv } from "./test-env.ts";

const seed = createHash("sha256").update("cloud-PP1 synthetic test key").digest();
const fixedPrivate = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const KEY: pure.InstanceKey = { privateKey: fixedPrivate, publicKey: String(createPublicKey(fixedPrivate).export({ format: "jwk" }).x) };
const PUB = "oslmsorLvB4w8qcxc4MgVlhpybiMqk8r1M2CF7q-OlU";
const freshKey = (): pure.InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const SAMPLE = { z: [3, null, undefined, { b: undefined, a: "x" }], a: { "é": 1, B: true, b: false }, n: null, u: undefined, s: " \"", num: -0, big: 1e21 };

describe("canonical JSON 与摘要", () => {
  const cases: [unknown, string][] = [
    [SAMPLE, `{"a":{"B":true,"b":false,"é":1},"big":1e+21,"n":null,"num":0,"s":" \\"","z":[3,null,null,{"a":"x"}]}`],
    [[undefined, () => 1], "[null,]"], [null, "null"], [undefined, "null"], ["s", `"s"`], [1.5, "1.5"], [[], "[]"], [{}, "{}"],
  ];
  test("属性顺序 / undefined / 数组 / null：新入口与 ask-bind 旧导出同一实现、结果同旧", () => {
    expect(askBind.canonicalJson).toBe(canonicalJson);
    for (const [v, want] of cases) expect(canonicalJson(v)).toBe(want);
  });
  test("bind / command / manifest / projection / v2 object 摘要不变", () => {
    expect(askBind.bindHash({ action: "deploy", params: { b: [1, { y: 2, x: undefined }], a: "v" }, version: undefined }, "agent-x"))
      .toBe("b8a7ce029b874d27a22459b68e1b55ad51d46594aa81a08d060ad0440945cf61");
    expect(askBind.bindHash({ action: "deploy", params: null, version: "v2" }, "agent-x")).toBe("373822b4f816b18dd7d386d1c4576d382a22ae2f04afa39abc918d01174c5726");
    expect(SHARED_LEDGER_COMMAND_FIXTURES.map((f) => sharedLedgerCommandDigest({ ...f, attemptNonce: "0".repeat(32) }))).toEqual([
      "ef13ef8255adceb662c26bf4daa58608ca4ade84a57640d51995fc01b3130d1e", "139f51fb594661ee69736583d34aa0485749cb109cc0cb1de0d37b4b9106a1c6",
      "117bb3d65275d8dd0d34341ffc32a145bc8e285a36ff022a32b8b33e9a8fa02d", "a03df561e8426597166162a076879dcddba9041f3a645650ea922d44b0b741a9",
    ]);
    expect(sharedLedgerManifestDigest(SHARED_LEDGER_IMPORT_FIXTURE.payload.manifest)).toBe("c22b419afeedaf35a55e7a552f2f52a0dcbd97910b827e849992a3f31ca584c9");
    expect(sharedLedgerProjectionDigest(SHARED_LEDGER_PROJECTION_FIXTURE.payload)).toBe("0049aa35ebb89b9edd1a9643f838718504a2f32249a6df203eecb0138782167c");
    expect(v2ObjectDigest(SAMPLE)).toBe("67ad675d6d9c058631c49733e71c4d7988d5d94916123c4ed1e8ac7732004101");
  });
});

describe("实例签名：新纯入口 ↔ 旧 instance-key", () => {
  test("纯函数唯一实现：旧入口的 isPublicKey / verifyPurpose / verifySigned / 常量就是新入口那一份", () => {
    for (const name of ["isPublicKey", "verifyPurpose", "verifySigned", "SIG_HEADERS", "MAX_SKEW_S"] as const) expect(legacy[name]).toBe(pure[name]);
  });
  test("固定合成钥匙：用途签名、请求签名头、共享台账请求签名逐字节同旧", () => {
    expect(KEY.publicKey).toBe(PUB);
    expect(legacy.keyFingerprint(PUB)).toBe("0c3a-b1c9-46f4-0b34");
    const purposeSig = "MrN_OnJ36k1rR4hSWQkqA1va4eAKFX6mLmjTSn5KfNnTh-jpakxdavNVlGKpXcZK7sJ_VOhMXIivysELaGzkBw";
    expect(pure.signPurpose("claudestra-lend-receipt-v1", ["a", "b c"], KEY)).toEqual({ key: PUB, sig: purposeSig });
    expect(legacy.signPurpose("claudestra-lend-receipt-v1", ["a", "b c"], KEY)).toEqual({ key: PUB, sig: purposeSig });
    const hdr = { "x-claudestra-key": PUB, "x-claudestra-ts": "1790000000",
      "x-claudestra-sig": "92FGCBCoB62sRqyqwnQw6svC833PZtwv2_PpPl_ljmhWSe9So1URTfp_gJI5PIvYpBhP4q3l6PlZ_-QoRpFcDQ" };
    expect(pure.signedHeaders("post", "/x?y=1", "body", KEY, 1_790_000_000_123)).toEqual(hdr);
    expect(legacy.signedHeaders("post", "/x?y=1", "body", KEY, 1_790_000_000_123)).toEqual(hdr);
    expect(signSharedLedgerRequest({ method: "POST", path: "/v1/teams/team-a/commands", bearer: "b", instanceId: "instance-a",
      ts: "1790000000", attemptNonce: "1".repeat(32), body: "{}" }, KEY).signature)
      .toBe("vwqri2GY3XASfik9l3nFJNhafH_E8RvSbPUV0kG0lE40I27ejnpolO9y3p2mLkQjMyoWXtvD0mvVBsnUdBXKCA");
  });
  test("临时钥匙交叉签 / 验；换钥匙、篡改、跨用途、换行字段、非规范编码都拒", () => {
    const key = freshKey(), other = freshKey();
    const fields = ["JOIN", "x"];
    const a = pure.signPurpose("claudestra-shared-ledger-v1", fields, key)!;
    const b = legacy.signPurpose("claudestra-shared-ledger-v1", fields, key)!;
    expect(a).toEqual(b);
    expect(legacy.verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", fields, a.sig)).toBe(true);
    expect(pure.verifyPurpose(other.publicKey, "claudestra-shared-ledger-v1", fields, a.sig)).toBe(false);
    expect(pure.verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", ["JOIN", "y"], a.sig)).toBe(false);
    expect(pure.verifyPurpose(key.publicKey, "claudestra-invite-pop-v1", fields, a.sig)).toBe(false);
    expect(pure.signPurpose("claudestra-req-v1" as pure.SignPurpose, fields, key)).toBeNull();
    expect(pure.signPurpose("claudestra-shared-ledger-v1", ["a\nb"], key)).toBeNull();
    expect(pure.signPurpose("claudestra-shared-ledger-v1", fields, null)).toBeNull();
    expect(pure.verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", fields, `${a.sig}=`)).toBe(false);
    expect(pure.verifyPurpose(key.publicKey.slice(0, -1) + "B", "claudestra-shared-ledger-v1", fields, a.sig)).toBe(false);
    expect(pure.verifyPurpose("not-a-key", "claudestra-shared-ledger-v1", fields, a.sig)).toBe(false);
    const NOW = 1_790_000_000_000, body = '{"x":1}';
    const h = legacy.signedHeaders("POST", "/p", body, key, NOW);
    const req = { method: "POST", path: "/p", ts: h[pure.SIG_HEADERS.ts]!, sig: h[pure.SIG_HEADERS.sig]!, body };
    expect(pure.verifySigned(key.publicKey, req, NOW)).toBe("ok");
    expect(pure.verifySigned(key.publicKey, { ...req, body: "{}" }, NOW)).toBe("bad");
    expect(pure.verifySigned(other.publicKey, req, NOW)).toBe("bad");
    expect(pure.verifySigned(key.publicKey, req, NOW + (pure.MAX_SKEW_S + 1) * 1000)).toBe("stale");
    expect(pure.signedHeaders("POST", "/p", body, null, NOW)).toEqual({});
  });
  test("新模块没有默认钥匙：签名必须显式给钥匙；旧 wrapper 不给钥匙时仍取本机（临时状态目录）钥匙", () => {
    expect(pure.signPurpose.length).toBe(3);
    expect(pure.signedHeaders.length).toBe(4);
    expect(Object.keys(pure)).not.toContain("instanceKeySync");
    const dir = mkdtempSync(join(tmpdir(), "pp1-key-"));
    try {
      const state = join(dir, "state");
      const script = `import * as k from ${JSON.stringify(join(import.meta.dir, "../src/lib/instance-key.ts"))};
const local = k.instanceKeySync(${JSON.stringify(state)});
const s = k.signPurpose("claudestra-invite-pop-v1", ["f"]);
const h = k.signedHeaders("GET", "/p", "", undefined, 1790000000000);
console.log(JSON.stringify({ same: s.key === local.publicKey && h["x-claudestra-key"] === local.publicKey,
  ok: k.verifyPurpose(local.publicKey, "claudestra-invite-pop-v1", ["f"], s.sig) }));`;
      const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: dir,
        env: testChildEnv({ HOME: dir, TMPDIR: dir, CLAUDESTRA_STATE_DIR: state }) });
      expect(proc.stderr.toString()).toBe("");
      expect(JSON.parse(proc.stdout.toString())).toEqual({ same: true, ok: true });
      expect(readdirSync(state)).toEqual(["instance-key.pem"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("入组协议：纯模块与旧入口", () => {
  const CENTER = `center-${"a".repeat(32)}`;
  const CODE = `sljoin1.${CENTER}.${"b".repeat(32)}.${"C".repeat(43)}`;
  test("旧路径导出的就是纯模块那一份", () => {
    for (const name of ["SHARED_LEDGER_JOIN_PATH", "SHARED_LEDGER_JOIN_PURPOSE", "formatSharedLedgerJoinCode", "parseSharedLedgerJoinCode",
      "looksLikeSharedLedgerJoinCode", "sharedLedgerInstanceId", "sharedLedgerJoinFields"] as const) expect(join_[name]).toBe(protocol[name]);
  });
  test("join code 格式化 / 解析 / looksLike、instanceId、proof fields 与入组签名同旧", () => {
    expect(protocol.formatSharedLedgerJoinCode({ centerId: CENTER, codeId: "b".repeat(32), secret: "C".repeat(43) })).toBe(CODE);
    expect(protocol.parseSharedLedgerJoinCode(` ${CODE} `)).toEqual({ centerId: CENTER, codeId: "b".repeat(32), secret: "C".repeat(43) });
    for (const bad of [CODE.replace("sljoin1", "sljoin2"), `${CODE}x`, CODE.toUpperCase(), 7, null]) expect(protocol.parseSharedLedgerJoinCode(bad)).toBeNull();
    expect(protocol.looksLikeSharedLedgerJoinCode(`--code=sljoin1.x`)).toBe(true);
    expect(protocol.looksLikeSharedLedgerJoinCode("sljoin2.x")).toBe(false);
    expect(protocol.sharedLedgerInstanceId(PUB)).toBe("sli-0c3ab1c946f40b3460e33c03");
    expect(protocol.sharedLedgerJoinFields(CENTER, CODE, PUB, "sli-1")).toEqual(
      ["JOIN", "/v1/join", CENTER, "4817148fba99f1d84d14088c69dd3a1545c1a77c669f7c3e73965b7e5d3f3819", PUB, "sli-1"]);
    const req = join_.signSharedLedgerJoin(CODE, "sli-1", KEY);
    expect(req).toEqual({ code: CODE, publicKey: PUB, instanceId: "sli-1",
      signature: "oQr1NnWundcPilw2nul5YdLxWJsJMQsmQawcw8o7oDcbdsaFRKvXTMaNHvVWpAynjrQ4D7jhaBcKr5JhUEGxDA" });
    expect(pure.verifyPurpose(PUB, protocol.SHARED_LEDGER_JOIN_PURPOSE, protocol.sharedLedgerJoinFields(CENTER, CODE, PUB, "sli-1"), req.signature)).toBe(true);
  });
  test("grant 的 actions 类型就是中心凭据的 actions（编译期断言）", () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    type GrantAction = protocol.SharedLedgerJoinGrant["projects"][number]["actions"][number];
    const same: Same<GrantAction, "read" | "plan" | "import" | "project"> = true;
    const legacyGrant: join_.SharedLedgerJoinGrant = { centerId: CENTER, teamId: "t", personId: "p", instanceId: "i", bearer: "b", expiresAt: 1,
      role: "member", projects: [{ projectId: "x", actions: ["read"] }] } satisfies protocol.SharedLedgerJoinGrant;
    expect(same).toBe(true);
    expect(legacyGrant.projects[0]!.actions).toEqual(["read"]);
  });
});
