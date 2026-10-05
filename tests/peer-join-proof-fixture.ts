/**
 * 加入邀请时的持钥证明（lib/invite-proof.ts、manager/peer-join.ts cmdPeerJoinAuto）：
 * 邀请里的 fp / iid 是自报的，合进已有记录、记下指纹 / 实例 id 都要邀请方用那把钥匙签的证明。
 * 场景：本机已有联系人 victim（V 先兑换过本机的邀请：有 fp、公钥、实例 id，没有出站地址）。
 * 「邀请方」是本地起的假 bridge，按用例决定回什么证明。只由原入口在私有状态子进程中加载；mode、spy 与状态文件不进入全量套件的进程。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, SIG_HEADERS, signedHeaders, signPurpose, verifySigned, type InstanceKey } from "../src/lib/instance-key.js";
import { checkInviteProof, INVITE_PROOF_PURPOSE, inviteUrlKey, judgeJoin, newInviteNonce, signInviteProof } from "../src/lib/invite-proof.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { readPeers } from "../src/lib/peers.js";
import { cmdPeerJoinAuto } from "../src/manager/peer-join.js";

if (process.env.CLAUDESTRA_JOIN_PROOF_ROLE !== "suite") throw new Error("join proof fixture requires its isolated runner");
const newKey = () => instanceKeySync(mkdtempSync(join(STATE_DIR, "join-proof-key-")))!;
const keyV = newKey(), keyM = newKey(), keyN = newKey();
const fpV = keyFingerprint(keyV.publicKey), fpM = keyFingerprint(keyM.publicKey), fpN = keyFingerprint(keyN.publicKey);
const IID_V = "c1c2c3c4c5c6c7c8c9c0d1d2";
const AT = "2026-09-01T00:00:00.000Z";

/** lax：不核对邀请地址（照自己的地址签证明），模拟不按规矩来的邀请方 */
type Mode = { key: InstanceKey | null; iid?: string; nonce?: (sent: string) => string; lax?: boolean };
let mode: Mode = { key: null };
let server: ReturnType<typeof Bun.serve>;
/** 只把兑换请求原样转给邀请方的中间人 */
let relayServer: ReturnType<typeof Bun.serve>;
const url = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  expect(instanceKeySync(STATE_DIR)).not.toBeNull(); // 显式生成合成的兑换方钥匙
  writeFileSync(join(STATE_DIR, "principals.json"), JSON.stringify({ principals: [
    { id: "token:tok_jp_v", role: "external", name: "peer-victim", agents: ["*"], secret: "v".repeat(48), createdAt: AT, peer: "victim" },
  ] }));
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({
    httpPeers: [{ name: "victim", inTokenId: "tok_jp_v", instanceId: IID_V, fp: fpV, publicKey: keyV.publicKey, addedAt: AT }],
    pendingInvites: [],
  }));
  // 假邀请方：兑换一律成功，证明按 mode 签（key=null = 老版本，不给证明）
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const body = await req.json() as { join: string; nonce?: string; inviteUrl?: string };
    victimUrlDuringRedeem = (await readPeers()).httpPeers?.find((p) => p.name === "victim")?.baseUrl;
    if (!mode.lax && body.inviteUrl && inviteUrlKey(body.inviteUrl) !== inviteUrlKey(url())) return Response.json({ ok: false, code: "invite_url_mismatch" }, { status: 400 });
    const redeemer = keyFingerprint(req.headers.get(SIG_HEADERS.key)!);
    const nonce = mode.nonce ? mode.nonce(body.nonce ?? "") : body.nonce ?? "";
    const f = { nonce, join: body.join, redeemerFp: redeemer, inviterIid: mode.iid ?? "", inviteUrl: mode.lax ? url() : body.inviteUrl ?? "" };
    const proof = mode.key ? signInviteProof(f, mode.key) : null;
    return Response.json({ ok: true, peer: "me", agents: ["a"], ...(proof ? { proof, iid: mode.iid ?? "" } : {}) });
  } });
  relayServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const u = new URL(req.url);
    return fetch(`${url()}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: await req.arrayBuffer() });
  } });
});
afterAll(async () => {
  // 两个 stop 都须完成；任一个 beforeAll 建服失败时也关闭已建好的服务。
  await Promise.all([server?.stop(true), relayServer?.stop(true)]);
  process.stdout.write("JOIN_PROOF_RESULT " + JSON.stringify({ state: STATE_DIR, fp: fpV, redeemer: instanceKeySync(STATE_DIR)!.publicKey }) + "\n");
});

/** 手拼邀请串（encodePeerInviteV2 会自动带上本机的实例 id）；fp / iid 都是邀请方自报的 */
const invite = (name: string, fp?: string, iid?: string, at = url()) =>
  Buffer.from(JSON.stringify({ v: 2, name, url: at, token: "t".repeat(32), join: `join-${name}-${"x".repeat(16)}`, ...(fp ? { fp } : {}), ...(iid ? { iid } : {}) })).toString("base64url");
/** 假邀请方收到兑换时，本机 victim 记录的出站地址（证明核过之前不该被改） */
let victimUrlDuringRedeem: string | undefined | null = null;
async function joinWith(m: Mode, inv: string): Promise<Record<string, unknown>> {
  mode = m;
  victimUrlDuringRedeem = null;
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
  const x = { nonce, join: "j", redeemerFp: fpN, inviterIid: "iid1", inviteUrl: "https://v.example/" };
  test("签名覆盖 nonce、口令、兑换方指纹、邀请方实例 id、邀请地址：换任何一项都对不上（重放、转给别的兑换方、改地址都不行）", () => {
    const proof = signInviteProof(x, keyV)!;
    expect(checkInviteProof(proof, x)).toEqual({ key: keyV.publicKey, fp: fpV });
    expect(checkInviteProof(proof, { ...x, inviteUrl: "HTTPS://V.example" })).toEqual({ key: keyV.publicKey, fp: fpV }); // 大小写、尾斜杠不算改
    const bads = [{ nonce: newInviteNonce() }, { join: "k" }, { redeemerFp: fpM }, { inviterIid: "iid2" }, { inviteUrl: "https://m.example" }, { inviteUrl: "https://v.example/x" }];
    for (const bad of bads) expect(checkInviteProof(proof, { ...x, ...bad })).toBe("bad");
    expect(checkInviteProof(undefined, x)).toBeNull();
    expect(checkInviteProof({ key: keyV.publicKey }, x)).toBe("bad");
    expect(signInviteProof({ ...x, nonce: "" }, keyV)).toBeNull(); // 老版本加入方不带 nonce：不签
    expect(signInviteProof({ ...x, redeemerFp: "" }, keyV)).toBeNull(); // 不知道兑换方是谁：不签
    expect(signInviteProof({ ...x, inviteUrl: "" }, keyV)).toBeNull(); // 加入方没带邀请地址：不签
    expect(inviteUrlKey(`relay://${fpV.toUpperCase()}/`)).toBe(`relay://${fpV}`);
    expect(inviteUrlKey("ftp://x")).toBe("");
  });
  test("跨用途挪用：请求签名当不了证明，证明也当不了请求签名", () => {
    const req = signedHeaders("POST", "/api/v1/peers/redeem", "b", keyV);
    expect(checkInviteProof({ key: keyV.publicKey, sig: req[SIG_HEADERS.sig] }, x)).toBe("bad");
    const proof = signInviteProof(x, keyV)!;
    expect(verifySigned(keyV.publicKey, { method: "POST", path: "/api/v1/peers/redeem", ts: req[SIG_HEADERS.ts]!, sig: proof.sig, body: "b" })).toBe("bad");
    // 只认登记过的用途：冒充请求签名、中继登录签名（原文拼法相同）都签不出来
    for (const p of ["claudestra-req-v1", "claudestra-relay-auth-v2", "claudestra-other-v1"]) expect(signPurpose(p as never, ["x", "y", "z", "w"], keyV)).toBeNull();
    expect(INVITE_PROOF_PURPOSE).toBe("claudestra-invite-pop-v1");
  });
  test("judgeJoin：合进有期望指纹的记录必须有对得上的证明（记了公钥的比公钥）；relay:// 地址里的指纹等于期望指纹也算", () => {
    const before = { name: "victim", publicKey: keyV.publicKey };
    const pv = { key: keyV.publicKey, fp: fpV };
    expect(judgeJoin({ before, anchor: fpV, relayFp: null, proof: pv, inviterIid: "i", legacyOpen: true })).toEqual({ fields: { fp: fpV, publicKey: keyV.publicKey, instanceId: "i" } });
    expect(judgeJoin({ before, anchor: fpV, relayFp: null, proof: null, inviterIid: "", legacyOpen: true })).toMatchObject({ error: expect.stringContaining("没法确认") });
    expect(judgeJoin({ before: { name: "victim", publicKey: keyN.publicKey }, anchor: fpV, relayFp: null, proof: pv, inviterIid: "", legacyOpen: true })).toHaveProperty("error");
    expect(judgeJoin({ before, anchor: fpV, relayFp: fpV, proof: null, inviterIid: "", legacyOpen: true })).toEqual({ fields: { fp: fpV } });
    expect(judgeJoin({ before: null, anchor: null, claimedFp: fpV, relayFp: null, proof: { key: keyM.publicKey, fp: fpM }, inviterIid: "", legacyOpen: true })).toHaveProperty("error");
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: null, inviterIid: "", legacyOpen: true })).toEqual({ fields: {} });
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: "bad", inviterIid: "", legacyOpen: true })).toHaveProperty("error");
    // 截止日后：给不出证明的 http 邀请方直接拒（记下来也永远进不来）；relay:// 地址自带指纹、有证明的照常
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: null, inviterIid: "", legacyOpen: false })).toMatchObject({ error: "对方版本过旧，请先升级" });
    expect(judgeJoin({ before: null, anchor: null, relayFp: fpV, proof: null, inviterIid: "", legacyOpen: false })).toEqual({ fields: { fp: fpV } });
    expect(judgeJoin({ before: null, anchor: null, relayFp: null, proof: { key: keyV.publicKey, fp: fpV }, inviterIid: "", legacyOpen: false })).toHaveProperty("fields");
  });
});

