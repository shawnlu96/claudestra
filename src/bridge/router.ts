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

/** Discord 里的人类用户。消息最终出口之一（用户看消息 / 收 push） */
export interface UserEndpoint {
  kind: "user";
  /** Discord 用户 id */
  userId: string;
  /** 这个用户看消息的 channel id（通常是 #control 或具体 agent 频道） */
  channelId: string;
  /** Discord username（显示用，可选 —— 老 bridge `meta.user` 字段对齐） */
  username?: string;
}

/**
 * bridge 自己发起的消息（不代表任何具体 agent / user / peer）。用于 UI 层的
 * 通知和系统广播：status 提示（"💭 思考中..."）/ LLM-free 管理按钮的回复 /
 * notifyMaster 广播 / hook 事件文字。
 *
 * 只能做 `from`，不能做 `to`（bridge 不是消息接收者）。deliver 里看到
 * from=bridge 就跳过 header 渲染、跳过 pending 追踪，只做"内容 → Discord"。
 */
export interface BridgeEndpoint {
  kind: "bridge";
  /** 描述性标签，调试 / log 用，比如 "status"、"notifyMaster"。 */
  label?: string;
}

/**
 * v2.6.0+ HTTP API 用户（多前端架构 Phase B，设计 §5）。
 * 会话地址是虚拟 chat_id `api:<tokenId>`（统一 keyspace，D7）：agent 收到的
 * meta.chat_id 就是它，reply 原样回传 → resolveReplyTarget 识别前缀 → 这里。
 */
export interface ApiUserEndpoint {
  kind: "api";
  /** token 短 id（"tok_xxx"），虚拟 chat_id 的 id 部分 */
  tokenId: string;
  /** token 的人类名，渲染进 agent 看到的 header */
  name: string;
  /** v2.11+ HTTP peer 标记(principal.peer 透传):入站注入头渲染成 peer 请求 */
  peer?: string;
}

export type Endpoint = LocalEndpoint | UserEndpoint | BridgeEndpoint | ApiUserEndpoint;

// ============================================================
// Envelope：一条待投递的消息
// ============================================================

export type TriggerKind =
  | "user_discord"    // 人类用户在 Discord 发的消息
  | "peer_http"       // v2.11+ HTTP peer 的回复/错误（bridge/http-peer.ts pushback）
  | "agent_tool"      // 本地 agent 通过 MCP tool 主动发的（reply / send_to_agent）
  | "bridge_synth"    // bridge 自己合成的（rescue、relay、nag 等 —— 都属于"代表某方发声"）
  | "system";         // 系统提示（clean up 通知、错误提示等）

/**
 * v2.0.0+ 消息意图。取代老版一堆 heuristic（Stop 猜意思 / randomUmaDone
 * 兜底 @）。bridge 和 agent 都按 intent 行动：
 *   - request: 需要回应。bridge 挂 pending；接收端 agent 应生成 response
 *   - response: 对某条 request 的回复（meta.inReplyTo 指向原请求）。
 *     bridge 清 pending + 不发额外完成 @（用户已经看到 response）
 *   - notification: fire-and-forget。没 pending，不期望回复
 *   - broadcast: 通知频道所有人
 */
export type MessageIntent = "request" | "response" | "notification" | "broadcast";

