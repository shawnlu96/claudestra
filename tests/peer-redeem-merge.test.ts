/**
 * 兑换邀请时按实例 id 合并（manager/peers.ts cmdPeerInviteRedeem → lib/peers.ts isSameRedeemer）：
 * 实例 id 是自报的，只有签名指纹等于原记录的期望指纹才合并；实例 id 撞上别人的记录而指纹对不上 → 拒绝兑换，原记录与 token 不动。
 * 场景：C（本机）已有联系人 V（记录有 fp）；M 手里有 C 的一张有效邀请、知道 V 的实例 id。
 * 状态文件写在 preload 的临时 STATE_DIR，peer 名各用各的。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { readPeers } from "../src/lib/peers.js";
import { readPrincipals } from "../src/lib/principals.js";
import { checkInviteProof } from "../src/lib/invite-proof.js";
import { authenticateApi } from "../src/bridge/api-auth.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { cmdPeerInviteRedeem } from "../src/manager/peer-join.js";

const newKey = () => instanceKeySync(mkdtempSync(join(tmpdir(), "redeem-merge-")))!;
const keyV = newKey(), keyM = newKey();
const fpV = keyFingerprint(keyV.publicKey), fpM = keyFingerprint(keyM.publicKey);
const IID_V = "a1b2c3d4e5f6a7b8c9d0e1f2";
const SECRET = { v: "v".repeat(48), i1: "1".repeat(48), i2: "2".repeat(48), i3: "3".repeat(48) };
const AT = "2026-09-01T00:00:00.000Z";

beforeAll(() => {
  const tok = (id: string, secret: string, peer: string) => ({ id: `token:${id}`, role: "external", name: `peer-${peer}`, agents: ["*"], secret, createdAt: AT, peer });
  writeFileSync(join(STATE_DIR, "principals.json"), JSON.stringify({ principals: [
    tok("tok_rm_v", SECRET.v, "rm-victim"),
    tok("tok_rm_i1", SECRET.i1, "invite:inv_rm1"), tok("tok_rm_i2", SECRET.i2, "invite:inv_rm2"), tok("tok_rm_i3", SECRET.i3, "invite:inv_rm3"),
  ] }));
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const inv = (n: number) => ({ id: `inv_rm${n}`, joinSecret: `join-secret-rm-${n}`, inTokenId: `tok_rm_i${n}`, agents: ["*"], url: "http://c.example", createdAt: AT, expiresAt });
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({
    httpPeers: [{ name: "rm-victim", inTokenId: "tok_rm_v", instanceId: IID_V, fp: fpV, addedAt: AT }],
    pendingInvites: [inv(1), inv(2), inv(3)],
  }));
});
afterAll(() => {
  for (const f of ["principals.json", "peers.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
});

/** 跑一次兑换，返回 manager 打出的 JSON */
async function redeem(join: string, name: string, iid: string, fp: string, pk = "", nonce = ""): Promise<Record<string, unknown>> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await cmdPeerInviteRedeem({ join, name, url: "", token: "", iid, fp, pk, nonce });
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally {
    log.mockRestore();
  }
}
async function call(secret: string, key: typeof keyV): Promise<number | string> {
  const path = "/api/v1/agents";
  const r = new Request(`http://127.0.0.1:1${path}`, { headers: { authorization: `Bearer ${secret}`, ...signedHeaders("GET", path, "", key) } });
  setRequestContext(r, { source: "lan", clientIp: null, https: false });
  const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
  return p instanceof Response ? p.status : p.peer!;
}
const rec = async (name: string) => (await readPeers()).httpPeers?.find((p) => p.name === name);
const tokenDisabled = async (id: string) => !!(await readPrincipals()).principals.find((p) => p.id === `token:${id}`)?.disabled;

const pending = async (id: string) => !!(await readPeers()).pendingInvites?.some((i) => i.id === id);

