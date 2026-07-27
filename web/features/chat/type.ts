import type { WebPermAction, WebAuqQuestion, WebComponentRow } from "@/lib/chat/events";

export interface ToolCallView {
  /** tool_use id——直播里 tool-state（失败标红）按它找回这张卡。 */
  id?: string;
  name: string;
  summary: string;
  state: "running" | "done" | "error";
  /** 调用时间（ISO）：历史来自 jsonl 条目 ts，直播由前端 stamp。点击工具卡显示。 */
  ts?: string;
  /** 完整入参详情（后端 formatToolDetail，截断 4k）——工具卡点开展示。 */
  detail?: string;
}

/** assistant 气泡内的交错段——叙述与工具按真实时间顺序排列（修「工具全堆气泡顶部」）。
 *  reply 也是一个段：按时间序插入而非钉在气泡底——reply() 之后叙述可能还在继续
 *  （终端总结文本），钉底会让「后面的段时间比前面早」（2026-07-13 真机截图）。 */
export type AssistantSegment =
  | {
      kind: "text";
      text: string;
      /** 该段开始时间（历史=首条 jsonl 记录 ts，直播=前端 stamp）。点击该段显示。 */
      ts?: string;
    }
  | { kind: "tools"; tools: ToolCallView[] }
  | { kind: "reply"; text: string; ts?: string };

/** 待处理的权限 / session-idle 卡（一个会话同时最多一张）。 */
export interface PendingPermission {
  id: string;
  kind: "permission" | "session-idle";
  title: string;
  desc: string;
  actions: WebPermAction[];
}

/** 待处理的 AskUserQuestion 卡（一个会话同时最多一张）。 */
export interface PendingAsk {
  id: string;
  questions: WebAuqQuestion[];
}

/** 后台任务（subagent / bg shell）跟踪视图 —— Discord 子区在 web 的对应物。 */
export interface BgTaskView {
  id: string;
  kind: "subagent" | "shell";
  title: string;
  /** 已渲染的进度行（subagent：🔧工具/💬文本；shell：原始输出行）。 */
  lines: string[];
  status: "running" | "done";
  durationMs?: number;
  /** 最后一次收到该任务事件的本地时刻——陈旧收敛用（漏收 completed 的兜底）。 */
  lastEventAt?: number;
}

/** Claude Code 原生任务清单条目（~/.claude/tasks/<sessionId>/<id>.json）。 */
export interface CcTaskView {
  id: string;
  subject: string;
  /** 进行时态描述（in_progress 时 TUI 显示的那句） */
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | string;
  blockedBy: string[];
}

/** 用户消息里附带的上传文件（用于自己气泡内回显）。 */
export interface ChatAttachmentView {
  name: string;
  kind: "image" | "file";
  /** 图片本地预览 objectURL（仅本会话内有效，刷新后历史里无此字段）。 */
  url?: string;
}

export interface ChatMessage {
  id: string;
  /** system = 会话级事件（compact 边界 / 斜杠命令记录 / 中断标记 / 命令输出），
   *  渲染成居中分隔条（SystemDivider），无头像无气泡。 */
  role: "user" | "assistant" | "system";
  /** assistant：过程叙述文本（流式 assistant_text）。user：消息正文。system：事件文本。 */
  content: string;
  /** assistant 的交错段序列（叙述/工具按时间序）。存在时渲染层优先用它；
   *  content/toolCalls 仍聚合维护（判空、数量统计、旧快照兼容）。 */
  segments?: AssistantSegment[];
  /** assistant 的「最终回复」（reply() 正文）——与过程叙述 content 分区渲染，
   *  中间用淡分隔线隔开。历史来自 jsonl 的 reply tool_use，直播来自 chat_message(out)。 */
  replyText?: string;
  /** replyText 的时间（与气泡 ts 分开——长回合里回复比开场晚得多）。点击回复正文显示。 */
  replyTs?: string;
  /** reply 附带的交互组件（按钮/选单）。点击回投 [button:<id>] / [select:<id>:<value>]。 */
  replyComponents?: WebComponentRow[];
  /** 已点击的按钮/选项 id —— 点后禁用整组，高亮所选（一条 reply 只作答一次）。 */
  replyClickedId?: string;
  toolCalls?: ToolCallView[];
  /** 本地乐观消息的实发 payload（按钮点击:展示 label、实发 [button:<id>]）。
   *  历史对账要用它——jsonl 里落的是 wire,按展示文本永远匹配不上。 */
  wire?: string;
  /** 由本轮流式生成（区别于历史加载） */
  streamed?: boolean;
  /** 直播回合已完成——气泡底部渲染绿色「✓ 完成」行(历史消息不带,不刷屏)。 */
  turnDone?: boolean;
  /** 直播回合被打断(手动停止/连发抢占)——气泡底部黄色「⊘ 已打断」行。 */
  turnInterrupted?: boolean;
  /** 直播回合出错(流 error 事件)——气泡底部红色「✕ 出错」行。 */
  turnError?: boolean;
  /** 回合耗时 ms(jsonl turn_duration)——完成行显示「· 12.3s」。 */
  turnMs?: number;
  /** ISO 时间戳（历史来自 session jsonl，实时由前端 stamp）。 */
  ts?: string;
  /** 附件:user 气泡=用户上传回显;assistant 气泡=agent 出站附件(reply files)。 */
  attachments?: ChatAttachmentView[];
  /** 入站消息来源标签（Discord 用户名 / 来源 agent；自己发的不带）。 */
  from?: string;
  /** 本端乐观发送、尚未在历史(jsonl)中确认——历史重拉时保留不吞
   *  （agent 忙时消息在服务端排队,送达前不进 jsonl）。 */
  local?: boolean;
  /** v2.15+ 发送失败（超时/网络/服务端拒绝）——气泡标「未送达」,别装作已发出 */
  failed?: boolean;
}

export interface AgentSession {
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  status: "active" | "stopped";
  mock?: boolean;
  /** 大总管置顶入口——不显示 kill/restart，列表第一位。 */
  pinnedMaster?: boolean;
  /** 正在干活（tmux 非空闲）→ 列表状态点显黄色。 */
  busy?: boolean;
  /** 最近活动时间（session jsonl mtime，ms epoch）→ 列表行右侧时间标签。 */
  lastActivityTs?: number | null;
  /** 当前上下文占用 token 数 → TopBar 超标提示。 */
  contextTokens?: number | null;
  /** 当前模型 id（jsonl 实测 → registry → 全局默认;null=未知）→ TopBar 徽章。 */
  model?: string | null;
  /** 当前 effort 档位（同上兜底链）→ TopBar 徽章。 */
  effort?: string | null;
}