export interface Envelope {
  from: Endpoint;
  to: Endpoint;
  /** 这条消息的意图，bridge 据此决定路由 + 追踪策略 */
  intent: MessageIntent;
  content: string;
  meta: {
    /** Discord message id（若来自 Discord）或合成 id */
    messageId: string;
    triggerKind: TriggerKind;
    /** 原消息的时间戳（ISO） */
    ts: string;
    /** 线程追踪 id。同一 request/response 链路的消息都挂同一个 threadId，
     *  Stop hook 能按 thread 清 pending / status / typing，不再按 channelId 瞎猜 */
    threadId: string;
    /** response 专用：指向被回应的原请求 messageId。bridge 据此清对应 pending */
    inReplyTo?: string;
    /** 是否是 thread 的"最后一句" */
    final?: boolean;
    /** 附件路径（本地 inbox 绝对路径） */
    attachments?: string[];
    /** 原始 Discord 消息对象引用（不持久化，只在 router 内部传递） */
    discordMsg?: unknown;

    // ── outbound（response）用的 Discord 特性透传字段 ───────────────────────
    /** Discord 消息 id：发到这个频道时作为 reply_to（native 引用） */
    replyTo?: string;
    /** Discord UI components（按钮 / select 菜单），仅加在最后一 chunk 上 */
    components?: unknown[];
    /** 附件绝对路径，仅加在第一 chunk 上，最多 10 个 / 25MB */
    files?: string[];
    /**
     * v2.4.16+ deliverToLocal 不要给 target 挂 pendingInterAgentMsg watchdog。
     * 用于 send_to_agent({oneShot:true}) 的 fire-and-forget 路径——caller 不期待
     * pushback，target 也不该被 watchdog 在 Stop 时 nudge 要求回应。
     */
    skipInterAgentWatchdog?: boolean;
  };
}

// ============================================================
// Delivery：deliver() 的返回结果
// ============================================================

export type DeliveryOutcome =
  | { kind: "sent"; discordMessageIds?: string[]; note?: string }   // 成功投递
  | { kind: "dropped"; reason: string }                               // 主动丢弃（信任检查 / 目标离线等）
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
    case "user":
      return `user:${e.userId}@${e.channelId}`;
    case "bridge":
      return `bridge:${e.label ?? "?"}`;
    case "api":
      return `api:${e.tokenId}(${e.name})`;
  }
}

export function envelopeLabel(env: Envelope): string {
  return `${endpointLabel(env.from)} → ${endpointLabel(env.to)} [${env.intent}]`;
}

// ============================================================
// Address 字符串形式 + parser（agent 端统一用 string 地址，不碰 channel id）
// ============================================================

/**
 * agent 端的地址形式（给 MCP tool 用）：
 *   user:<user_id>                  —— Discord 人类用户
 *   agent:<name>                    —— 本地 agent（registry 里有）
 *   peer:<peer_name>                —— HTTP peer 整体，让对方 bridge 自行路由
 *   peer:<peer_name>.<agent>        —— HTTP peer 指定路由到某 agent
 *   channel:<channel_id>            —— 脱盖的 escape hatch，直接投递到某 Discord 频道
 */
export type AddressString = string;

export interface ParsedAddress {
  kind: "user" | "agent" | "peer" | "channel";
  /** kind=user → user id; agent → name; peer → peer 名; channel → channel id */
  primary: string;
  /** kind=peer + 可选 agent 名字（peer:X.Y 的 Y）；其他 kind 不用 */
  secondary?: string;
}

/** 解析 agent 输入的 address 字符串。格式错返回 null。 */
export function parseAddress(s: AddressString): ParsedAddress | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // peer:X 或 peer:X.Y
  if (trimmed.startsWith("peer:")) {
    const rest = trimmed.slice(5);
    const dotIdx = rest.indexOf(".");
    if (dotIdx >= 0) {
      return { kind: "peer", primary: rest.slice(0, dotIdx), secondary: rest.slice(dotIdx + 1) };
    }
    return { kind: "peer", primary: rest };
  }
  // 短格式 Y@X → peer:X.Y（agent 用 send({target: "future_data@alice"}) 这种）
  const atMatch = trimmed.match(/^([^@]+)@([^@]+)$/);
  if (atMatch && !trimmed.includes(":")) {
    return { kind: "peer", primary: atMatch[2], secondary: atMatch[1] };
  }
  // user:<id>
  if (trimmed.startsWith("user:")) {
    return { kind: "user", primary: trimmed.slice(5) };
  }
  // agent:<name>
  if (trimmed.startsWith("agent:")) {
    return { kind: "agent", primary: trimmed.slice(6) };
  }
  // channel:<id>（escape hatch）
  if (trimmed.startsWith("channel:")) {
    return { kind: "channel", primary: trimmed.slice(8) };
  }
  // 没前缀的，按 v1.x 兼容视为本地 agent 名
  return { kind: "agent", primary: trimmed };
}

