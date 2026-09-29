/**
 * 一键邀请的两端（从 manager/peers.ts 搬出）：兑换（我是邀请方，bridge /api/v1/peers/redeem 委托进来）与加入（我是被邀方）。
 * 合并规则：一个对方只有一条记录、一个实例 id 只属于一条记录；合并要有签名证据（兑换方向看兑换请求的签名，
 * 加入方向看邀请方回的持钥证明，lib/invite-proof.ts）。单测在 tests/peer-redeem-merge.test.ts、tests/peer-join-proof.test.ts。
 */
import { output } from "./core.js";
import { classifyJoinError, joinFailureHint, localTailnetAddr, type JoinFailureKind } from "../lib/peer-join-hints.js";
import { resolveMyBridgeUrl, scanTailnetBridges } from "./peers-net.js";
import { instanceIdSync, isInstanceId } from "../lib/instance-id.js";
import { INVITE_MAX_REFUSALS, isPeerBaseUrl, relayPeerFingerprint, relayUrlOf, type PeerInviteV2, type PendingInvite } from "../lib/peers.js";
import { checkInviteProof, judgeJoin, newInviteNonce, signInviteProof } from "../lib/invite-proof.js";
import { legacyStillOpen, peerAnchorOf } from "../lib/peer-trust.js";
import { uniquePeerName } from "./peer-names.js";
import { myFingerprint, peerCliFetch, relayStatus } from "./relay.js";
import { checkPeerScope, disableTokenById, issuePeerToken, selfPeerName } from "./peers.js";

export interface RedeemArgs {
  join: string;
  name: string;
  url: string;
  token: string;
  iid: string;
  /** 兑换方指纹与完整公钥（bridge 核过签名的，bridge/peer-redeem.ts） */
  fp: string;
  pk: string;
  /** 加入方给的一次性随机数：有它（且知道兑换方是谁）才签持钥证明 */
  nonce: string;
}

const REDEEM_FLAGS: Record<string, keyof RedeemArgs> = {
  "--join": "join", "--name": "name", "--url": "url", "--token": "token", "--iid": "iid", "--fp": "fp", "--pk": "pk", "--nonce": "nonce",
};

/** manager peer-invite-redeem 的参数（bridge/peer-redeem.ts redeemArgs 按同样的名字写） */
export function parseRedeemArgs(args: string[]): RedeemArgs {
  const o: RedeemArgs = { join: "", name: "", url: "", token: "", iid: "", fp: "", pk: "", nonce: "" };
  for (let i = 0; i < args.length; i++) {
    const k = REDEEM_FLAGS[args[i]!];
    if (k) o[k] = args[++i] || "";
  }
  return o;
}

/** 兑换因实例 id 冲突被拒：这张邀请记一次，满 INVITE_MAX_REFUSALS 次作废并吊销内嵌 token（一张邀请不能拿来反复试探）。返回是否已作废 */
async function countRefusal(inv: PendingInvite): Promise<boolean> {
  const { readPeers, writePeers } = await import("../lib/peers.js");
  const data = await readPeers();
  const cur = data.pendingInvites?.find((i) => i.id === inv.id);
  if (!cur) return true;
  cur.refusals = (cur.refusals ?? 0) + 1;
  const spent = cur.refusals >= INVITE_MAX_REFUSALS;
  if (spent) data.pendingInvites = data.pendingInvites!.filter((i) => i.id !== inv.id);
  await writePeers(data);
  if (spent) await disableTokenById(inv.inTokenId, true);
  return spent;
}

/** 兑换（我是邀请方）。对方自报 name/url/token/iid——url+token 可缺：缺 = 这次没给我反方向。
 *  iid 命中已有记录、且签名指纹 fp（记了完整公钥的比公钥）对得上那条的期望指纹 = 同一个对方，合进那条。 */