describe("按实例 id 合并：签名指纹对不上就拒绝兑换", () => {
  test("接管前：V 调 C 正常", async () => {
    expect(await call(SECRET.v, keyV)).toBe("rm-victim");
  });
  test("M 用自己的钥匙签名兑换、带 V 的实例 id、不带 url → 拒绝；V 的记录和 token 不动，邀请没被用掉", async () => {
    const out = await redeem("join-secret-rm-1", "rm-victim", IID_V, fpM);
    expect(out).toMatchObject({ ok: false, code: "iid_taken" });
    expect(String(out.error)).toContain("删掉旧联系人再重新邀请");
    expect((await readPeers()).httpPeers?.map((p) => p.name)).toEqual(["rm-victim"]);
    expect((await rec("rm-victim"))?.fp).toBe(fpV);
    expect(await tokenDisabled("tok_rm_v")).toBe(false);
    expect(await pending("inv_rm1")).toBe(true);
  });
  test("之后 M 冒充不了 V；V 自己照常", async () => {
    expect(await call(SECRET.v, keyM)).toBe(401);
    expect(await call(SECRET.v, keyV)).toBe("rm-victim");
  });
  test("不签名兑换（没有指纹）带 V 的实例 id → 同样拒绝", async () => {
    expect(await redeem("join-secret-rm-2", "rm-victim", IID_V, "")).toMatchObject({ ok: false, code: "iid_taken" });
    expect(await tokenDisabled("tok_rm_v")).toBe(false);
  });
  test("同一张邀请因实例 id 冲突被拒满 3 次 → 作废并吊销内嵌 token，之后连正常兑换也不行", async () => {
    // 上一条用例已经在 inv_rm2 上被拒过一次
    expect(await redeem("join-secret-rm-2", "x", IID_V, fpM)).toMatchObject({ ok: false, code: "iid_taken" });
    expect(await pending("inv_rm2")).toBe(true);
    const third = await redeem("join-secret-rm-2", "x", IID_V, fpM);
    expect(third).toMatchObject({ ok: false, code: "iid_taken" });
    expect(String(third.error)).toContain("这张邀请已作废");
    expect(await pending("inv_rm2")).toBe(false);
    expect(await tokenDisabled("tok_rm_i2")).toBe(true);
    expect(await redeem("join-secret-rm-2", "x", "", fpM)).toMatchObject({ ok: false });
  });
  test("M 不冒用实例 id 兑换 → 以自己的新名字加入，不碰 V", async () => {
    expect(await redeem("join-secret-rm-1", "rm-victim", "", fpM)).toMatchObject({ ok: true, peer: "rm-victim-2" });
    expect(await call(SECRET.i1, keyM)).toBe("rm-victim-2");
    expect((await rec("rm-victim"))?.fp).toBe(fpV);
  });
  test("V 本人重新加入（签名指纹对得上）→ 合进原记录，吊销被取代的旧 token", async () => {
    const nonce = "n".repeat(22);
    const out = await redeem("join-secret-rm-3", "anything", IID_V, fpV, keyV.publicKey, nonce);
    expect(out).toMatchObject({ ok: true, peer: "rm-victim", revokedTokens: ["tok_rm_v"] });
    // 带了 nonce：回一份本机的持钥证明，覆盖 nonce、口令、兑换方指纹、本机实例 id
    const mine = instanceKeySync()!;
    expect(checkInviteProof(out.proof, { nonce, join: "join-secret-rm-3", myFp: fpV, inviterIid: String(out.iid) })).toEqual({ key: mine.publicKey, fp: keyFingerprint(mine.publicKey) });
    expect((await rec("rm-victim"))?.publicKey).toBe(keyV.publicKey);
    expect((await rec("rm-victim"))?.fp).toBe(fpV);
    expect(await call(SECRET.i3, keyV)).toBe("rm-victim");
    expect(await call(SECRET.v, keyV)).toBe(401);
  });
});
