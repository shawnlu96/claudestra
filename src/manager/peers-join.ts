/**
 * 加入别人的一键邀请（peer-join-auto）与它的反向开放、兑换回调。从 manager/peers.ts 逐字搬出（腾出行数给 E2E，
 * docs/relay/e2e-design.md §5.1），函数体随后按 E2E 改：带密钥的邀请走 HPKE 兑换、只在解开的成功响应之后才落盘。
 */
import { output } from "./core.js";
import { classifyJoinError, joinFailureHint, localTailnetAddr, type JoinFailureKind } from "../lib/peer-join-hints.js";
import { resolveMyBridgeUrl, scanTailnetBridges } from "./peers-net.js";
import { instanceIdSync } from "../lib/instance-id.js";
import { relayUrlOf, type PeerInviteV2 } from "../lib/peers.js";
import { fromB64url } from "../lib/e2e/encoding.js";
import { verifyE2eKey } from "../lib/e2e-machine-key.js";
import { localE2e, type LocalE2e } from "../lib/peer-e2e-local.js";
import { readRedeemResponse, sealRedeemRequest } from "../lib/peer-e2e-redeem.js";
import { peerCliFetch, relayStatus } from "./relay.js";
import { checkPeerScope, disableTokenById, issuePeerToken, selfPeerName, uniquePeerName } from "./peers.js";

type Reverse = { tokenId: string; secret: string; url: string; note: string; kept?: string[] };

/** 加入时的反向开放（我→他之外再给他一张 token）。这条记录已有有效入站 token 时不重签：
 *  issuePeerToken 会禁用同名旧 token，兑换一旦失败回滚，对方就两头落空；要改范围去卡片里改。 */
async function prepareReverse(name: string, agents: string[], myUrl: string, force: boolean): Promise<Reverse | { error: string }> {
  const { readPrincipals } = await import("../lib/principals.js");
  const cur = (await readPrincipals()).principals.find((x) => x.peer === name && !x.disabled);
  const none: Reverse = { tokenId: "", secret: "", url: "", note: "" };
  if (cur) return { ...none, kept: cur.agents, note: agents.length ? "对方本来就能访问你（范围不变，要改在卡片里改）" : "" };
  if (agents.length === 0) return none;
  const check = await checkPeerScope(agents, force);
  if (check.error) return { error: check.error };
  const relay = myUrl ? null : await relayStatus(), resolved = relay?.connected && relay.fp ? { url: relayUrlOf(relay.fp) } : await resolveMyBridgeUrl(myUrl); // 同 invite-new：连着中继就让对方经中继找我
  if (!resolved) return { error: "反向开放需要我方对外地址,探测失败——请给 --url" };
  const issued = await issuePeerToken(name, agents);
  return { ...issued, url: resolved.url.replace(/\/+$/, ""), note: resolved.note ?? "" };
}

type RedeemRes = { ok?: boolean; error?: string; agents?: string[]; peer?: string } | null;

/**
 * 回调对方 /peers/redeem。带上本机实例 id：对方据此把我合进他已有的那条记录。
 * 带密钥的邀请（local 有值）：正文用 HPKE 封给邀请方的 E2E 公钥，另带本机身份公钥与签名块；只认解得开的成功响应，
 * 明文的「成功」也当失败（lib/peer-e2e-redeem.ts readRedeemResponse）。
 */
