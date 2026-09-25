/**
 * Cross-Claudestra peer state.
 *
 * 存 ~/.claude-orchestrator/peers.json。v2.11 起 peer = HTTP peer：另一个
 * Claudestra 实例作为 API 客户端互访（design docs/design-http-peers.md）。
 * 老的 Discord peer 数据模型已随 Discord peer 机制一并移除——readPeers 只解析
 * httpPeers，老文件里的多余字段自然忽略，不迁移不报错。
 */

import { readJsonLenient, writeJsonStateGuarded } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { instanceIdSync, isInstanceId } from "./instance-id.js";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const DIR = STATE_DIR;
const PATH = `${DIR}/peers.json`;

/**
 * v2.11+ HTTP peer（design docs/design-http-peers.md）：peer = 另一个 Claudestra
 * 实例作为 API 客户端互访。
 */
export interface HttpPeer {
  /** 唯一人读名（"ahh"），send_to_agent 的 `x@ahh` 用它匹配 */
  name: string;
  /** 对方 bridge 基址，如 http://100.x.y.z:3847（Tailscale IP）或 https 反代。
   *  invite 阶段未知（等对方回执），join/accept 补齐 */
  baseUrl?: string;
  /** 我调对方 API 的 Bearer（对方签发给我）。join/accept 前可能暂空 */
  outToken?: string;
  /** 我签给对方的 token 短 id（tok_xxx）——识别入站来源 + revoke 锚点 */
  inTokenId?: string;
  addedAt: string;
  disabled?: boolean;
  /** 对方实例 id（lib/instance-id.ts，对方自报）：认「是不是同一个对方」用；老记录没有 */
  instanceId?: string;
}

/**
 * 加入别人的邀请时：这条既有记录是不是邀请方本人。同一出站地址 = 同一个对方（重新加入 / 换 token）；
 * 同一实例 id 且这条还没有「我→他」= 他先连过我，现在补上反方向。已有别的出站地址就不合并：
 * 实例 id 是自报的，一张邀请不能把既有 peer 的流量改道到新地址。两边实例 id 都有却不同 = 不同实例。
 */
export function isSameInviter(p: HttpPeer, inv: { url: string; iid?: string }): boolean {
  if (p.disabled) return false;
  if (inv.iid && p.instanceId && p.instanceId !== inv.iid) return false;
  if (p.baseUrl) return p.baseUrl === inv.url;
  return !!inv.iid && p.instanceId === inv.iid;
}

/**
 * 对方兑换我的邀请时：这条既有记录是不是他。同一张邀请 token = 重放（幂等）；同一实例 id = 他重新加入过
 * （旧入站 token 由调用方吊销）。他带来的地址跟记录里已有的出站地址不同则不合并——理由同上，防改道。
 */
export function isSameRedeemer(p: HttpPeer, r: { inTokenId: string; iid?: string; url?: string }): boolean {
  if (p.inTokenId === r.inTokenId) return true;
  if (p.disabled || !r.iid || p.instanceId !== r.iid) return false;
  return !r.url || !p.baseUrl || p.baseUrl === r.url;
}

/**
 * v2.15+ 一键邀请的待兑换记录。生成邀请时就把入站 token 预签好（邀请串里
 * 直接携带），对方粘贴邀请 → 他的 bridge 拿 joinSecret 回调我方 /peers/redeem
 * → 自动登记成 HttpPeer，免掉旧三步握手的「回执 + accept」。
 * 一次性 + 24h 过期；撤销/过期时必须连带吊销 inTokenId 指向的 token——
 * 邀请串里带的是真 Bearer，不吊销的话「过期」就是句空话。
 */
export interface PendingInvite {
  /** 短 id（inv_xxxxxxxx）——列表/撤销锚点 */
  id: string;
  /** 一次性兑换凭据（只出现在邀请串里，兑换即失效） */
  joinSecret: string;
  /** 预签的入站 token 短 id（tok_xxx）——撤销/过期时的吊销锚点 */
  inTokenId: string;
  /** 邀请开放的 agent scope（展示用；真源在 token principal） */
  agents: string[];
  /** 生成时的我方 bridge 地址——列表里重新拼出完整邀请串用 */
  url: string;
  createdAt: string;
  expiresAt: string;
}

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PeersData {
  /** v2.11+ HTTP peers（可缺——老文件兼容） */
  httpPeers?: HttpPeer[];
  /** v2.15+ 待兑换的一键邀请（可缺） */
  pendingInvites?: PendingInvite[];
}

