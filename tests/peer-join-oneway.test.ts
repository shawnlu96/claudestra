/**
 * 单向配对后加入对方的邀请（i28-R8）：carol 只单向加入过本机的邀请，本机记录里有 e2e、实例 id、钉住的公钥，却没有地址和 outToken。
 * 这时本机加入 carol 发来的 relay:// 加密邀请：兑换直接发到邀请里的地址（不进会话层，否则按指纹撞上这条空地址记录 → e2e_bad_peer），
 * 持钥证明核过之后才把地址和 outToken 落到这条记录上；证明不过、指纹对不上一律拒，记录一个字节都不动。
 * 本机状态 = 测试进程的 STATE_DIR；「bridge」是个假的 /relay/request（manager 经它代调中继），把兑换转给 carol / mallory 的应答函数。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { keyFingerprint } from "../src/lib/instance-key.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { localE2e, type LocalE2e } from "../src/lib/peer-e2e-local.ts";
import { openRedeemRequest, sealRedeemResponse, type SealedRedeem } from "../src/lib/peer-e2e-redeem.ts";
import { signInviteProof } from "../src/lib/invite-proof.ts";
import { encodePeerInviteV2, readPeers, writePeers, type HttpPeer, type PeerInviteV2 } from "../src/lib/peers.ts";
import { b64 } from "../src/lib/relay-stream.ts";
import { issuePeerToken } from "../src/manager/peers.ts";
import { peerCliFetch } from "../src/manager/relay.ts";
import { runPeerInviteCommand } from "../src/manager/peers-invite-cli.ts";

const STATE_FILES = ["registry.json", "peers.json", "principals.json", "peer-keys.json"];
const saved = new Map<string, string | null>();
const CAROL_IID = "c0c0c0c0c0c0c0c0c0c0c0c0";
const dirs: string[] = [];
let carol: LocalE2e, mallory: LocalE2e, me: LocalE2e;
let bridge: Server<undefined>;
let prevBridgeUrl: string | undefined;

/** 假 bridge 收到的中继代调：发给谁、什么路径 */
const relayed: { to: string; path: string }[] = [];
type Mode = "carol" | "no-proof" | "mallory";
let mode: Mode = "carol";

/** 邀请方的兑换应答：解开信封（按邀请里自报的指纹），回加密的成功体；持钥证明按 mode 由谁签、签不签 */
async function answer(body: SealedRedeem, claimedFp: string): Promise<Response> {
  const who = mode === "mallory" ? mallory : carol;
  const opened = await openRedeemRequest(who.machine.pair, claimedFp, body);
  if (!opened) return Response.json({ ok: false, error: "cannot open" }, { status: 400 });
  const p = opened.payload as { nonce: string; join: string; inviteUrl: string; idk: string };
  const fields = { nonce: p.nonce, join: p.join, redeemerFp: keyFingerprint(p.idk), inviterIid: CAROL_IID, inviteUrl: p.inviteUrl };
  const proof = mode === "no-proof" ? {} : { proof: signInviteProof(fields, who.key), iid: CAROL_IID };
  return Response.json(await sealRedeemResponse(opened.session, { ok: true, peer: "me", agents: ["x"], ...proof }));
}

async function manager(...args: string[]): Promise<any> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => void out.push(String(s));
  try {
    await runPeerInviteCommand(args[0]!, args.slice(1));
  } finally {
    console.log = orig;
  }
  return JSON.parse(out.at(-1) ?? "null");
}

beforeAll(async () => {
  for (const f of STATE_FILES) saved.set(f, existsSync(join(STATE_DIR, f)) ? readFileSync(join(STATE_DIR, f), "utf8") : null);
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: { "agent-x": { name: "agent-x", external: true } } }));
  const mk = async () => (await localE2e(dirs[dirs.push(mkdtempSync(join(tmpdir(), "peer-oneway-"))) - 1]))!;
  carol = await mk();
  mallory = await mk();
  me = (await localE2e())!;
  bridge = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const j = (await req.json()) as { to: string; path: string; body?: string };
      relayed.push({ to: j.to, path: j.path });
      if (j.path !== "/api/v1/peers/redeem") return Response.json({ ok: false, code: "no_route", error: "fake bridge answers redeem only" }, { status: 502 });
      const body = JSON.parse(new TextDecoder().decode(b64.dec(j.body ?? ""))) as SealedRedeem;
      const res = await answer(body, j.to);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return Response.json({ ok: true, status: res.status, headers: { "content-type": "application/json" }, body: b64.enc(bytes) });
    },
  });
  prevBridgeUrl = process.env.BRIDGE_URL;
  process.env.BRIDGE_URL = `ws://127.0.0.1:${bridge.port}`; // lib/bridge-port.ts bridgeHttpBase 每次现读
});

