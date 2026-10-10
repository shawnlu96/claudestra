import type { AskAnswerRef, InboundAttachmentsRef } from "./inbound-body.js";

export interface HistoryToolCall {
  name: string;
  summary: string;
  /** 完整入参详情（jsonl-watcher formatToolDetail 渲染，截断 4k）——
   *  web 工具卡点开展示。可选：老快照 / 未传 toolDetailFn 时缺省。 */
  detail?: string;
  /** 该次调用的 tool_result 带 is_error——web 把失败的工具卡标红。 */
  error?: boolean;
  /** tool_use id：直播的 tool_done 按它给网页上的这张卡收尾 */
  id?: string;
  /** 本次读到的范围里还没有它的 tool_result（还在跑）：网页把回合进行中的最后一张卡画成「运行中 · 计时」 */
  open?: boolean;
}

/** reply() 附带的交互组件（按钮/选单），点击回投 [button:id]/[select:id:v]。
 *  形状与 bridge NeutralMessage 的 components 对齐，历史里原样透传给前端渲染。 */
export type ReplyComponentRow =
  | { type: "buttons"; buttons: { id: string; label: string; style?: string; emoji?: string }[] }
  | { type: "select"; id: string; placeholder?: string; options: { label: string; value: string; description?: string }[] }
  | { type: "multiselect"; id: string; placeholder?: string; min?: number; max?: number; submitLabel?: string; options: { label: string; value: string; description?: string }[] };

/** askId / wire：owner 对「待你处理」的作答（lib/inbound-body.ts answerEcho） */
export interface HistoryMessage extends AskAnswerRef, InboundAttachmentsRef {
  /** jsonl 行号（0-based），分页锚点，同一文件内稳定 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: HistoryToolCall[];
  /** reply() 工具的正文——发给用户的「最终回复」，与过程叙述 text 分开渲染 */
  replyText?: string;
  /** reply() 附带的按钮/选单——历史里也渲染（否则用户不在直播那刻就看不到按钮） */
  replyComponents?: ReplyComponentRow[];
  /** reply() 附带的出站附件文件名（basename;取回走 inbox 后缀匹配兜底） */
  replyFiles?: string[];
  /** 这条 reply 建出的「待你处理」（从 reply 的 tool_result 解析）：网页按 id 认领，不按时间猜 */
  replyAskId?: string;
  /** 回合耗时 ms(system/turn_duration 回填)——只有正常收尾的回合才有 */
  turnMs?: number;
  /** compact 产生的摘要条目（不是真实用户输入） */
  compactSummary?: boolean;
  /** 进度句(💭):progress-update thinking 块「接下来我会…」,给用户看的短注,与 text 分开(渲染更弱、不进 content 对账) */
  progress?: string;
  model?: string;
  /** 入站消息的发送者标签（<channel> 的 user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
  /** 发送者 id（user_id 属性：api:<tokenId> / Discord 用户 id）——web 据此认出「本人的所有来源」 */
  fromId?: string;
  /** CC 忙时队列吸收、并进当前回合的入站（attachment queued_command）：不是新回合的开头 */
  midTurn?: boolean;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  /** 文件内可显示消息总数（不含被过滤的 meta/tool_result 载荷） */
  total: number;
  /** messages[0].seq 之前还有更早的消息（用 before=该 seq 翻上一页） */
  hasMore: boolean;
}

export interface SessionSummary {
  sessionId: string;
  /** 读取来源：live = CC projects 原文件（更全时优先），archive = 退役快照 */
  source: "live" | "archive";
  /** 服务器本地绝对路径 —— API 响应里不要外泄，仅供内部继续读文件 */
  path: string;
  sizeBytes: number;
  mtime: string;
  createdAt: string | null;
  subagents: string[];
}

export interface HistorySearchHit {
  /** jsonl 行号，与 readSessionHistory 的 seq 同一坐标系 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant";
  /** 命中消息的正文节选（命中词居中，前 80 后 240 字符，越界加 …） */
  snippet: string;
  /** 入站消息发送者（<channel> user 属性） */
  from?: string;
  /** 命中在 compact 压缩摘要里——被 compact 抛弃的上下文正是搜索的高价值目标 */
  compact?: boolean;
}