const EMPTY: PeersData = { httpPeers: [], pendingInvites: [] };

/**
 * 读者永不抛：缺失 → 空；损坏 → stderr 报一次并沿用上次成功值（没有就空）。
 * 写者（writePeers）遇到磁盘上的坏文件会拒写——manager 的 peer 命令都是读改写，
 * 以前把「坏了」当「空」照写，会把全部 peer 和双方 token 一并抹掉（D7-4）。
 */
export async function readPeers(): Promise<PeersData> {
  const raw = await readJsonLenient<any>(PATH, null, { who: "peers" });
  if (!raw) return structuredClone(EMPTY);
  return {
    httpPeers: Array.isArray(raw?.httpPeers) ? raw.httpPeers : [],
    pendingInvites: Array.isArray(raw?.pendingInvites) ? raw.pendingInvites : [],
  };
}

async function ensureDir() {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

export async function writePeers(data: PeersData): Promise<void> {
  await ensureDir();
  // 原子写(tmp+rename):bridge 与 manager CLI 两个进程都会写本文件,原地覆写
  // 的半写状态会被另一进程读成 EMPTY 再回写,放大成整文件清空(含双方 token,
  // review 2026-07-19 #3)。rename 同卷原子,读者只会看到旧全量或新全量。
  // outToken 是凭据——0600(principals.json 同款);mode 在 open 时就生效,rename 前再 chmod
  await writeJsonStateGuarded(PATH, data, { mode: 0o600 });
}

// ── v2.11+ HTTP peer CRUD ──────────────────────────────────────────────

export async function upsertHttpPeer(peer: Omit<HttpPeer, "addedAt"> & { addedAt?: string }): Promise<HttpPeer> {
  const data = await readPeers();
  data.httpPeers = data.httpPeers || [];
  const existing = data.httpPeers.find((p) => p.name === peer.name);
  if (existing) {
    // 合并:未提供(undefined)或空串的字段保留旧值——invite 重跑只换 inTokenId,
    // 不得清掉已完成握手的 baseUrl/outToken(2026-07-19 review 抓的 bug)
    Object.assign(
      existing,
      Object.fromEntries(Object.entries(peer).filter(([, v]) => v !== undefined && v !== ""))
    );
    await writePeers(data);
    return existing;
  }
  const full: HttpPeer = { addedAt: new Date().toISOString(), ...peer };
  data.httpPeers.push(full);
  await writePeers(data);
  return full;
}

export async function removeHttpPeer(name: string): Promise<HttpPeer | null> {
  const data = await readPeers();
  data.httpPeers = data.httpPeers || [];
  const hit = data.httpPeers.find((p) => p.name === name) ?? null;
  if (hit) {
    data.httpPeers = data.httpPeers.filter((p) => p.name !== name);
    await writePeers(data);
  }
  return hit;
}

export async function findHttpPeer(name: string): Promise<HttpPeer | null> {
  const data = await readPeers();
  return (data.httpPeers || []).find((p) => p.name === name && !p.disabled) ?? null;
}

// ── v2.11+ 握手串（邀请/回执共用一种格式）────────────────────────────────
//
// base64url(JSON {v:1, name, url, token})。name=签发方自报的 peer 名,
// url=签发方 bridge 基址, token=签发方给对方签的 Bearer。
// 邀请串与回执串结构相同——语义由所处握手步骤决定,解析器只有一个。

export interface PeerHandshake {
  v: 1;
  /** 签发方自报名（对方将以此名存我） */
  name: string;
  /** 签发方 bridge 基址 */
  url: string;
  /** 签发方为对方签的 Bearer secret */
  token: string;
}

export function encodePeerHandshake(h: PeerHandshake): string {
  return Buffer.from(JSON.stringify(h), "utf8").toString("base64url");
}

/**
 * peer 基址认两种：直连的 http(s)://，和经中继的 relay://<对方指纹>（bridge/relay-link.ts；指纹格式同
 * instance-key.ts 的 keyFingerprint）。邀请串、CLI 参数、peers.json 都用这一个判定。
 */
export function isPeerBaseUrl(url: unknown): url is string {
  return typeof url === "string" && (/^https?:\/\//.test(url) || relayPeerFingerprint(url) !== null);
}

/** relay://<指纹> 里的指纹；不是中继地址 → null */
export function relayPeerFingerprint(url: string): string | null {
  const m = /^relay:\/\/([0-9a-f]{4}(?:-[0-9a-f]{4}){3})\/?$/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export function parsePeerHandshake(s: string): PeerHandshake | null {
  try {
    const raw = JSON.parse(Buffer.from(s.trim(), "base64url").toString("utf8"));
    if (raw?.v !== 1) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;
    if (!isPeerBaseUrl(raw.url)) return null;
    if (typeof raw.token !== "string" || raw.token.length < 16) return null;
    return { v: 1, name: raw.name, url: raw.url.replace(/\/+$/, ""), token: raw.token };
  } catch {
    return null;
  }
}

// ── v2.15+ 一键邀请串（invite v2:免回执自动握手）──────────────────────────
//
// base64url(JSON {v:2, name, url, token, join})。相比 v1 多一个 join（一次性
// 兑换凭据）:对方粘贴后他的 bridge 自动 POST 我方 /api/v1/peers/redeem 完成
// 登记,不再需要人肉回执/accept。v1 编解码原样保留——旧版本实例仍走三步 CLI。

export interface PeerInviteV2 {
  v: 2;
  /** 邀请方自报名（对方将以此名存我） */
  name: string;
  /** 邀请方 bridge 基址（对方兑换回调 + 之后的 API 调用都打这里） */
  url: string;
  /** 邀请方预签的 Bearer secret */
  token: string;
  /** 一次性兑换凭据（redeem 的鉴权依据） */
  join: string;
  /** 邀请方实例 id（lib/instance-id.ts）。老版本生成的串没有 */
  iid?: string;
}

/** 没给 iid 就带上本机的（本机 id 读写失败时不带，握手照常） */
export function encodePeerInviteV2(i: PeerInviteV2): string {
  const iid = i.iid ?? instanceIdSync();
  return Buffer.from(JSON.stringify(iid ? { ...i, iid } : i), "utf8").toString("base64url");
}

export function parsePeerInviteV2(s: string): PeerInviteV2 | null {
  try {
    const raw = JSON.parse(Buffer.from(s.trim(), "base64url").toString("utf8"));
    if (raw?.v !== 2) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;
    if (!isPeerBaseUrl(raw.url)) return null;
    if (typeof raw.token !== "string" || raw.token.length < 16) return null;
    if (typeof raw.join !== "string" || raw.join.length < 16) return null;
    const iid = isInstanceId(raw.iid) ? { iid: raw.iid } : {}; // 形状不对就当没带（只影响合并，不拒整张邀请）
    return { v: 2, name: raw.name, url: raw.url.replace(/\/+$/, ""), token: raw.token, join: raw.join, ...iid };
  } catch {
    return null;
  }
}

/** 邀请是否已过期（expiresAt 解析失败按已过期处理——宁可多吊销） */
export function inviteExpired(inv: { expiresAt: string }, now = Date.now()): boolean {
  const t = Date.parse(inv.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

// ── pendingInvites CRUD ────────────────────────────────────────────────

export async function addPendingInvite(inv: PendingInvite): Promise<void> {
  const data = await readPeers();
  data.pendingInvites = data.pendingInvites || [];
  data.pendingInvites.push(inv);
  await writePeers(data);
}

export async function removePendingInvite(id: string): Promise<PendingInvite | null> {
  const data = await readPeers();
  data.pendingInvites = data.pendingInvites || [];
  const hit = data.pendingInvites.find((i) => i.id === id) ?? null;
  if (hit) {
    data.pendingInvites = data.pendingInvites.filter((i) => i.id !== id);
    await writePeers(data);
  }
  return hit;
}

/** joinSecret → 待兑换邀请（常数时间比较——这是 redeem 端点唯一的鉴权判据） */
export async function findPendingInviteByJoinSecret(secret: string): Promise<PendingInvite | null> {
  if (!secret || secret.length < 16) return null;
  const { timingSafeEqual } = await import("crypto");
  const data = await readPeers();
  const sb = Buffer.from(secret, "utf8");
  for (const inv of data.pendingInvites || []) {
    const ib = Buffer.from(inv.joinSecret, "utf8");
    if (ib.length === sb.length && timingSafeEqual(ib, sb)) return inv;
  }
  return null;
}

export { PATH as PEERS_PATH };