afterAll(() => {
  bridge?.stop(true);
  process.env.BRIDGE_URL = prevBridgeUrl;
  for (const [f, v] of saved) v === null ? rmSync(join(STATE_DIR, f), { force: true }) : writeFileSync(join(STATE_DIR, f), v);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** carol 单向加入过本机邀请之后的样子：入站 token、实例 id、钉住的身份公钥与 E2E 公钥块，没有地址和 outToken */
async function seedOneWay(): Promise<HttpPeer> {
  for (const f of ["peers.json", "principals.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
  const { tokenId } = await issuePeerToken("carol", ["x"]);
  const rec: HttpPeer = {
    name: "carol", inTokenId: tokenId, instanceId: CAROL_IID, fp: carol.fp, publicKey: carol.key.publicKey,
    e2e: { idk: carol.key.publicKey, ek: carol.signed }, addedAt: new Date().toISOString(),
  };
  await writePeers({ httpPeers: [rec] });
  return rec;
}

const invite = (over: Partial<PeerInviteV2> = {}) => encodePeerInviteV2({
  v: 2, name: "carol", url: `relay://${carol.fp}`, token: "t".repeat(40), join: "j".repeat(40), iid: CAROL_IID,
  fp: carol.fp, idk: carol.key.publicKey, ek: carol.signed, ...over,
});
const peersFile = () => readFileSync(join(STATE_DIR, "peers.json"), "utf8");

describe("单向记录下加入对方的加密邀请", () => {
  beforeEach(async () => {
    relayed.length = 0;
    mode = "carol";
    await seedOneWay();
  });

  test("会话层对这条空地址记录照旧拒（e2e_bad_peer，不退回明文）——兑换因此不能走会话层", async () => {
    await expect(peerCliFetch(`relay://${carol.fp}/api/v1/agents`)).rejects.toThrow(/lacks an address/);
    expect(relayed).toEqual([]);
  });

  test("加入成功：兑换发到邀请里的地址，合进原记录并补上地址与 outToken，钉住的钥匙不变", async () => {
    const o = await manager("peer-join-auto", invite());
    expect(o).toMatchObject({ ok: true, peer: "carol", remoteAgents: ["x"] });
    expect(relayed).toEqual([{ to: carol.fp, path: "/api/v1/peers/redeem" }]);
    const all = (await readPeers()).httpPeers ?? [];
    expect(all.map((p) => p.name)).toEqual(["carol"]);
    expect(all[0]).toMatchObject({
      baseUrl: `relay://${carol.fp}`, outToken: "t".repeat(40), fp: carol.fp, publicKey: carol.key.publicKey, instanceId: CAROL_IID,
      e2e: { idk: carol.key.publicKey, ek: carol.signed },
    });
  });

  test("加入后会话层有了地址：同一条记录能照常发起 E2E（不再 e2e_bad_peer）", async () => {
    expect((await manager("peer-join-auto", invite())).ok).toBe(true);
    // 假 bridge 只会应答兑换：这里只要出站没在本地被 e2e_bad_peer 拦下、真的发到了中继就算过
    await expect(peerCliFetch(`relay://${carol.fp}/api/v1/agents`)).rejects.toThrow(/no_route/);
    expect(relayed.at(-1)).toMatchObject({ to: carol.fp, path: expect.stringContaining("/api/v1/e2e/") });
  });

  test("对方回的成功体里没有持钥证明：拒，记录一个字节都不动（地址不先落盘）", async () => {
    mode = "no-proof";
    const before = peersFile();
    const o = await manager("peer-join-auto", invite());
    expect(o.ok).toBe(false);
    expect(o.error).toContain("本地未做改动");
    expect(peersFile()).toBe(before);
  });

  test("邀请冒用 carol 的指纹与 relay 地址、钥匙却是 mallory 的：拒，记录不动", async () => {
    mode = "mallory";
    const before = peersFile();
    const o = await manager("peer-join-auto", invite({ idk: mallory.key.publicKey, ek: mallory.signed }));
    expect(o.ok).toBe(false);
    expect(peersFile()).toBe(before);
    expect((await readPeers()).httpPeers?.[0]?.baseUrl).toBeUndefined();
  });

  test("邀请的指纹就是 mallory 的：不合进 carol 那条（另起一条），carol 的记录不被改道", async () => {
    mode = "mallory";
    const o = await manager("peer-join-auto", invite({ url: `relay://${mallory.fp}`, fp: mallory.fp, idk: mallory.key.publicKey, ek: mallory.signed }));
    const carolRec = (await readPeers()).httpPeers?.find((p) => p.name === "carol");
    expect(carolRec?.baseUrl).toBeUndefined();
    expect(carolRec?.outToken).toBeUndefined();
    if (o.ok) expect(o.peer).not.toBe("carol");
  });
});
