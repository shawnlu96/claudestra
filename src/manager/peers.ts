/**
 * HTTP peer 握手与管理命令（peer-http-* / peer-invite-* / peer-join-auto）。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { repoEnvVar } from "../lib/env-file.js";
import { hostname } from "os";
import { loadRegistry, output } from "./core.js";
import { classifyJoinError, joinFailureHint, localTailnetAddr, type JoinFailureKind } from "../lib/peer-join-hints.js";
import { resolveMyBridgeUrl, scanTailnetBridges } from "./peers-net.js";
import { instanceIdSync } from "../lib/instance-id.js";
import { inviteLink, isPeerBaseUrl, relayUrlOf, type PeerInviteV2 } from "../lib/peers.js";
import { myFingerprint, peerCliFetch, relayStatus } from "./relay.js";

// ── v2.11+ HTTP peer 握手（docs/design-http-peers.md §3）─────────────────

/** peer 名校验:名字要进 `x@peer` / `peer:name.agent` 寻址语法,"@" "." 空白都会
 *  撞分隔符(review 2026-07-19 #11) */
function validPeerName(name: string): boolean {
  return /^[\w-]{1,32}$/.test(name);
}

/** 握手串自报名:对方界面上「谁邀请的我」。USER_NAME 是 setup 时配置的称呼。 */
function selfPeerName(): string {
  return repoEnvVar("USER_NAME").trim().replace(/[^\w-]/g, "") || hostname().split(".")[0];
}

/** invite/join 共用的 scope 校验（token-add 同款 R1 规则,不动原函数避免回归） */
async function checkPeerScope(agents: string[], force: boolean): Promise<{ error?: string; warnings: string[] }> {
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) return { error: `--agents "*" 会把全部 agent 开放给 peer（R1 共享上下文风险）。确认请加 --force。`, warnings };
      warnings.push(`"*" scope：所有普通 agent 都对此 peer 可见`);
      continue;
    }
    if (a === "master") {
      // v2.15+ 无条件拒绝，--force 也不行（owner 2026-07-27:「大总管不可能被
      // peer 分享出去」）。消费侧 agentInScope 对 peer token 有同款硬闸兜历史。
      return { error: `大总管不可开放给 peer——这是硬规则，--force 也不放行。`, warnings };
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) return { error: `agent "${a}" 不存在`, warnings };
    if (!info.external && !force) {
      return { error: `agent "${a}" 未标 external——peer 可套出其上下文既有内容（R1）。建议为 peer 用途 create --external 专用 agent；确实要开放就加 --force。`, warnings };
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }
  return { warnings };
}

/** 为 peer 签 token 并登记 principal。返回 {tokenId, secret} */
async function issuePeerToken(peerName: string, agents: string[]): Promise<{ tokenId: string; secret: string }> {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } = await import("../lib/principals.js");
  const file = await readPrincipals();
  // 同名 peer 的旧 token 先禁用（重跑握手不留悬空凭据）
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) p.disabled = true;
  }
  const p = newTokenPrincipal(`peer-${peerName}`, agents, { peer: peerName });
  file.principals.push(p);
  await writePrincipals(file);
  return { tokenId: tokenIdOf(p), secret: p.secret! };
}

export async function cmdPeerHttpInvite(peerName: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, encodePeerHandshake, findHttpPeer } = await import("../lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || agents.length === 0) {
    output({ ok: false, error: "peer-http-invite <peerName> --agents <a,b> [--url <我方bridge地址>] [--force] [--rotate]（--url 不给会自动探测本机 Tailscale/内网地址）" });
    return;
  }
  const resolvedI = await resolveMyBridgeUrl(myUrl);
  if (!resolvedI) {
    output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>" });
    return;
  }
  myUrl = resolvedI.url;
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)——"@" "." 空格会撞 send_to_agent 的寻址语法` });
    return;
  }
  // 重跑保护:签新 token 会禁用旧 token,已完成握手的 peer 会立刻断联(review #9)
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 invite 会作废对方手里的 token(对方立刻断联,需重新走完三步)。确认轮换请加 --rotate。` });
      return;
    }
  }
  if (!isPeerBaseUrl(myUrl)) {
    output({ ok: false, error: `--url 必须是 http(s):// 开头的对外可达地址（Tailscale IP / 内网 IP / 反代域名）或 relay://<本机指纹>` });
    return;
  }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, inTokenId: tokenId });
  const invite = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, exposedAgents: agents, inTokenId: tokenId,
    warnings: resolvedI.note ? [...check.warnings, resolvedI.note] : check.warnings,
    myUrl,
    invite,
    next: `把 invite 串发给对方 → 对方跑: peer-http-join <你的名字> '<invite串>' --agents <他开放的> --url <他的地址> → 他把回执串发回 → 你跑: peer-http-accept ${peerName} '<回执串>'`,
  });
}

