/**
 * 兑换邀请时按实例 id 合并（manager/peers.ts cmdPeerInviteRedeem → lib/peers.ts isSameRedeemer）：
 * 实例 id 是自报的，只有签名指纹等于原记录的期望指纹才合并；否则另建一条，原记录与它的 token 不动。
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
import { authenticateApi } from "../src/bridge/api-auth.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { cmdPeerInviteRedeem } from "../src/manager/peers.js";

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
async function redeem(join: string, name: string, iid: string, fp: string): Promise<Record<string, unknown>> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await cmdPeerInviteRedeem(join, name, "", "", iid, fp);
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

describe("按实例 id 合并：签名指纹对不上就不合并", () => {
  test("接管前：V 调 C 正常", async () => {
    expect(await call(SECRET.v, keyV)).toBe("rm-victim");
  });
  test("M 用自己的钥匙签名兑换、带 V 的实例 id、不带 url → 另建一条，V 的记录和 token 不动", async () => {
    const out = await redeem("join-secret-rm-1", "rm-victim", IID_V, fpM);
    expect(out).toMatchObject({ ok: true, peer: "rm-victim-2" });
    expect(out.revokedTokens).toBeUndefined();
    expect((await rec("rm-victim"))?.fp).toBe(fpV);
    expect((await rec("rm-victim-2"))?.fp).toBe(fpM);
    expect(await tokenDisabled("tok_rm_v")).toBe(false);
  });
  test("之后 M 只能以自己的新身份调用，冒充不了 V；V 自己照常", async () => {
    expect(await call(SECRET.i1, keyM)).toBe("rm-victim-2");
    expect(await call(SECRET.v, keyM)).toBe(401);
    expect(await call(SECRET.v, keyV)).toBe("rm-victim");
  });
  test("不签名兑换（没有指纹）带 V 的实例 id → 同样另建一条", async () => {
    const out = await redeem("join-secret-rm-2", "rm-victim", IID_V, "");
    expect(out.peer).not.toBe("rm-victim");
    expect(out.revokedTokens).toBeUndefined();
    expect(await tokenDisabled("tok_rm_v")).toBe(false);
  });
  test("V 本人重新加入（签名指纹对得上）→ 合进原记录，吊销被取代的旧 token", async () => {
    const out = await redeem("join-secret-rm-3", "anything", IID_V, fpV);
    expect(out).toMatchObject({ ok: true, peer: "rm-victim", revokedTokens: ["tok_rm_v"] });
    expect((await rec("rm-victim"))?.fp).toBe(fpV);
    expect(await call(SECRET.i3, keyV)).toBe("rm-victim");
    expect(await call(SECRET.v, keyV)).toBe(401);
  });
});