describe("加入邀请：自报的指纹 / 实例 id 不能冒名合并", () => {
  test("邀请自报 victim 的指纹、邀请方用自己的钥匙签证明 → 拒绝并回滚，victim 记录不动", async () => {
    const out = await joinWith({ key: keyM }, invite("victim", fpV, IID_V));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("不是同一把");
    expect(victimUrlDuringRedeem).toBeUndefined(); // 等对方回复期间 victim 的地址也没被改过
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
  test("截止日后老版本邀请方 → 拒绝并回滚，提示对方先升级，不留下进不来的记录", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
    try {
      const out = await joinWith({ key: null }, invite("stale-inviter"));
      expect(out.ok).toBe(false);
      expect(String(out.error)).toContain("对方版本过旧，请先升级");
      expect(await rec("stale-inviter")).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  test("邀请地址被改成中间人、中间人把兑换原样转给真邀请方 → 邀请方比对地址拒绝，victim 记录不动", async () => {
    const out = await joinWith({ key: keyV, iid: IID_V }, invite("victim", fpV, IID_V, `http://127.0.0.1:${relayServer.port}`));
    expect(out).toMatchObject({ ok: false, code: "invite_url_mismatch" });
    expect((await rec("victim"))?.baseUrl).toBeUndefined();
  });
  test("同上但邀请方不核对地址、照自己的地址签证明 → 加入方核证明对不上，拒绝", async () => {
    const out = await joinWith({ key: keyV, iid: IID_V, lax: true }, invite("victim", fpV, IID_V, `http://127.0.0.1:${relayServer.port}`));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("持钥证明对不上");
    expect((await rec("victim"))?.baseUrl).toBeUndefined();
  });
  test("V 本人（证明钥匙就是记录的公钥）→ 合进 victim，补上出站地址、记下实例 id", async () => {
    const out = await joinWith({ key: keyV, iid: IID_V }, invite("whatever", fpV, IID_V));
    expect(out).toMatchObject({ ok: true, peer: "victim" });
    expect(await rec("victim")).toMatchObject({ baseUrl: url(), fp: fpV, publicKey: keyV.publicKey, instanceId: IID_V });
  });
});
