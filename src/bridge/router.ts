/**
 * v2.0.0+ 消息路由核心。
 *
 * Bridge 以前是"事件 handler + 内联条件分支"堆起来的 —— messageCreate 里 N
 * 条 if/else 处理不同场景、reply handler 单独一套、Stop hook 又一套。每加
 * 一个场景就加一个分支，分支之间共享状态（pendingReplies / activeStatus /
 * typing）但没有统一管控，导致 v1.9 一连串 bug（双重 post、status 卡住、
 * 消息 drop、竞态）。
 *
 * 这里把路由抽象成 "envelope in → deliver() out"：所有消息（user → agent /
 * agent → user / agent → peer agent / rescue / relay）都统一成
 * {from, to, content, meta}，由 deliver() 一处派发。权限检查、status 消息
 * 管理、push 通知、pending 追踪、Stop 时的 cleanup 全部以 envelope 为锚点，
 * 不再绑死到 channelId。
 *
 * 迁移策略：router 先跟 legacy handlers 共存，一个场景一个场景迁。每迁一个
 * legacy 分支就删掉，最终 messageCreate / reply / Stop hook 变成薄薄几行
 * 调用 deliver() + 收尾。
 */

import type { ServerWebSocket } from "bun";

// ============================================================
// Endpoint：消息发送方 / 接收方的统一地址
// ============================================================

/** 本地 Claude Code session（master 或 agent），通过 ws 直接注入消息 */
export interface LocalEndpoint {
  kind: "local";
  /** registry 里的 agent 名（master 留空或用 "master" 标识） */
  agentName?: string;
  /** 跟 clients 里的 key 一致，通常是 Discord channel id */
  channelId: string;
  /** channel-server 的 websocket；bridge 通过它注入消息 */
  ws: ServerWebSocket<unknown>;
  /** session 的 cwd（rescue 抽 jsonl 用） */
  cwd?: string;
}

/** 远端 peer 的 agent（或其 master，我们区分不了内部拓扑）— 通过共享 #agent-exchange 投递 */
export interface PeerEndpoint {
  kind: "peer";
  /** 对方 Discord bot 的 user id（用来 @mention） */
  peerBotId: string;
  /** 对方 Discord bot 的 username（显示用） */
  peerBotName: string;
  /** 双方共享的 #agent-exchange channel 的 id（实际投递到这里） */
  sharedChannelId: string;
  /** 具体要找的 peer agent 名字（`peer:X.Y` 语法里的 Y，可选 —— 没指定就让对方 bridge 自己路由） */
  peerAgentName?: string;
}

/** Discord 里的人类用户。消息最终出口之一（用户看消息 / 收 push） */
export interface UserEndpoint {
  kind: "user";
  /** Discord 用户 id */
  userId: string;
  /** 这个用户看消息的 channel id（通常是 #control 或具体 agent 频道） */
  channelId: string;
}

export type Endpoint = LocalEndpoint | PeerEndpoint | UserEndpoint;

// ============================================================
// Envelope：一条待投递的消息
// ============================================================

export type TriggerKind =
  | "user_discord"    // 人类用户在 Discord 发的消息
  | "peer_discord"    // peer bot 在 Discord 发的消息（通常是对方 agent 的回复）
  | "agent_tool"      // 本地 agent 通过 MCP tool 主动发的（reply / send_to_agent）
  | "bridge_synth"    // bridge 自己合成的（rescue、relay、nag 等 —— 都属于"代表某方发声"）
  | "system";         // 系统提示（clean up 通知、错误提示等）

export interface Envelope {
  from: Endpoint;
  to: Endpoint;
  content: string;
  meta: {
    /** Discord message id（若来自 Discord）或合成 id */
    messageId: string;
    triggerKind: TriggerKind;
    /** 原消息的时间戳（ISO） */
    ts: string;
    /** 线程追踪 id，同一个 request/reply 链路的消息都挂同一个 threadId，Stop hook 能按 thread 清理状态 */
    threadId?: string;
    /** 是否是 thread 的"最后一句"（由 [EOT] 标记、或 bridge 自己判定） */
    final?: boolean;
    /** 附件路径（本地 inbox 绝对路径） */
    attachments?: string[];
    /** 原始 Discord 消息对象引用（不持久化，只在 router 内部传递） */
    discordMsg?: unknown;
  };
}

// ============================================================
// Delivery：deliver() 的返回结果
// ============================================================

export type DeliveryOutcome =
  | { kind: "sent"; discordMessageIds?: string[]; note?: string }   // 成功投递
  | { kind: "dropped"; reason: string }                               // 主动丢弃（信任检查 / [EOT] / 目标离线等）
  | { kind: "error"; error: Error };                                  // 失败

export interface Delivery {
  envelope: Envelope;
  outcome: DeliveryOutcome;
}

// ============================================================
// Helpers
// ============================================================

/** 判两个 endpoint 是否指向同一个本地 ws（status / pending 跨 channel 归并用） */
export function sameLocalWs(a: Endpoint, b: Endpoint): boolean {
  return a.kind === "local" && b.kind === "local" && a.ws === b.ws;
}

/** endpoint 的一行展示（log 用） */
export function endpointLabel(e: Endpoint): string {
  switch (e.kind) {
    case "local":
      return `local:${e.agentName ?? "?"}(${e.channelId})`;
    case "peer":
      return `peer:${e.peerBotName}${e.peerAgentName ? `.${e.peerAgentName}` : ""}`;
    case "user":
      return `user:${e.userId}@${e.channelId}`;
  }
}

export function envelopeLabel(env: Envelope): string {
  return `${endpointLabel(env.from)} → ${endpointLabel(env.to)}`;
}