export async function cmdPeerHttpJoin(peerName: string, handshakeStr: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, parsePeerHandshake, encodePeerHandshake, findHttpPeer } = await import("../lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || !handshakeStr || agents.length === 0) {
    output({ ok: false, error: "peer-http-join <peerName> '<邀请串>' --agents <a,b> [--url <我方地址>] [--force] [--rotate]（--url 不给会自动探测本机 Tailscale/内网地址）" });
    return;
  }
  const resolvedJ = await resolveMyBridgeUrl(myUrl);
  if (!resolvedJ) {
    output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>" });
    return;
  }
  myUrl = resolvedJ.url;
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)` });
    return;
  }
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 join 会作废双方 token。确认轮换请加 --rotate。` });
      return;
    }
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "邀请串无法解析（应为 peer-http-invite 输出的 base64 串）" }); return; }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token, inTokenId: tokenId });
  const receipt = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, peerUrl: hs.url, exposedAgents: agents, inTokenId: tokenId,
    warnings: resolvedJ.note ? [...check.warnings, resolvedJ.note] : check.warnings,
    myUrl,
    receipt,
    next: `把 receipt 串发回对方 → 对方跑: peer-http-accept <你在他那的名字> '<receipt串>'。然后双方各自 peer-http-test 验证。`,
  });
}

export async function cmdPeerHttpAccept(peerName: string, handshakeStr: string) {
  const { findHttpPeer, upsertHttpPeer, parsePeerHandshake } = await import("../lib/peers.js");
  if (!peerName || !handshakeStr) {
    output({ ok: false, error: "peer-http-accept <peerName> '<回执串>'" });
    return;
  }
  const existing = await findHttpPeer(peerName);
  if (!existing) {
    output({ ok: false, error: `HTTP peer "${peerName}" 不存在——先跑 peer-http-invite ${peerName} ...` });
    return;
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "回执串无法解析" }); return; }
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token });
  output({ ok: true, peer: peerName, peerUrl: hs.url, note: `握手完成。跑 peer-http-test ${peerName} 验证连通。` });
}