export async function cmdPeerInviteRedeem(a: RedeemArgs) {
  const { findPendingInviteByJoinSecret, removePendingInvite, upsertHttpPeer, inviteExpired, isSameRedeemer, redeemIidTaken } = await import("../lib/peers.js");
  const { readPrincipals, writePrincipals, tokenIdOf } = await import("../lib/principals.js");
  if (!a.join || !a.name) { output({ ok: false, error: "peer-invite-redeem --join <secret> --name <对方名> [--url <对方地址>] [--token <对方token>]" }); return; }
  const inv = await findPendingInviteByJoinSecret(a.join);
  if (!inv) { output({ ok: false, error: "邀请无效或已被使用" }); return; }
  if (inviteExpired(inv)) {
    await removePendingInvite(inv.id);
    await disableTokenById(inv.inTokenId, true);
    output({ ok: false, error: "邀请已过期（24h）——请对方重新生成" });
    return;
  }
  if (a.url && !isPeerBaseUrl(a.url)) { output({ ok: false, error: "对方 url 必须是 http(s):// 开头或 relay://<对方指纹>" }); return; }
  const url = a.url.replace(/\/+$/, "");
  const pk = a.fp ? a.pk : "";
  const who = { inTokenId: inv.inTokenId, iid: a.iid, url, fp: a.fp, pk };
  const finalName = await uniquePeerName(a.name, (p, anchor) => isSameRedeemer(p, who, anchor), (all, anchorOf) => redeemIidTaken(all, who, anchorOf));
  if (!finalName) {
    const spent = await countRefusal(inv);
    const error = `这个实例 id 已绑定另一把钥匙：删掉旧联系人再重新邀请${spent ? "（这张邀请已作废）" : ""}`;
    return output({ ok: false, error, code: "iid_taken" });
  }
  // 预签 token 的占位 peer 名改成对方真名——GET /peers 的 principals ⋈ 靠它
  const file = await readPrincipals();
  const tok = file.principals.find((x) => x.id === `token:${inv.inTokenId}`);
  if (!tok || tok.disabled) {
    await removePendingInvite(inv.id);
    output({ ok: false, error: "邀请对应的 token 已被吊销" });
    return;
  }
  tok.peer = finalName;
  tok.name = `peer-${finalName}`;
  // 一个对方只留一张有效入站 token：同一个人重新加入过，之前那张已被这张取代
  const superseded = file.principals.filter((x) => x !== tok && x.peer === finalName && !x.disabled);
  for (const x of superseded) x.disabled = true;
  await writePrincipals(file);
  const rec = await upsertHttpPeer({
    name: finalName, inTokenId: inv.inTokenId,
    ...(url ? { baseUrl: url } : {}),
    ...(a.token ? { outToken: a.token } : {}),
    ...(a.iid ? { instanceId: a.iid } : {}), ...(a.fp ? { fp: a.fp } : {}), ...(pk ? { publicKey: pk } : {}),
  });
  await removePendingInvite(inv.id);
  const myIid = instanceIdSync() || "";
  const proof = signInviteProof(a.nonce, a.join, a.fp, myIid);
  output({
    ok: true, peer: finalName, agents: inv.agents, oneWay: !rec.outToken, inviteId: inv.id,
    ...(superseded.length ? { revokedTokens: superseded.map(tokenIdOf) } : {}),
    ...(proof ? { proof, iid: myIid } : {}),
  });
}

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

type RedeemRes = { ok?: boolean; error?: string; code?: string; agents?: string[]; peer?: string; proof?: unknown; iid?: unknown } | null;

