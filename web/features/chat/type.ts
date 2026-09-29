import type { CtxBoundaryInfo } from "./ctx-boundary-view";
import type { WebPermAction, WebAuqQuestion, WebComponentRow, BgProgress, BgEndStatus } from "@/lib/chat/events";
import type { UpdateHint } from "@/lib/chat/agents";
import type { LedgerTaskRef, MissionInfo } from "@/lib/chat/agents";
import type { LpState } from "@/lib/api/fleet";

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
  /** v2.23.2+ 直播工具卡来源记录的 jsonl 行号——差量对账按它剥掉已入历史的卡。 */
  seq?: number;
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
      /** v2.21.3+ 进度句(💭):Fable 5.1 的 progress-update 注,渲染更弱、不进 content/复制 */
      progress?: boolean;
      /** v2.23.2+ 直播段来源记录的 jsonl 行号——差量对账按它剥掉已入历史的段。 */
      seq?: number;
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
  /** subagent 才有：类型 / 模型 / 进度（耗时、上下文、最后动静）、真实收尾状态 */
  agentType?: string;
  model?: string;
  progress?: BgProgress;
  endStatus?: BgEndStatus;
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
  /** 这条 reply 建出的「待你处理」id（直播来自出站事件，历史来自 reply 的 tool_result）：按 id 认领，不按时间猜 */
  replyAskId?: string;
  /** 已点击的按钮/选项 id —— 点后禁用整组，高亮所选（一条 reply 只作答一次）。 */
  /** @deprecated bug ① 前的消息级单值,仅老快照读;新逻辑用 replyClicks。 */
  replyClickedId?: string;
  /** 每一行独立的已作答:rowKey → 存储值(见 lib/chat/reply-clicks)。 */
  replyClicks?: Record<string, string>;
  toolCalls?: ToolCallView[];
  /** 本地乐观消息的实发 payload（按钮点击:展示 label、实发 [button:<id>]）。
   *  历史对账要用它——jsonl 里落的是 wire,按展示文本永远匹配不上。 */
  wire?: string;
  /** 由本轮流式生成（区别于历史加载） */
  streamed?: boolean;
  /** v2.23.1+ 历史气泡所属 session（「删除」按 session+seq 区间隐藏）；
   *  v2.23.2+ 直播气泡也带(首个带 sid 的事件写入)——对账时只与同一会话的游标比 seq */
  sid?: string;
  /** v2.23.1+ 历史气泡覆盖的原始记录区间尾 seq（首 seq 在 id 里：h<seq>）；
   *  v2.23.2+ 直播气泡 = 已画进来的事件最大 seq */
  seqEnd?: number;
  /** 直播回合已完成——气泡底部渲染绿色「✓ 完成」行(历史消息不带,不刷屏)。 */
  turnDone?: boolean;
  /** 直播回合被打断(手动停止/连发抢占)——气泡底部黄色「⊘ 已打断」行。 */
  turnInterrupted?: boolean;
  /** 这次中断由新的人类消息自动触发。 */
  turnPreempted?: boolean;
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
  /** owner 在「待你处理」卡片上的作答：答的是哪条 ask（气泡上方画「答复：<标题>」引用条，点了跳回原消息） */
  askId?: string;
  /** 按钮 / 表单回投的原始 payload：所属表单不在同一段历史里、没能还原成可读文案时留着，合进已加载的消息时再往前找（features/chat/delta-clicks.ts） */
  clickRaw?: string;
  /** v2.20.2+ 回合结束但后台任务还在跑——「后台继续中」标记(代替绿勾)。 */
  turnBgPending?: boolean;
  /** 本端乐观发送、尚未在历史(jsonl)中确认——历史重拉时保留不吞
   *  （agent 忙时消息在服务端排队,送达前不进 jsonl）。 */
  local?: boolean;
  /** 乐观消息发出时视图里的历史游标（view-compose 的 sendCursor）：纯附件消息据此只和之后落盘的记录对账 */
  sentAfter?: { seq: number; sid?: string };
  /** 乐观消息已认领的他端回声指纹（view-compose 的 echoKeyOf）：之后只认同一条回声，别人同名的图不再被吞 */
  echoKey?: string;
  /** v2.15+ 发送失败（超时/网络/服务端拒绝）——气泡标「未送达」,别装作已发出 */
  failed?: boolean;
  /** bridge 押住了（额度闸 / 目标停在额度菜单，features/quota-wall/held-send.ts）：一押可能一两天，保全不按 30 分钟丢 */
  held?: boolean;
}

