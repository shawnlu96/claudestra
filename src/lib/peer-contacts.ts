/**
 * 网页 Peer 按钮的在线摘要、Peer 面板的逐个 agent 忙闲与输入框 @ 候选的数据（GET /api/v1/peers/contacts；tests/peer-contacts.test.ts）。
 * 只重排现有 peer presence（bridge 每分钟探测 + 中继实时推），不新增任何探测。
 * 对方开放的 agent 列表本来就是对方按我们的 token scope 过滤过的，这里再挡一道 master 与不合规的 agent 名（lib/mention-name.ts：
 * 名字会进 agent 看到的指令行），并且只给名字 + 忙闲 / 已停止：延迟、错误原文、对方地址都不带出去。
 */
import type { HttpPeer } from "./peers.js";
import type { PeerPresence } from "./peer-presence.js";
import { isMasterAgent } from "./registry.js";
import { isSafeMentionName } from "./mention-name.js";

/** 超过这个时长没刷新过的 agent 目录，忙闲显示为「未知」（探测每 60s 一次，留两轮余量） */
export const CONTACTS_STALE_MS = 3 * 60_000;

interface ContactAgent {
  name: string;
  /** 只在对方返回了布尔值且目录新鲜时才有；缺省 = 不知道（界面显示「—」） */
  busy?: boolean;
  /** 对方说它已停止（对方 /agents 对 stopped 也回 busy=false，不单独标就会显示成「空闲」、还能被 @） */
  stopped?: boolean;
}

export interface PeerContact {
  name: string;
  /** 对方实例指纹：@ 标记记它，peer 改名 / 同名时能认出不是同一个对方 */
  fp?: string;
  /** true 在线 / false 连不上 / null 单向（只有对方能连我们，这边没法主动检测） */
  online: boolean | null;
  lastOnlineAt?: string;
  lastInboundAt?: string;
  /** 对方 agent 目录最近一次刷新时间（探测成功那一刻，不是最近一次探测） */
  checkedAt?: string;
  /** 目录超过 CONTACTS_STALE_MS 没刷新：列表照给（最近一次看到的），忙闲不给 */
  stale: boolean;
  /** 对方拒绝了我们的凭据（401 / 403）：列表已清空，界面要说「凭据被拒」而不是「没开放」 */
  rejected?: boolean;
  agents: ContactAgent[];
}

function agentOf(a: { name: string; status?: string; busy?: boolean }, showBusy: boolean): ContactAgent {
  if (a.status === "stopped") return { name: a.name, stopped: true };
  return showBusy && typeof a.busy === "boolean" ? { name: a.name, busy: a.busy } : { name: a.name };
}

/** 一个 peer 的 presence → 联系人条目。停用的 peer 在 listContacts 里过滤；单向 / 握手没完成的照列（online=null、没有 agent） */
export function contactOf(peer: Pick<HttpPeer, "name" | "fp">, p: PeerPresence, now: number): PeerContact {
  const refreshed = p.agentsAt ? Date.parse(p.agentsAt) : NaN;
  const stale = !Number.isFinite(refreshed) || now - refreshed > CONTACTS_STALE_MS;
  const showBusy = !stale && p.online === true;
  const agents = (p.remoteAgents ?? [])
    .filter((a) => a.name && !isMasterAgent(a.name) && isSafeMentionName(a.name))
    .map((a) => agentOf(a, showBusy));
  return {
    name: peer.name,
    ...(peer.fp ? { fp: peer.fp } : {}),
    online: p.online,
    ...(p.lastOnlineAt ? { lastOnlineAt: p.lastOnlineAt } : {}),
    ...(p.lastInboundAt ? { lastInboundAt: p.lastInboundAt } : {}),
    ...(p.agentsAt ? { checkedAt: p.agentsAt } : {}),
    stale,
    ...(p.authRejected ? { rejected: true } : {}),
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
