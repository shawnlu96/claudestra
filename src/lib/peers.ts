/**
 * Cross-Claudestra peer state.
 *
 * 存 ~/.claude-orchestrator/peers.json。有两类信息：
 * - exposures: 我本地哪些 agent 开放给哪些 peer（我主动决定）
 * - capabilities: peer 开放给我哪些 agent（从他们发在 #agent-exchange 的通告里学来的）
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const HOME = process.env.HOME || "";
const DIR = `${HOME}/.claude-orchestrator`;
const PATH = `${DIR}/peers.json`;

export interface PeerBot {
  id: string;          // Discord bot user ID
  name: string;        // bot 的 Discord 用户名（tag 不带 discriminator）
  guildId: string;     // peer bot 所在的 guild（我们这边）
  agentExchangeId?: string; // 我方 #agent-exchange 频道 ID（与这个 peer 共用那个）
  firstSeen: string;   // ISO 8601
}

/**
 * v1.9.21+ 路由模式：
 *  - "direct": peer 的请求由**我方 bridge** 直接路由给指定的 local agent，
 *    完全绕过我方 master。agent 直接 reply 到 #agent-exchange @ peer bot。
 *    链路短（2-3 hops），适合职责明确、不需要 master 中介的能力。
 *  - "via_master": peer 的请求先 forward 给我方 master，master 用
 *    send_to_agent 转给 agent，agent 回到自己 channel，master 再 transcribe
 *    到 #agent-exchange。保留给"多个 agent 可能匹配、需要 LLM 路由决策"场景。
 *
 * 兼容：老 exposure / capability 没有 `mode` 字段，effectiveMode 默认
 * "via_master"（保持旧行为）。新写入的 exposure 默认 "direct"。
 */
export type PeerMode = "direct" | "via_master";
export const DEFAULT_PEER_MODE: PeerMode = "direct";

export function effectivePeerMode(entry: { mode?: string }): PeerMode {
  return entry.mode === "direct" ? "direct" : "via_master";
}

export interface Exposure {
  localAgent: string;       // 比如 "orchestrator"
  peerBotId: string | "all"; // 具体 peer bot ID 或 "all"
  purpose?: string;         // 自由描述
  mode?: PeerMode;          // 路由模式（v1.9.21+）
  grantedAt: string;        // ISO 8601
}

export interface Capability {
  peerBotId: string;
  peerBotName: string;
  peerAgentExchangeId?: string; // peer 那边的 #agent-exchange channel id（我方 bot 能看到的）
  peerAgent: string;            // 对方开放的 agent 名
  purpose?: string;
  mode?: PeerMode;              // 对方声明的路由模式（v1.9.21+，从 PeerEvent 学来）
  learnedAt: string;
}

export interface PeersData {
  /** 我方 guild 里用于 peer 通信的 #agent-exchange 频道 ID（首次 peer bot 加入时自动创建） */
  localAgentExchangeId?: string;
  peerBots: PeerBot[];
  exposures: Exposure[];
  capabilities: Capability[];
}

const EMPTY: PeersData = { peerBots: [], exposures: [], capabilities: [] };