export async function cmdPeerHttpTest(peerName: string) {
  const { findHttpPeer } = await import("../lib/peers.js");
  const peer = await findHttpPeer(peerName);
  if (!peer) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  if (!peer.outToken || !peer.baseUrl) {
    output({ ok: false, error: `握手未完成（${!peer.baseUrl ? "缺对方地址" : "缺 outToken"}）——invite 后要等 accept 回执` });
    return;
  }
  try {
    const res = await peerCliFetch(`${peer.baseUrl}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${peer.outToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      output({ ok: false, error: `对方返回 ${res.status}: ${body?.error || "未知"}`, hint: res.status === 401 ? "token 无效/已 revoke——重新握手" : undefined });
      return;
    }
    const agents = (body?.agents || []).map((a: any) => ({ name: a.name, status: a.status }));
    output({ ok: true, peer: peerName, url: peer.baseUrl, reachable: true, remoteAgents: agents, note: `send_to_agent usage: target="<their-agent>@${peerName}"` });
  } catch (e) {
    output({ ok: false, error: `连接失败: ${(e as Error).message}`, hint: "确认对方 bridge 在线、BRIDGE_BIND 对外可达、URL/端口正确" });
  }
}

export async function cmdPeerHttpList() {
  const { readPeers } = await import("../lib/peers.js");
  const data = await readPeers();
  const peers = (data.httpPeers || []).map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl || "(等待对方回执)",
    handshakeDone: !!(p.outToken && p.baseUrl),
    inTokenId: p.inTokenId,
    disabled: !!p.disabled,
    addedAt: p.addedAt,
  }));
  output({ ok: true, count: peers.length, httpPeers: peers });
}

/** v2.11.1+ 改 peer 入站 scope（token 不换,对方无感;web peer 管理 UI 的后端） */
export async function cmdPeerHttpScope(peerName: string, agentsCsv: string, force: boolean) {
  const { findHttpPeer } = await import("../lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || agents.length === 0) {
    output({ ok: false, error: "peer-http-scope <peerName> --agents <a,b|*> [--force]" });
    return;
  }
  const peer = await findHttpPeer(peerName);
  if (!peer) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { readPrincipals, writePrincipals, tokenIdOf } = await import("../lib/principals.js");
  const file = await readPrincipals();
  const p = file.principals.find((x) => x.peer === peerName && !x.disabled);
  if (!p) {
    output({ ok: false, error: `peer "${peerName}" 没有有效 token——先完成握手（invite/join）` });
    return;
  }
  p.agents = agents;
  await writePrincipals(file);
  output({ ok: true, peer: peerName, exposedAgents: agents, tokenId: tokenIdOf(p), warnings: check.warnings, note: "入站 scope 已更新，立即生效（token 不变）" });
}

export async function cmdPeerHttpRemove(peerName: string) {
  const { removeHttpPeer } = await import("../lib/peers.js");
  const { readPrincipals, writePrincipals } = await import("../lib/principals.js");
  const removed = await removeHttpPeer(peerName);
  if (!removed) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  // 我签出去的 token 一并禁用——对方立刻失去入站能力
  const file = await readPrincipals();
  let revoked = 0;
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) { p.disabled = true; revoked++; }
  }
  if (revoked) await writePrincipals(file);
  output({ ok: true, removed: peerName, tokensRevoked: revoked, note: "对方持有的 token 已失效;我方存的对方 token 已删除" });
}

// ── v2.15+ 一键邀请（invite v2:免回执自动握手,docs/design-http-peers.md）──

/** 按 token 短 id 禁用 principal。onlyUnredeemed=true 时仅动 peer 字段仍是
 *  "invite:*" 占位的（已兑换的 token 归 peer 管理面管,不在这里误伤）。 */
async function disableTokenById(tokenId: string, onlyUnredeemed: boolean): Promise<boolean> {
  const { readPrincipals, writePrincipals } = await import("../lib/principals.js");
  const file = await readPrincipals();
  const p = file.principals.find((x) => x.id === `token:${tokenId}`);
  if (!p || p.disabled) return false;
  if (onlyUnredeemed && !(p.peer || "").startsWith("invite:")) return false;
  p.disabled = true;
  await writePrincipals(file);
  return true;
}

/** 过期邀请清扫：吊销预签 token + 从 pendingInvites 移除。邀请串里带的是
 *  真 Bearer——不吊销的话「24h 过期」就是句空话。invite-new/list/redeem 前都跑。 */
async function sweepExpiredInvites(): Promise<number> {
  const { readPeers, writePeers, inviteExpired } = await import("../lib/peers.js");
  const data = await readPeers();
  const expired = (data.pendingInvites || []).filter((i) => inviteExpired(i));
  if (expired.length === 0) return 0;
  for (const inv of expired) await disableTokenById(inv.inTokenId, true);
  data.pendingInvites = (data.pendingInvites || []).filter((i) => !inviteExpired(i));
  await writePeers(data);
  return expired.length;
}

/** 自报名净化 + 撞名后缀。对方的名字是自报的——撞上已有 peer 时必须换名,
 *  否则一张新邀请就能顶掉既有 peer 的 baseUrl/outToken(peer 劫持)。
 *  sameAs 命中的记录不论叫什么都直接沿用它的名字(一个对方一条记录,lib/peers.ts 的 isSame*)。 */
async function uniquePeerName(
  rawName: string,
  sameAs: (existing: import("../lib/peers.js").HttpPeer) => boolean,
): Promise<string> {
  const { readPeers } = await import("../lib/peers.js");
  const base = rawName.trim().replace(/[^\w-]/g, "").slice(0, 24) || "peer";
  const data = await readPeers();
  const all = data.httpPeers || [];
  const same = all.find(sameAs);
  if (same) return same.name;
  let name = base;
  for (let n = 2; n < 100; n++) {
    if (!all.some((p) => p.name === name)) return name;
    name = `${base}-${n}`;
  }
  return `${base}-${Date.now() % 10000}`;
}

/** 生成一键邀请：预签入站 token + 登记待兑换记录,输出 v2 邀请串。 */
export async function cmdPeerInviteNew(agentsCsv: string, myUrl: string, force: boolean) {
  const { addPendingInvite, encodePeerInviteV2, INVITE_TTL_MS } = await import("../lib/peers.js");
  const { randomBytes } = await import("crypto");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (agents.length === 0) {
    output({ ok: false, error: "peer-invite-new --agents <a,b|*> [--url <我方地址>] [--force]" });
    return;
  }
  await sweepExpiredInvites();
  const relay = myUrl ? null : await relayStatus(); // 没显式给地址且中继已连：邀请写中继地址，对方不需要能直连我
  const resolved: { url: string; note?: string } | null = relay?.connected && relay.fp ? { url: relayUrlOf(relay.fp) } : await resolveMyBridgeUrl(myUrl);
  if (!resolved) { output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>，或配 RELAY_URL 走中继" }); return; }
  myUrl = resolved.url.replace(/\/+$/, "");
  if (!isPeerBaseUrl(myUrl)) {
    output({ ok: false, error: `--url 必须是 http(s):// 开头的对外可达地址或 relay://<本机指纹>` });
    return;
  }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const id = `inv_${randomBytes(4).toString("hex")}`;
  const joinSecret = randomBytes(24).toString("hex");
  // 占位 peer 名 "invite:<id>"——兑换时改成对方自报名。占位前缀同时是
  // 「未兑换」的判定依据(过期清扫只吊销这类)。
  const { tokenId, secret } = await issuePeerToken(`invite:${id}`, agents);
  const now = Date.now();
  await addPendingInvite({
    id, joinSecret, inTokenId: tokenId, agents, url: myUrl,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  });
  const invite = encodePeerInviteV2({ v: 2, name: selfPeerName(), url: myUrl, token: secret, join: joinSecret, fp: myFingerprint() });
  output({
    ok: true, id, agents, myUrl, expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    warnings: resolved.note ? [...check.warnings, resolved.note] : check.warnings,
    invite, ...(relay?.connected && relay.base ? { link: inviteLink(relay.base, invite), fp: relay.fp } : {}),
    next: relay?.connected ? "把链接发给对方，点开即完成（没装 Claudestra 的人会看到安装指引）。24h 未兑换自动作废。" : "把邀请串发给对方（走任意私聊渠道）→ 对方粘贴即完成。24h 未兑换自动作废。",
  });
}

export async function cmdPeerInviteList() {
  const { readPeers, encodePeerInviteV2 } = await import("../lib/peers.js");
  const { readPrincipals } = await import("../lib/principals.js");
  const swept = await sweepExpiredInvites();
  const [data, pf] = await Promise.all([readPeers(), readPrincipals()]);
  const invites = (data.pendingInvites || []).map((i) => {
    const tok = pf.principals.find((x) => x.id === `token:${i.inTokenId}` && !x.disabled);
    return {
      id: i.id, agents: i.agents, createdAt: i.createdAt, expiresAt: i.expiresAt,
      // token secret 还在才拼得出完整串（供「再复制一次」;secret 本就落在本机文件里）
      invite: tok?.secret ? encodePeerInviteV2({ v: 2, name: selfPeerName(), url: i.url, token: tok.secret, join: i.joinSecret, fp: myFingerprint() }) : null,
    };
  });
  output({ ok: true, count: invites.length, invites, ...(swept ? { sweptExpired: swept } : {}) });
}

export async function cmdPeerInviteRevoke(id: string) {
  const { removePendingInvite } = await import("../lib/peers.js");
  if (!id) { output({ ok: false, error: "peer-invite-revoke <inv_id>" }); return; }
  const inv = await removePendingInvite(id);
  if (!inv) { output({ ok: false, error: `邀请 "${id}" 不存在（可能已兑换或已过期清扫）` }); return; }
  const revoked = await disableTokenById(inv.inTokenId, true);
  output({ ok: true, revoked: id, tokenDisabled: revoked, note: "邀请串已作废，其内嵌 token 已吊销" });
}

/** 兑换（我是邀请方,bridge /api/v1/peers/redeem 委托进来）。对方自报 name/url/token/iid——
 *  url+token 可缺:缺 = 这次没给我反方向。iid 命中已有记录 = 同一个对方,合进那条。 */
export async function cmdPeerInviteRedeem(joinSecret: string, peerName: string, peerUrl: string, peerToken: string, iid = "", fp = "") {
  const { findPendingInviteByJoinSecret, removePendingInvite, upsertHttpPeer, inviteExpired, isSameRedeemer } = await import("../lib/peers.js");
  const { readPrincipals, writePrincipals, tokenIdOf } = await import("../lib/principals.js");
  if (!joinSecret || !peerName) { output({ ok: false, error: "peer-invite-redeem --join <secret> --name <对方名> [--url <对方地址>] [--token <对方token>]" }); return; }
  const inv = await findPendingInviteByJoinSecret(joinSecret);
  if (!inv) { output({ ok: false, error: "邀请无效或已被使用" }); return; }
  if (inviteExpired(inv)) {
    await removePendingInvite(inv.id);
    await disableTokenById(inv.inTokenId, true);
    output({ ok: false, error: "邀请已过期（24h）——请对方重新生成" });
    return;
  }
  if (peerUrl && !isPeerBaseUrl(peerUrl)) { output({ ok: false, error: "对方 url 必须是 http(s):// 开头或 relay://<对方指纹>" }); return; }
  const url = peerUrl.replace(/\/+$/, "");
  const finalName = await uniquePeerName(peerName, (p) => isSameRedeemer(p, { inTokenId: inv.inTokenId, iid, url }));
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
    ...(peerToken ? { outToken: peerToken } : {}),
    ...(iid ? { instanceId: iid } : {}), ...(fp ? { fp } : {}),
  });
  await removePendingInvite(inv.id);
  output({
    ok: true, peer: finalName, agents: inv.agents, oneWay: !rec.outToken, inviteId: inv.id,
    ...(superseded.length ? { revokedTokens: superseded.map(tokenIdOf) } : {}),
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
  const resolved = await resolveMyBridgeUrl(myUrl);
  if (!resolved) return { error: "反向开放需要我方对外地址,探测失败——请给 --url" };
  const issued = await issuePeerToken(name, agents);
  return { ...issued, url: resolved.url.replace(/\/+$/, ""), note: resolved.note ?? "" };
}

type RedeemRes = { ok?: boolean; error?: string; agents?: string[]; peer?: string } | null;

/** 回调对方 /peers/redeem。带上本机实例 id：对方据此把我合进他已有的那条记录 */
async function postRedeem(hs: PeerInviteV2, rev: Reverse): Promise<{ res: RedeemRes; err: string; failKind: JoinFailureKind }> {
  let res: RedeemRes = null;
  let err = "", failKind: JoinFailureKind = "other";
  const iid = instanceIdSync();
  try {
    const r = await peerCliFetch(`${hs.url}/api/v1/peers/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        join: hs.join, name: selfPeerName(),
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

/** 加入（我是被邀方）：粘贴 v2 邀请串一步完成。默认不向对方开放任何 agent
 *  （--agents 显式给才反向开放）——对称访问 = 对方也生成一张邀请给我。 */
export async function cmdPeerJoinAuto(inviteStr: string, agentsCsv: string, myUrl: string, force: boolean, peerUrlOverride = "") {
  const { parsePeerInviteV2, parsePeerHandshake, upsertHttpPeer, removeHttpPeer, readPeers, writePeers, findHttpPeer, isSameInviter } =
    await import("../lib/peers.js");
  if (!inviteStr) { output({ ok: false, error: "peer-join-auto '<邀请串>' [--agents <a,b>] [--url <我方地址>] [--peer-url <对方地址覆盖>] [--force]" }); return; }
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
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  // 同地址 / 同实例 id（他先连过我）→ 合进那条；否则撞名后缀防覆盖
  const finalName = await uniquePeerName(hs.name, (p) => isSameInviter(p, hs));
  const before = structuredClone(await findHttpPeer(finalName));
  const rev = await prepareReverse(finalName, agents, myUrl, force);
  if ("error" in rev) { output({ ok: false, error: rev.error }); return; }
  await upsertHttpPeer({
    name: finalName, baseUrl: hs.url, outToken: hs.token,
    ...(hs.iid ? { instanceId: hs.iid } : {}), ...(hs.fp ? { fp: hs.fp } : {}),
    ...(rev.tokenId ? { inTokenId: rev.tokenId } : {}),
  });
  // 回调对方 redeem——失败必须回滚:半截 peer 会在列表里装成能用的样子
  const { res: redeemRes, err: redeemErr, failKind } = await postRedeem(hs, rev);
  if (redeemErr) {
    if (before) {
      const data = await readPeers();
      data.httpPeers = (data.httpPeers || []).map((p) => (p.name === finalName ? before : p));
      await writePeers(data);
    } else {
      await removeHttpPeer(finalName);
    }
    if (rev.tokenId) await disableTokenById(rev.tokenId, false);
    // 连接类失败 → 扫 tailnet 同端口找可达的 bridge 候选(只做无凭据的 GET 探测,
    // 兑换凭据绝不往未确认的地址发)。跨 tailnet 共享的映射地址错位就靠这提示自救。
    const net = failKind === "timeout" || failKind === "refused";
    const candidates = net ? await scanTailnetBridges(hs.url).catch(() => [] as string[]) : [];
    output({ ok: false, error: `加入失败（已回滚）: ${redeemErr}`, failKind,
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
