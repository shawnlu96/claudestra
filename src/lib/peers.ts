/**
 * Cross-Claudestra peer state.
 *
 * 存 ~/.claude-orchestrator/peers.json。v2.11 起 peer = HTTP peer：另一个
 * Claudestra 实例作为 API 客户端互访（design docs/design-http-peers.md）。
 * 老的 Discord peer 数据模型已随 Discord peer 机制一并移除——readPeers 只解析
 * httpPeers，老文件里的多余字段自然忽略，不迁移不报错。
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const HOME = process.env.HOME || "";
const DIR = `${HOME}/.claude-orchestrator`;
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
}

export interface PeersData {
  /** v2.11+ HTTP peers（可缺——老文件兼容） */
  httpPeers?: HttpPeer[];
}

const EMPTY: PeersData = { httpPeers: [] };

export async function readPeers(): Promise<PeersData> {
  if (!existsSync(PATH)) return structuredClone(EMPTY);
  try {
    const raw = await Bun.file(PATH).json();
    return {
      httpPeers: Array.isArray(raw?.httpPeers) ? raw.httpPeers : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

async function ensureDir() {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

export async function writePeers(data: PeersData): Promise<void> {
  await ensureDir();
  // 原子写(tmp+rename):bridge 与 manager CLI 两个进程都会写本文件,原地覆写
  // 的半写状态会被另一进程读成 EMPTY 再回写,放大成整文件清空(含双方 token,
  // review 2026-07-19 #3)。rename 同卷原子,读者只会看到旧全量或新全量。
  const tmp = `${PATH}.tmp.${process.pid}`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  const { chmod, rename } = await import("fs/promises");
  // outToken 是凭据——0600(principals.json 同款);rename 前设好,避免可读窗口
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  await rename(tmp, PATH);
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

export function parsePeerHandshake(s: string): PeerHandshake | null {
  try {
    const raw = JSON.parse(Buffer.from(s.trim(), "base64url").toString("utf8"));
    if (raw?.v !== 1) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;
    if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) return null;
    if (typeof raw.token !== "string" || raw.token.length < 16) return null;
    return { v: 1, name: raw.name, url: raw.url.replace(/\/+$/, ""), token: raw.token };
  } catch {
    return null;
  }
}

export { PATH as PEERS_PATH };
