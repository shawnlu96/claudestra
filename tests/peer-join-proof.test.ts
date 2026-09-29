/**
 * 加入邀请时的持钥证明（lib/invite-proof.ts、manager/peer-join.ts cmdPeerJoinAuto）：
 * 邀请里的 fp / iid 是自报的，合进已有记录、记下指纹 / 实例 id 都要邀请方用那把钥匙签的证明。
 * 场景：本机已有联系人 victim（V 先兑换过本机的邀请：有 fp、公钥、实例 id，没有出站地址）。
 * 「邀请方」是本地起的假 bridge，按用例决定回什么证明。状态文件写在 preload 的临时 STATE_DIR，peer 名各用各的。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, SIG_HEADERS, signedHeaders, signPurpose, verifySigned, type InstanceKey } from "../src/lib/instance-key.js";
import { checkInviteProof, INVITE_PROOF_PURPOSE, judgeJoin, newInviteNonce, signInviteProof } from "../src/lib/invite-proof.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { readPeers } from "../src/lib/peers.js";
import { cmdPeerJoinAuto } from "../src/manager/peer-join.js";

const newKey = () => instanceKeySync(mkdtempSync(join(tmpdir(), "join-proof-")))!;
const keyV = newKey(), keyM = newKey(), keyN = newKey();
const fpV = keyFingerprint(keyV.publicKey), fpM = keyFingerprint(keyM.publicKey), fpN = keyFingerprint(keyN.publicKey);
const IID_V = "c1c2c3c4c5c6c7c8c9c0d1d2";
const AT = "2026-09-01T00:00:00.000Z";

type Mode = { key: InstanceKey | null; iid?: string; nonce?: (sent: string) => string };
let mode: Mode = { key: null };
let server: ReturnType<typeof Bun.serve>;
const url = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  writeFileSync(join(STATE_DIR, "principals.json"), JSON.stringify({ principals: [
    { id: "token:tok_jp_v", role: "external", name: "peer-victim", agents: ["*"], secret: "v".repeat(48), createdAt: AT, peer: "victim" },
  ] }));
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({
    httpPeers: [{ name: "victim", inTokenId: "tok_jp_v", instanceId: IID_V, fp: fpV, publicKey: keyV.publicKey, addedAt: AT }],
    pendingInvites: [],
  }));
  // 假邀请方：兑换一律成功，证明按 mode 签（key=null = 老版本，不给证明）
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const body = await req.json() as { join: string; nonce?: string };
    const redeemer = keyFingerprint(req.headers.get(SIG_HEADERS.key)!);
    const nonce = mode.nonce ? mode.nonce(body.nonce ?? "") : body.nonce ?? "";
    const proof = mode.key ? signInviteProof(nonce, body.join, redeemer, mode.iid ?? "", mode.key) : null;
    return Response.json({ ok: true, peer: "me", agents: ["a"], ...(proof ? { proof, iid: mode.iid ?? "" } : {}) });
  } });
});
afterAll(() => {
  server.stop(true);
  for (const f of ["principals.json", "peers.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
});

/** 手拼邀请串（encodePeerInviteV2 会自动带上本机的实例 id）；fp / iid 都是邀请方自报的 */
const invite = (name: string, fp?: string, iid?: string) =>
  Buffer.from(JSON.stringify({ v: 2, name, url: url(), token: "t".repeat(32), join: `join-${name}-${"x".repeat(16)}`, ...(fp ? { fp } : {}), ...(iid ? { iid } : {}) })).toString("base64url");
async function joinWith(m: Mode, inv: string): Promise<Record<string, unknown>> {
  mode = m;
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await cmdPeerJoinAuto(inv, "", "", false);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally {
    log.mockRestore();
  }
}
const rec = async (name: string) => (await readPeers()).httpPeers?.find((p) => p.name === name);

