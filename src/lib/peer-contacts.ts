/**
 * 网页侧栏「联系人」与输入框 @ 候选的数据（GET /api/v1/peers/contacts；tests/peer-contacts.test.ts）。
 * 只重排现有 peer presence（bridge 每分钟探测 + 中继实时推），不新增任何探测。
 * 对方开放的 agent 列表本来就是对方按我们的 token scope 过滤过的，这里只再挡一道 master，
 * 并且只给名字 + 忙闲：延迟、错误原文、对方地址都不带出去（侧栏用不上，也少暴露对方拓扑）。
 */
import type { HttpPeer } from "./peers.js";
import type { PeerPresence } from "./peer-presence.js";

/** 超过这个时长没刷新过的 agent 目录，忙闲显示为「未知」（探测每 60s 一次，留两轮余量） */
export const CONTACTS_STALE_MS = 3 * 60_000;

interface ContactAgent {
  name: string;
  /** 只在对方返回了布尔值且目录新鲜时才有；缺省 = 不知道（界面显示「—」） */
  busy?: boolean;
}

export interface PeerContact {
  name: string;
  /** 对方实例指纹：@ 标记记它，peer 改名 / 同名时能认出不是同一个对方 */
  fp?: string;
  /** true 在线 / false 连不上 / null 单向（只有对方能连我们，这边没法主动检测） */
  online: boolean | null;
  lastOnlineAt?: string;
  lastInboundAt?: string;
  /** 对方 agent 目录最近一次刷新时间 */
  checkedAt?: string;
  /** 目录超过 CONTACTS_STALE_MS 没刷新：列表照给（最近一次看到的），忙闲不给 */
  stale: boolean;
  agents: ContactAgent[];
}

const isMaster = (name: string) => name.replace(/^agent-/, "") === "master";

/** 一个 peer 的 presence → 联系人条目。停用的 peer 与握手没完成的在调用方就已过滤 */
export function contactOf(peer: Pick<HttpPeer, "name" | "fp">, p: PeerPresence, now: number): PeerContact {
  const checked = p.checkedAt ? Date.parse(p.checkedAt) : NaN;
  const stale = !Number.isFinite(checked) || now - checked > CONTACTS_STALE_MS;
  const showBusy = !stale && p.online === true;
  const agents = (p.remoteAgents ?? [])
    .filter((a) => a.name && !isMaster(a.name))
    .map((a) => (showBusy && typeof a.busy === "boolean" ? { name: a.name, busy: a.busy } : { name: a.name }));
  return {
    name: peer.name,
    ...(peer.fp ? { fp: peer.fp } : {}),
    online: p.online,
    ...(p.lastOnlineAt ? { lastOnlineAt: p.lastOnlineAt } : {}),
    ...(p.lastInboundAt ? { lastInboundAt: p.lastInboundAt } : {}),
    ...(p.checkedAt ? { checkedAt: p.checkedAt } : {}),
    stale,
    agents,
  };
}

/** 全部联系人：停用的 peer 不列；排序交给前端（在线优先） */
export function listContacts(
  peers: Pick<HttpPeer, "name" | "fp" | "disabled" | "baseUrl">[],
  presenceOf: (peer: Pick<HttpPeer, "name" | "fp" | "baseUrl">) => PeerPresence,
  now: number,
): PeerContact[] {
  return peers.filter((p) => !p.disabled).map((p) => contactOf(p, presenceOf(p), now));
}