/** 回调对方 /peers/redeem。带上本机实例 id（对方据此把我合进他已有的那条记录）与这次的 nonce（换对方的持钥证明） */
async function postRedeem(hs: PeerInviteV2, rev: Reverse, nonce: string): Promise<{ res: RedeemRes; err: string; failKind: JoinFailureKind }> {
  let res: RedeemRes = null;
  let err = "", failKind: JoinFailureKind = "other";
  const iid = instanceIdSync();
  try {
    const r = await peerCliFetch(`${hs.url}/api/v1/peers/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        join: hs.join, name: selfPeerName(), nonce,
        ...(iid ? { iid } : {}),
        ...(rev.secret ? { url: rev.url, token: rev.secret } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    res = (await r.json().catch(() => null)) as RedeemRes; // 回的不是 JSON（反代错页）→ 按失败处理，状态码照样判
    if (!r.ok || !res?.ok) err = res?.error || `对方返回 ${r.status}`;
    if (err && r.status >= 400 && r.status < 500) failKind = "rejected";
  } catch (e) {
    err = `连不上对方 bridge: ${(e as Error).message}`;
    failKind = classifyJoinError(e as Error & { code?: unknown });
  }
  return { res, err, failKind };
}

/** 兑换成功后核对方的持钥证明，决定这条记录能不能落地、写什么（lib/invite-proof.ts judgeJoin）；再查实例 id 没被别的记录占着 */
async function settleJoin(hs: PeerInviteV2, name: string, before: { name: string; publicKey?: string } | null, anchor: string | null, res: RedeemRes, nonce: string) {
  const { readPeers } = await import("../lib/peers.js");
  const inviterIid = isInstanceId(res?.iid) ? res.iid : "";
  const proof = checkInviteProof(res?.proof, { nonce, join: hs.join, myFp: myFingerprint() ?? "", inviterIid });
  const v = judgeJoin({ before, anchor, claimedFp: hs.fp, relayFp: relayPeerFingerprint(hs.url), proof, inviterIid });
  if ("error" in v) return v;
  const iid = v.fields.instanceId;
  const other = iid && (await readPeers()).httpPeers?.find((p) => !p.disabled && p.name !== name && p.instanceId === iid);
  if (other) return { error: `你这边已有这台机器的联系人「${other.name}」`, hint: `删掉「${other.name}」再加入，或者继续用它（对方地址变了的话先删再加入）` };
  return v;
}

/** 加入（我是被邀方）：粘贴 v2 邀请串一步完成。默认不向对方开放任何 agent
 *  （--agents 显式给才反向开放）——对称访问 = 对方也生成一张邀请给我。 */
export async function cmdPeerJoinAuto(inviteStr: string, agentsCsv: string, myUrl: string, force: boolean, peerUrlOverride = "") {
  const { parsePeerInviteV2, parsePeerHandshake, upsertHttpPeer, removeHttpPeer, readPeers, writePeers, findHttpPeer, isSameInviter } =
    await import("../lib/peers.js");
  if (!inviteStr) { output({ ok: false, error: "peer-join-auto '<邀请串>' [--agents <a,b>] [--url <我方地址>] [--peer-url <对方地址覆盖>]" }); return; }
  const hs = parsePeerInviteV2(inviteStr);
  // 跨 tailnet 纠偏：邀请串嵌的是发方视角的 tailscale IP，接方看到的可能是映射地址；--peer-url 显式覆盖，连不上时下方兜底扫描给候选
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
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  // 同地址 / 同指纹（他先连过我）→ 合进那条（兑换后要持钥证明确认）；否则撞名后缀防覆盖。没有期望指纹的老记录按实例 id 合并只到截止日
  const finalName = (await uniquePeerName(hs.name, (p, anchor) => isSameInviter(p, hs, anchor, legacyStillOpen())))!; // 没给 refuse，不会是 null
  const before = structuredClone(await findHttpPeer(finalName));
  const anchor = before ? (await peerAnchorOf())(before) : null;
  const rev = await prepareReverse(finalName, agents, myUrl, force);
  if ("error" in rev) { output({ ok: false, error: rev.error }); return; }
  await upsertHttpPeer({ name: finalName, baseUrl: hs.url, outToken: hs.token, ...(rev.tokenId ? { inTokenId: rev.tokenId } : {}) });
  const rollback = async () => {
    if (before) {
      const data = await readPeers();
      data.httpPeers = (data.httpPeers || []).map((p) => (p.name === finalName ? before : p));
      await writePeers(data);
    } else {
      await removeHttpPeer(finalName);
    }
    if (rev.tokenId) await disableTokenById(rev.tokenId, false);
  };
  // 回调对方 redeem——失败必须回滚：半截 peer 会在列表里装成能用的样子
  const nonce = newInviteNonce();
  const { res: redeemRes, err: redeemErr, failKind } = await postRedeem(hs, rev, nonce);
  if (redeemErr) {
    await rollback();
    // 连接类失败 → 扫 tailnet 同端口找可达的 bridge 候选（只做无凭据的 GET 探测，兑换凭据绝不往未确认的地址发）
    const net = failKind === "timeout" || failKind === "refused";
    const candidates = net ? await scanTailnetBridges(hs.url).catch(() => [] as string[]) : [];
    output({ ok: false, error: `加入失败（已回滚）: ${redeemErr}`, failKind, ...(redeemRes?.code ? { code: redeemRes.code } : {}),
      hint: joinFailureHint(failKind, { peerUrl: hs.url, myAddr: net ? await localTailnetAddr() : undefined, candidates, code: redeemRes?.code }) });
    return;
  }
  const settled = await settleJoin(hs, finalName, before, anchor, redeemRes, nonce);
  if ("error" in settled) {
    await rollback();
    output({ ok: false, error: `加入失败（已回滚）: ${settled.error}`, hint: `${settled.hint}。对方那边已经把你加上了，请对方在 Peer 面板移除这条再重新邀请。` });
    return;
  }
  await upsertHttpPeer({ name: finalName, ...settled.fields });
  output({
    ok: true, peer: finalName, peerUrl: hs.url,
    remoteAgents: redeemRes?.agents ?? [],
    exposedAgents: rev.kept ?? agents,
    note: `已接入。send_to_agent 目标写法: "<对方agent>@${finalName}"` +
      (!rev.kept && agents.length === 0 ? "。当前未向对方开放任何 agent——需要对称访问就生成一张自己的邀请发回去。" : ""),
    ...(rev.note ? { warnings: [rev.note] } : {}),
  });
}