export interface AgentSession {
  kind?: "worker" | "main" | null;
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  /** creating = create 进行中 / 砍在半路的占位：显示「创建中」、不能发消息 */
  status: "active" | "stopped" | "creating";
  mock?: boolean;
  /** 大总管置顶入口——不显示 kill/restart，列表第一位。 */
  pinnedMaster?: boolean;
  /** 正在干活（tmux 非空闲）→ 列表状态点显黄色。 */
  busy?: boolean;
  /** v2.21.2+ 正在压缩上下文 → 列表状态点显蓝色（区分于普通忙碌）。 */
  compacting?: boolean;
  /** 最近活动时间（session jsonl mtime，ms epoch）→ 列表行右侧时间标签。 */
  lastActivityTs?: number | null;
  /** 2026-09-16 未读回复数(服务端计数,跨设备一致);0/缺省 = 无未读 */
  unread?: number;
  /** 当前上下文占用 token 数 → TopBar 超标提示。 */
  contextTokens?: number | null;
  /** 会话记录自带的上下文窗口（Codex 有；Claude Code 为 null → 按 1M 绝对刻度），见 ctx-level.ctxView */
  contextWindow?: number | null;
  /** 命中的上下文边界 + 余量（bridge 算；Codex / Pi 为 null），见 ctx-boundary-view.ts */
  ctxBoundary?: CtxBoundaryInfo | null;
  /** 当前模型 id（jsonl 实测 → registry → 全局默认;null=未知）→ TopBar 徽章。 */
  model?: string | null;
  /** 当前 effort 档位（同上兜底链）→ TopBar 徽章。 */
  effort?: string | null;
  /** v2.21+ 归属 project id（master 无）→ 侧栏分组。 */
  projectId?: string | null;
  /** external 闸门（registry）：开了才能共享给 peer；详情弹窗 / Peer 面板用 */
  external?: boolean;
  /** 显示名（registry label，默认空）与共享给几个 peer——侧栏「显示名 | name」、顶栏 external 徽章角标 */
  label?: string | null;
  /** 全权 token 才有：共享给哪些 peer（顶栏徽章悬停名单）/ 几个（角标数字） */
  sharedWith?: string[];
  sharedPeers?: number;
  /** 进行中的 Autopilot（bridge GET /agents 的 mission 字段）：侧栏图标 / 顶栏「截止 11:00」、菜单「开启 / 关闭 Autopilot」 */
  mission?: MissionInfo | null;
  /** 别的 agent 发来、它还在回合里没收到的消息数 → 侧栏「排队」小标 */
  queued?: number;
  /**
   * v2.23+ 运行时：`"pi"` = Pi coding agent，`"claude-code"`/缺失 = Claude Code。
   * 侧栏徽章、TopBar 模型/effort 展示都按它分叉（Pi 的模型来自 provider 配置，
   * 没有 CC 那套别名与 /model 热切换语义）。
   */
  runtime?: string | null;
  /** 该重启 / 该 pi update（null = 已是新版或判不了）→ composer 横幅 + 侧栏小标 */
  updateHint?: UpdateHint | null;
  /** 派发者（前端会话名，大总管 = __master__）：侧栏把它挂在派发者下面（sidebar-entries.ts 构树）；调用方看不到派发者时 bridge 不下发 */
  parent?: string | null;
  /** 任务短名（≤40 字）→ 侧栏名字后的压淡小标 */
  task?: string | null;
  /** 台账里它正在执行的任务 → 侧栏行尾阶段小标（ledger-stage.ts）；没挂任务 / 凭据读不了台账时 bridge 不下发 */
  ledgerTask?: LedgerTaskRef | null;
  /** low-priority 状态（bridge/fleet/lp-monitor.ts）：侧栏徽章 */
  lowPriority?: LpState | null;
}

/** v2.21+ project 元数据（GET /api/projects）→ 侧栏组头 + 项目管理弹窗。 */
export interface ProjectMeta {
  id: string;
  name: string;
  emoji?: string | null;
  dirs: string[];
  description?: string | null;
  agents?: { name: string; status?: string; purpose?: string }[];
}