/** 把 ParsedAddress 格式化回字符串 */
export function formatAddress(a: ParsedAddress): AddressString {
  switch (a.kind) {
    case "peer":
      return a.secondary ? `peer:${a.primary}.${a.secondary}` : `peer:${a.primary}`;
    case "user":
      return `user:${a.primary}`;
    case "agent":
      return `agent:${a.primary}`;
    case "channel":
      return `channel:${a.primary}`;
  }
}

// ============================================================
// v2.6.0+ 统一 chat_id keyspace（设计 D7，多前端架构的地址合同）
// ============================================================

/**
 * 所有「会话地址」是一个带 transport 前缀的字符串：
 *   discord:<channelId>   Discord 频道
 *   api:<tokenId>         HTTP API 用户
 *   telegram:<chatId>     Telegram（future）
 *   <裸 id>               兼容形态 = discord:<id>，永久支持
 *
 * registry / clients / pendingReplies / thread 把 key 当不透明字符串使用，
 * agent 的 reply(chat_id) 原样回传 —— 解析只发生在 bridge 的出入口，且
 * 必须经过这里，核心里禁止再出现对裸 id 的 Discord 假设。
 */
export interface ParsedChatId {
  transport: string;
  id: string;
}

const KNOWN_TRANSPORTS = new Set(["discord", "api", "telegram", "web"]);

export function parseChatId(s: string): ParsedChatId {
  // [fork:web-only] local-* 合成会话地址（无 Discord 模式下 local adapter 供给，
  // registry 存量数据用 `local-<uuid>` 连字符形态）→ transport "local"。id 保留
  // 完整原串，registry / clients / pending 的 key 不变。
  if (s.startsWith("local-")) {
    return { transport: "local", id: s };
  }
  const idx = s.indexOf(":");
  if (idx > 0) {
    const prefix = s.slice(0, idx);
    if (KNOWN_TRANSPORTS.has(prefix)) {
      return { transport: prefix, id: s.slice(idx + 1) };
    }
  }
  // 裸 id（Discord snowflake 或历史数据）= discord，永久兼容
  return { transport: "discord", id: s };
}

/** 格式化回统一 keyspace 字符串。discord 保持裸 id（历史兼容 + registry 主键不变） */
export function formatChatId(p: ParsedChatId): string {
  // [fork:web-only] local 的 id 本身就是完整地址（连字符形态），原样返回
  if (p.transport === "local") return p.id;
  return p.transport === "discord" ? p.id : `${p.transport}:${p.id}`;
}

// ============================================================
// Thread id 生成 + 线程追踪 helper
// ============================================================

/** 新建一个唯一 threadId。用在 intent=request 的消息上，后续 response 挂同个 threadId */
export function newThreadId(): string {
  return `thr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 新建一条 response 消息的 envelope（继承源 envelope 的 threadId + inReplyTo） */
export function makeResponseEnvelope(
  request: Envelope,
  from: Endpoint,
  to: Endpoint,
  content: string,
  opts: { final?: boolean; messageId?: string; triggerKind?: TriggerKind; attachments?: string[] } = {},
): Envelope {
  return {
    from,
    to,
    intent: "response",
    content,
    meta: {
      messageId: opts.messageId ?? `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      triggerKind: opts.triggerKind ?? "bridge_synth",
      ts: new Date().toISOString(),
      threadId: request.meta.threadId,
      inReplyTo: request.meta.messageId,
      final: opts.final,
      attachments: opts.attachments,
    },
  };
}