async function postRedeem(hs: PeerInviteV2, rev: Reverse, local: LocalE2e | null): Promise<{ res: RedeemRes; err: string; failKind: JoinFailureKind }> {
  let res: RedeemRes = null;
  let err = "", failKind: JoinFailureKind = "other";
  const iid = instanceIdSync();
  const payload = { join: hs.join, name: selfPeerName(), ...(iid ? { iid } : {}), ...(rev.secret ? { url: rev.url, token: rev.secret } : {}) };
  const sealed = local && hs.ek ? await sealRedeemRequest(fromB64url(hs.ek.pub)!, hs.fp!, { ...payload, idk: local.key.publicKey, key: local.signed }) : null;
  try {
    const r = await peerCliFetch(`${hs.url}/api/v1/peers/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sealed ? sealed.body : payload),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await r.json().catch(() => null); // 回的不是 JSON（反代错页）→ 按失败处理，状态码照样判
    const outcome = sealed ? await readRedeemResponse(sealed.session, r.status, raw) : null;
    res = (outcome ? (outcome.ok ? outcome.value : null) : raw) as RedeemRes;
    if (outcome && !outcome.ok) err = outcome.message;
    else if (!r.ok || !res?.ok) err = res?.error || `对方返回 ${r.status}`;
    if (err && r.status >= 400 && r.status < 500) failKind = "rejected";
  } catch (e) {
    err = `连不上对方 bridge: ${(e as Error).message}`;
    failKind = classifyJoinError(e as Error & { code?: unknown });
  }
  return { res, err, failKind };
}

/** 加入（我是被邀方）：粘贴 v2 邀请串一步完成。默认不向对方开放任何 agent
 *  （--agents 显式给才反向开放）——对称访问 = 对方也生成一张邀请给我。 */
export async function cmdPeerJoinAuto(inviteStr: string, agentsCsv: string, myUrl: string, force: boolean, peerUrlOverride = "") {
  const { parsePeerInviteV2, parsePeerHandshake, upsertHttpPeer, removeHttpPeer, readPeers, writePeers, findHttpPeer, isSameInviter } =
    await import("../lib/peers.js");
  if (!inviteStr) { output({ ok: false, error: "peer-join-auto '<邀请串>' [--agents <a,b>] [--url <我方地址>] [--peer-url <对方地址覆盖>]" }); return; }
  const hs = parsePeerInviteV2(inviteStr);
  // v2.16.1 跨 tailnet 纠偏:邀请串嵌的是**发方视角**的 tailscale IP,跨 tailnet
  // 设备共享下接方看到的是映射地址(2026-07-31 实战:串里 .46,我方视角 .45)。
  // --peer-url 显式覆盖;连不上时下方兜底扫描会给出候选提示。
  if (hs && peerUrlOverride.trim()) hs.url = peerUrlOverride.trim().replace(/\/+$/, "");
  if (!hs) {
    output({
      ok: false,
      error: parsePeerHandshake(inviteStr)
        ? "这是旧版三步握手的邀请串——用 peer-http-join 走旧流程，或让对方升级后重新生成一键邀请"
        : "邀请串无法解析（应为 peer-invite-new 输出的 base64 串）",
    });
    return;
  }
  // 带密钥的邀请：先验邀请方的签名块，读不到本机钥匙就停——两样都不会退回明文兑换
  const local = hs.ek ? await localE2e() : null;
  if (hs.ek && !(await verifyE2eKey(hs.idk!, hs.ek))) { output({ ok: false, error: "邀请里的加密公钥块验签没过（邀请被改过或已损坏）——请对方重新生成" }); return; }
  if (hs.ek && !local) { output({ ok: false, error: "本机 E2E 密钥读不到，无法加密兑换（不会退回明文）" }); return; }
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  // 同地址 / 同实例 id（他先连过我）→ 合进那条；否则撞名后缀防覆盖
  const finalName = await uniquePeerName(hs.name, (p) => isSameInviter(p, hs));
  const before = structuredClone(await findHttpPeer(finalName));
  const rev = await prepareReverse(finalName, agents, myUrl, force);
  if ("error" in rev) { output({ ok: false, error: rev.error }); return; }
  const record = {
    name: finalName, baseUrl: hs.url, outToken: hs.token,
    ...(hs.iid ? { instanceId: hs.iid } : {}), ...(hs.fp ? { fp: hs.fp } : {}),
    ...(rev.tokenId ? { inTokenId: rev.tokenId } : {}), ...(hs.idk && hs.ek ? { e2e: { idk: hs.idk, ek: hs.ek } } : {}),
  };
  // 明文邀请照旧先落盘、失败回滚；带密钥的只在解开的成功响应之后才落盘——失败响应中继能伪造，不能让它改动本地记录
  if (!local) await upsertHttpPeer(record);
  const { res: redeemRes, err: redeemErr, failKind } = await postRedeem(hs, rev, local);
  if (!redeemErr && local) await upsertHttpPeer(record);
  if (redeemErr) {
    // 带密钥的这条路什么都没写过，不用回滚，只作废这次预签的反向 token
    if (!local && before) {
      const data = await readPeers();
      data.httpPeers = (data.httpPeers || []).map((p) => (p.name === finalName ? before : p));
      await writePeers(data);
    } else if (!local) {
      await removeHttpPeer(finalName);
    }
    if (rev.tokenId) await disableTokenById(rev.tokenId, false);
    // 连接类失败 → 扫 tailnet 同端口找可达的 bridge 候选(只做无凭据的 GET 探测,
    // 兑换凭据绝不往未确认的地址发)。跨 tailnet 共享的映射地址错位就靠这提示自救。
    const net = failKind === "timeout" || failKind === "refused";
    const candidates = net ? await scanTailnetBridges(hs.url).catch(() => [] as string[]) : [];
    output({ ok: false, error: `加入失败（${local ? "本地未做改动，可重试" : "已回滚"}）: ${redeemErr}`, failKind,
      hint: joinFailureHint(failKind, { peerUrl: hs.url, myAddr: net ? await localTailnetAddr() : undefined, candidates }) });
    return;
  }
  output({
    ok: true, peer: finalName, peerUrl: hs.url,
    remoteAgents: redeemRes?.agents ?? [],
    exposedAgents: rev.kept ?? agents,
    note: `已接入。send_to_agent 目标写法: "<对方agent>@${finalName}"` +
      (!rev.kept && agents.length === 0 ? "。当前未向对方开放任何 agent——需要对称访问就生成一张自己的邀请发回去。" : ""),
    ...(rev.note ? { warnings: [rev.note] } : {}),
  });
}