describe("持钥证明（纯逻辑）", () => {
  const nonce = newInviteNonce();
  test("nonce 是 128 位随机数，每次不同", () => {
    expect(Buffer.from(nonce, "base64url").length).toBe(16);
    expect(newInviteNonce()).not.toBe(nonce);
  });
  test("签名覆盖 nonce、口令、兑换方指纹、邀请方实例 id：换任何一项都对不上（重放、转给别的兑换方都不行）", () => {
    const proof = signInviteProof(nonce, "j", fpN, "iid1", keyV)!;
    const x = { nonce, join: "j", myFp: fpN, inviterIid: "iid1" };
    expect(checkInviteProof(proof, x)).toEqual({ key: keyV.publicKey, fp: fpV });
    for (const bad of [{ nonce: newInviteNonce() }, { join: "k" }, { myFp: fpM }, { inviterIid: "iid2" }]) expect(checkInviteProof(proof, { ...x, ...bad })).toBe("bad");
    expect(checkInviteProof(undefined, x)).toBeNull();
    expect(checkInviteProof({ key: keyV.publicKey }, x)).toBe("bad");
    expect(signInviteProof("", "j", fpN, "", keyV)).toBeNull(); // 老版本加入方不带 nonce：不签
    expect(signInviteProof(nonce, "j", "", "", keyV)).toBeNull(); // 不知道兑换方是谁：不签
  });
  test("跨用途挪用：请求签名当不了证明，证明也当不了请求签名", () => {
    const req = signedHeaders("POST", "/api/v1/peers/redeem", "b", keyV);
    expect(checkInviteProof({ key: keyV.publicKey, sig: req[SIG_HEADERS.sig] }, { nonce, join: "j", myFp: fpN, inviterIid: "" })).toBe("bad");
    const proof = signInviteProof(nonce, "j", fpN, "", keyV)!;
    expect(verifySigned(keyV.publicKey, { method: "POST", path: "/api/v1/peers/redeem", ts: req[SIG_HEADERS.ts]!, sig: proof.sig, body: "b" })).toBe("bad");
    expect(signPurpose("claudestra-req-v1", ["x"], keyV)).toBeNull(); // 用途前缀不能冒充请求签名
    expect(INVITE_PROOF_PURPOSE).toBe("claudestra-invite-pop-v1");
  });
  test("judgeJoin：合进有期望指纹的记录必须有对得上的证明（记了公钥的比公钥）；relay:// 地址里的指纹等于期望指纹也算", () => {
    const before = { name: "victim", publicKey: keyV.publicKey };
    const pv = { key: keyV.publicKey, fp: fpV };
    expect(judgeJoin({ before, anchor: fpV, relayFp: null, proof: pv, inviterIid: "i" })).toEqual({ fields: { fp: fpV, publicKey: keyV.publicKey, instanceId: "i" } });
    expect(judgeJoin({ before, anchor: fpV, relayFp: null, proof: null, inviterIid: "" })).toMatchObject({ error: expect.stringContaining("没法确认") });
    expect(judgeJoin({ before: { name: "victim", publicKey: keyN.publicKey }, anchor: fpV, relayFp: null, proof: pv, inviterIid: "" })).toHaveProperty("error");
    expect(judgeJoin({ before, anchor: fpV, relayFp: fpV, proof: null, inviterIid: "" })).toEqual({ fields: { fp: fpV } });
    expect(judgeJoin({ before: null, anchor: null, claimedFp: fpV, relayFp: null, proof: { key: keyM.publicKey, fp: fpM }, inviterIid: "" })).toHaveProperty("error");
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: null, inviterIid: "" })).toEqual({ fields: {} });
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: "bad", inviterIid: "" })).toHaveProperty("error");
  });
});

describe("加入邀请：自报的指纹 / 实例 id 不能冒名合并", () => {
  test("邀请自报 victim 的指纹、邀请方用自己的钥匙签证明 → 拒绝并回滚，victim 记录不动", async () => {
    const out = await joinWith({ key: keyM }, invite("victim", fpV, IID_V));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("不是同一把");
    expect(await rec("victim")).toMatchObject({ fp: fpV, instanceId: IID_V });
    expect((await rec("victim"))?.baseUrl).toBeUndefined();
  });
  test("同上但邀请方给不出证明（老版本）→ 拒绝并回滚，提示对方升级或删掉旧联系人", async () => {
    const out = await joinWith({ key: null }, invite("victim", fpV));
    expect(out.ok).toBe(false);
    expect(String(out.hint)).toContain("删掉旧联系人再加入");
    expect((await rec("victim"))?.baseUrl).toBeUndefined();
  });
  test("证明是拿上一次的 nonce 签的（重放）→ 拒绝", async () => {
    const out = await joinWith({ key: keyV, iid: IID_V, nonce: () => newInviteNonce() }, invite("victim", fpV));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("持钥证明对不上");
  });
  test("证明里的实例 id 已属于别的联系人 → 拒绝，不建第二条同实例 id 的记录", async () => {
    const out = await joinWith({ key: keyN, iid: IID_V }, invite("newbie", fpN));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("「victim」");
    expect(await rec("newbie")).toBeUndefined();
  });
  test("老版本邀请方、新联系人：照常加入，只是不记指纹 / 实例 id", async () => {
    const out = await joinWith({ key: null }, invite("fresh"));
    expect(out).toMatchObject({ ok: true, peer: "fresh" });
    const r = await rec("fresh");
    expect(r?.fp).toBeUndefined();
    expect(r?.instanceId).toBeUndefined();
  });
  test("V 本人（证明钥匙就是记录的公钥）→ 合进 victim，补上出站地址、记下实例 id", async () => {
    const out = await joinWith({ key: keyV, iid: IID_V }, invite("whatever", fpV, IID_V));
    expect(out).toMatchObject({ ok: true, peer: "victim" });
    expect(await rec("victim")).toMatchObject({ baseUrl: url(), fp: fpV, publicKey: keyV.publicKey, instanceId: IID_V });
  });
});
