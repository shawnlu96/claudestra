/**
 * Web 会话流事件协议（v1）。
 *
 * 对应架构文档 §3：v1 复用 jsonl-watcher 的「段级」摘要流，而非 claude-os 的 token 级
 * Anthropic stream_event。因此事件比 claude-os 精简：工具摘要、助手文本段、回复、收尾。
 *
 * 2026-07-10 迁移后：BFF 的 /api/chat/stream 订阅 Bridge /api/v1/events
 * （upstream event-bus SSE），并把 BridgeEvent 翻译成这里的 WebStreamEvent
 * 逐条下发（`data: <json>\n\n`）——前端协议 v1 不变，消费代码零改动。
 */
/** 权限/AUQ 卡的一个操作按钮（回传时 action 让 bridge 打对应 tmux 键序列）。 */
export interface WebPermAction {
  action: string;
  label: string;
  style: "success" | "primary" | "danger" | "secondary";
}
/** AskUserQuestion 一个选项 / 一道题的 Web 形状（与 bridge/web-hub.ts 对齐）。 */
export interface WebAuqOption {
  label: string;
  description?: string;
}
export interface WebAuqQuestion {
  question: string;
  header: string;
  options: WebAuqOption[];
  multiSelect: boolean;
}

/**
 * reply() 附带的交互组件（按钮 / 选单）。形状与 bridge NeutralMessage 的
 * components JSON 一一对应（原样透传，前端点击后回投 [button:<id>] /
 * [select:<id>:<value>]，与 Discord 侧语义完全一致）。
 */
export interface WebButton {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
  emoji?: string;
}
export interface WebSelectOption {
  label: string;
  value: string;
  description?: string;
}
export type WebComponentRow =
  | { type: "buttons"; buttons: WebButton[] }
  | { type: "select"; id: string; placeholder?: string; options: WebSelectOption[] }
  /** 多选 + 一次提交（owner 2026-07-25）。回投格式与单选对齐，只是值是逗号分隔的：
   *  `[select:<id>:<v1>,<v2>]`——agent 侧一套解析吃 Discord 与 web 两端。 */
  | {
      type: "multiselect";
      id: string;
      placeholder?: string;
      options: WebSelectOption[];
      /** 至少选几项（默认 1，不允许交空集） */
      min?: number;
      /** 最多选几项（默认不限，即全部） */
      max?: number;
      /** 提交按钮文案（默认「提交」） */
      submitLabel?: string;
    };

export type WebStreamEvent =
  | { t: "status"; status: "running" | "done" }
  /** 一次工具调用的段级摘要（📖 Read xxx / ✏️ Edit xxx / ⚙️ Bash ...）。
   *  id：tool_use id（tool-state 按它更新这张卡）。
   *  detail：完整入参详情（截断 4k），工具卡点开展示。 */
  | { t: "tool"; id?: string; name: string; summary: string; state: "running" | "done" | "error"; detail?: string }
  /** 工具调用状态定稿（done=绿 / error=红,三态背景直播侧的收尾信号）。 */
  | { t: "tool-state"; id: string; state: "done" | "error" }
  /** 助手文本段（过程叙述，追加到当前流式助手消息的 content） */
  | { t: "text"; text: string }
  /** 另一端用户的发言(跨端同步:手机/电脑/Discord 同看一个会话)。
   *  本端自己发的回声由前端按文本对账去重。 */
  | { t: "user-in"; text: string; from?: string; attachments?: { name: string; kind: "image" | "file"; url?: string }[] }
  /** reply() 的最终回复（挂到当前 assistant 气泡的 replyText，与叙述分区渲染）。
   *  components：reply 附带的按钮/选单（点击回投 [button:<id>] / [select:<id>:<value>]）。
   *  attachments：agent 出站附件（图片内联显示,文件给 chip）——url 指向 BFF 附件端点。 */
  | {
      t: "reply";
      text: string;
      components?: WebComponentRow[];
      attachments?: { name: string; kind: "image" | "file"; url: string }[];
    }
  /** 本轮结束。interrupted=被打断(手动停止/连发抢占)——标「⊘ 已打断」而非「✓ 完成」 */
  | { t: "done"; interrupted?: boolean; bgPending?: boolean }
  | { t: "replying" }
  /** 回合耗时(jsonl turn_duration)——完成标记行附带「· 12.3s」 */
  | { t: "turn"; ms: number }
  | { t: "error"; error: string }
  // Phase 2 富交互：需要用户抉择的「待处理卡」。回传经 BFF → bridge → tmux 按键。
  | {
      t: "permission";
      /** 稳定 dedup key（modal 语义） */
      id: string;
      kind: "permission" | "session-idle";
      title: string;
      desc: string;
      actions: WebPermAction[];
    }
  | { t: "permission-cleared" }
  | { t: "ask"; id: string; questions: WebAuqQuestion[] }
  | { t: "ask-cleared" }
  // 后台任务（subagent / bg shell）子会话跟踪：Discord 侧开子区，web 侧渲染折叠面板。
  | { t: "bg-start"; id: string; kind: "subagent" | "shell"; title: string }
  | { t: "bg-update"; id: string; items: string[] }
  | { t: "bg-done"; id: string; durationMs?: number }
  /** 连流后的活跃任务全集快照：不在 ids 里的 running 卡应标记完成——
   *  bridge 重启会丢 bg-done 事件,幽灵「working」卡靠它收敛。 */
  | { t: "bg-sync"; ids: string[] }
  /** compact 完成（jsonl compact_boundary）：插系统分隔线 + ctx 徽章即时回落。 */
  | { t: "compact"; pre: number; post: number }
  /** v2.15+ 思考遥测（TUI 状态行采样,3s 一条,transient）：思考徽章显示
   *  `47s · ↓ 2.1k tokens`——token 在跳 = 模型活着,消除「卡住了」的错觉。
   *  （任务清单不走流:已有 ccTasks 文件真源面板 + Task* 工具触发的防抖刷新） */
  | { t: "telemetry"; elapsed?: string; tokens?: number; effort?: string };

/** 带 bridge 事件锚点的流事件:eid = BridgeEvent.seq(event-bus 单调递增),
 *  前端记录最后收到的 eid,断线/回前台重连时 ?since=<eid> 走环形缓冲重放
 *  (Last-Event-ID 语义)——错过的事件直接补,不用全量重拉历史。 */
export type AnchoredStreamEvent = WebStreamEvent & { eid?: number };

export const SSE_DONE = "[DONE]";