export async function readPeers(): Promise<PeersData> {
  if (!existsSync(PATH)) return structuredClone(EMPTY);
  try {
    const raw = await Bun.file(PATH).json();
    return {
      localAgentExchangeId: typeof raw?.localAgentExchangeId === "string" ? raw.localAgentExchangeId : undefined,
      peerBots: Array.isArray(raw?.peerBots) ? raw.peerBots : [],
      exposures: Array.isArray(raw?.exposures) ? raw.exposures : [],
      capabilities: Array.isArray(raw?.capabilities) ? raw.capabilities : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function setLocalAgentExchangeId(channelId: string): Promise<void> {
  const data = await readPeers();
  data.localAgentExchangeId = channelId;
  await writePeers(data);
}

async function ensureDir() {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

export async function writePeers(data: PeersData): Promise<void> {
  await ensureDir();
  await Bun.write(PATH, JSON.stringify(data, null, 2));
}

export async function upsertPeerBot(bot: PeerBot): Promise<void> {
  const data = await readPeers();
  const existing = data.peerBots.find((p) => p.id === bot.id);
  if (existing) {
    Object.assign(existing, bot);
  } else {
    data.peerBots.push(bot);
  }
  await writePeers(data);
}

export async function removePeerBot(botId: string): Promise<void> {
  const data = await readPeers();
  data.peerBots = data.peerBots.filter((p) => p.id !== botId);
  data.exposures = data.exposures.filter((e) => e.peerBotId !== botId);
  data.capabilities = data.capabilities.filter((c) => c.peerBotId !== botId);
  await writePeers(data);
}

export async function addExposure(exp: Omit<Exposure, "grantedAt">): Promise<Exposure> {
  const data = await readPeers();
  // 去重：同 localAgent + peerBotId 只保留一条
  data.exposures = data.exposures.filter(
    (e) => !(e.localAgent === exp.localAgent && e.peerBotId === exp.peerBotId)
  );
  const full: Exposure = { ...exp, grantedAt: new Date().toISOString() };
  data.exposures.push(full);
  await writePeers(data);
  return full;
}

export async function removeExposure(localAgent: string, peerBotId: string | "all"): Promise<boolean> {
  const data = await readPeers();
  const before = data.exposures.length;
  data.exposures = data.exposures.filter(
    (e) => !(e.localAgent === localAgent && e.peerBotId === peerBotId)
  );
  const changed = data.exposures.length !== before;
  if (changed) await writePeers(data);
  return changed;
}

export async function addCapability(cap: Omit<Capability, "learnedAt">): Promise<void> {
  const data = await readPeers();
  data.capabilities = data.capabilities.filter(
    (c) => !(c.peerBotId === cap.peerBotId && c.peerAgent === cap.peerAgent)
  );
  data.capabilities.push({ ...cap, learnedAt: new Date().toISOString() });
  await writePeers(data);
}

export async function removeCapability(peerBotId: string, peerAgent: string): Promise<boolean> {
  const data = await readPeers();
  const before = data.capabilities.length;
  data.capabilities = data.capabilities.filter(
    (c) => !(c.peerBotId === peerBotId && c.peerAgent === peerAgent)
  );
  const changed = data.capabilities.length !== before;
  if (changed) await writePeers(data);
  return changed;
}

/**
 * 判断本地 localAgent 是不是对 peerBotId 开放。
 * 开放规则：存在精确匹配（localAgent, peerBotId）或开放给 "all" 的 exposure。
 */
export async function isExposed(localAgent: string, peerBotId: string): Promise<boolean> {
  const data = await readPeers();
  return data.exposures.some(
    (e) => e.localAgent === localAgent && (e.peerBotId === peerBotId || e.peerBotId === "all")
  );
}

export { PATH as PEERS_PATH };

/**
 * 通告消息格式 — 两侧 bridge 都能解析的结构化事件。塞在 Discord 消息正文前面作为 HTML 注释。
 *
 * 示例: <!-- CLAUDESTRA_PEER_EVENT kind=grant local=orchestrator peer=123 purpose="Claudestra 咨询" exchange=456 -->
 */
export interface PeerEvent {
  kind: "grant" | "revoke" | "hello";
  local: string;           // local agent name（grant/revoke）或 bot username（hello）
  peer: string;            // 目标 peer bot ID（或 "all"）
  purpose?: string;
  exchange?: string;       // 我方 #agent-exchange 频道 id，peer 用来知道回哪里
  mode?: PeerMode;         // v1.9.21+ 路由模式
}

const EVENT_RE = /<!--\s*CLAUDESTRA_PEER_EVENT\s+(.+?)\s*-->/;

export function encodePeerEvent(ev: PeerEvent): string {
  const parts = [`kind=${ev.kind}`, `local=${ev.local}`, `peer=${ev.peer}`];
  if (ev.purpose) parts.push(`purpose="${ev.purpose.replace(/"/g, "'")}"`);
  if (ev.exchange) parts.push(`exchange=${ev.exchange}`);
  if (ev.mode) parts.push(`mode=${ev.mode}`);
  return `<!-- CLAUDESTRA_PEER_EVENT ${parts.join(" ")} -->`;
}

export function parsePeerEvent(text: string): PeerEvent | null {
  const m = text.match(EVENT_RE);
  if (!m) return null;
  const body = m[1];
  const kvs: Record<string, string> = {};
  // 支持 key=value 或 key="multi word"
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let rm: RegExpExecArray | null;
  while ((rm = re.exec(body))) {
    kvs[rm[1]] = rm[2] ?? rm[3];
  }
  if (!kvs.kind || !kvs.local || !kvs.peer) return null;
  if (kvs.kind !== "grant" && kvs.kind !== "revoke" && kvs.kind !== "hello") return null;
  const mode = kvs.mode === "direct" || kvs.mode === "via_master" ? kvs.mode : undefined;
  return {
    kind: kvs.kind as PeerEvent["kind"],
    local: kvs.local,
    peer: kvs.peer,
    purpose: kvs.purpose,
    exchange: kvs.exchange,
    mode,
  };
}
