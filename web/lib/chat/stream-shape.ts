/**
 * bridge 事件 → 前端流事件（协议 v1，lib/chat/events.ts）的纯变换，从已删的 BFF app/api/chat/stream/route.ts 整体搬进前端
 * （tests/web-stream-shape.test.ts）。事件映射：
 *   agent_status thinking → status:running；done → done（trigger=interrupt → interrupted；bgPending 透传）
 *   tool_start → tool(running)；tool_done → tool-state；assistant_text → text；reply_pending → replying
 *   chat_message(in, 用户来源) → user-in；chat_message(out) → reply（组件 / 附件透传）
 *   question → ask；question_cleared → ask-cleared；auto_deny / session_anomaly → 醒目系统文本；bg_task_* → bg-*
 *   compact_progress / compact_done / turn_duration / thinking_telemetry → 对应事件；其余不消费（null）
 */
import { bgEndStatusOf, bgMetaOf, bgProgressOf, type WebAuqQuestion, type WebComponentRow, type WebStreamEvent } from "./events";
import { attachmentUrl, extractAttachments, isImageName } from "./attachments";
import { foreignAware, isSelfSource } from "./history-shape";

export interface BridgeEvent {
  seq: number;
  ts: string;
  agent: string;
  chatId: string;
  type: string;
  data: Record<string, unknown>;
}
export type Lang = "zh" | "en";

export function mapAuqQuestions(raw: unknown): WebAuqQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => ({
    question: String(q?.question ?? ""),
    header: String(q?.header ?? ""),
    multiSelect: !!q?.multiSelect,
    options: Array.isArray(q?.options)
      ? q.options.map((o: { label?: string; description?: string }) => ({ label: String(o?.label ?? ""), description: o?.description ? String(o.description) : undefined }))
      : [],
  }));
}

/** watcher 事件带的记录坐标（jsonl 行号 seq + 会话 sid）原样透传：前端拿它与历史游标比对判重 */
function recordSrc(d: Record<string, unknown>): { seq?: number; sid?: string } {
  return { ...(typeof d.seq === "number" ? { seq: d.seq } : {}), ...(typeof d.sid === "string" && d.sid ? { sid: d.sid } : {}) };
}

/** 事件里的 agent 字段是 registry 名（agent-xxx）或 "master" */
export function agentNameVariants(apiName: string): Set<string> {
  return new Set([apiName, `agent-${apiName}`]);
}

function chatMessage(d: Record<string, unknown>, selfIds: ReadonlySet<string>): WebStreamEvent | null {
  if (d.direction === "in") {
    // 只有用户来源（Web / Discord user）才是 user-in：agent / bridge 注入不算；本端自己的回声由前端对账去重
    const src = String(d.srcKind ?? "");
    if ((src === "api" || src === "user") && typeof d.text === "string" && d.text.trim()) {
      const from = typeof d.from === "string" && d.from !== "?" ? d.from : undefined;
      const fromLabel = isSelfSource(from, typeof d.fromId === "string" ? d.fromId : undefined, selfIds) ? undefined : from;
      // owner 对「待你处理」的作答：bridge 给了 echo（选项人话 + 原话，和历史同一个算法，lib/inbound-body.ts answerEcho）；老 bridge 只剥第一行说明。
      // 外源不做这些按文本的改写，原文照显（history-shape userMessage 同一口径）
      const said = fromLabel ? d.text : typeof d.echo === "string" ? d.echo : typeof d.askId === "string" ? d.text.split("\n").slice(1).join("\n") : d.text;
      // 本人的剥附件注入块 → 干净正文 + 附件数组（不剥另一端渲染出整块路径文字，回声与乐观消息也对不上）；外源的附件行留在正文里
      const { content, attachments } = foreignAware(said, fromLabel);
      if (!content && !attachments?.length) return null;
      const wire = !fromLabel && typeof d.echo === "string" && typeof d.wire === "string" ? extractAttachments(d.wire).content : ""; // 作答的原文：对账、回填已答态用
      const ask = { ...(typeof d.askId === "string" ? { askId: d.askId } : {}), ...(wire && wire !== content ? { wire } : {}) };
      return { t: "user-in", text: content, ...(fromLabel ? { from: fromLabel } : {}), ...(attachments?.length ? { attachments } : {}), ...ask };
    }
    return null;
  }
  if (d.direction !== "out") return null;
  // reply() 的最终回复：独立 reply 事件（挂 replyText；回合 done 之后到达也能定稿）。files = agent 出站附件（bridge 已落 inbox）
  const atts = Array.isArray(d.files)
    ? (d.files as { name?: string; attachment?: string }[])
        .filter((f) => f?.attachment)
        .map((f) => ({ name: String(f.name || f.attachment), kind: isImageName(String(f.attachment)) ? ("image" as const) : ("file" as const), url: attachmentUrl(String(f.attachment)) }))
    : [];
  return {
    t: "reply",
    text: String(d.text ?? ""),
    ...(Array.isArray(d.components) ? { components: d.components as WebComponentRow[] } : {}),
    ...(atts.length ? { attachments: atts } : {}),
    ...(typeof d.askId === "string" ? { askId: d.askId } : {}),
  };
}

const CTX_BLOCK_WHY: Record<string, [string, string]> = {
  draft: ["输入框里有没发出去的字", "there is unsent text in the input box"],
  queued: ["已经有排队的消息", "a message is already queued"],
  menu: ["画面上有对话框或菜单", "a dialog or menu is open"],
  "quota-wall": ["撞了额度墙又没开 low-priority", "it hit the usage wall without low-priority"],
  "copy-mode": ["有人在翻看终端历史", "someone is scrolling the terminal history"],
  leftover: ["注入的命令没能提交，还留在输入框里", "the injected command was not submitted and is still in the input box"],
};

/** 上下文边界：过了救命线却被挡住（bridge/ctx-boundary.ts alertBlocked），不处理就会一直涨到 CC 自己裸压 */
function ctxBlockedText(d: Record<string, unknown>, lang: Lang): string {
  const k = (n: unknown) => `${Math.round((Number(n) || 0) / 1000)}K`;
  const why = CTX_BLOCK_WHY[String(d.reason)] ?? [String(d.reason ?? "?"), String(d.reason ?? "?")];
  const cap = typeof d.cap === "number" ? d.cap : null;
  return lang === "en"
    ? `⚠️ Context is at ${k(d.ctx)}${cap ? `, past the ${k(cap)} safety line,` : ""} but auto-compaction is blocked: ${why[1]}. Please check this window.`
    : `⚠️ 上下文 ${k(d.ctx)}${cap ? `，过了救命线 ${k(cap)}` : ""}，但自动压缩被挡住：${why[0]}。请去这个窗口处理一下。`;
}

/** 服务端不再按语言双写文案——带变量串在这里按用户语言生成 */
function anomalyText(d: Record<string, unknown>, lang: Lang): string | null {
  const mins = Number(d.minutes) || 0;
  switch (d.kind) {
    case "stalled":
      return lang === "en"
        ? `🧊 Possible stall — output token count has been frozen for ${mins} min mid-turn. Consider Interrupt and retry.`
        : `🧊 疑似卡死 —— 回合进行中，输出 token 计数已 ${mins} 分钟纹丝不动。` + "建议点「停止」中断后重试。";
    case "switch_model_prompt": {
      const fams = Array.isArray(d.families) ? (d.families as string[]).join("/") : "?";
      return lang === "en"
        ? `🎛 Claude Code is showing a "Switch model?" dialog (${fams}) that doesn't match any user-initiated switch — not auto-confirmed. ` +
            "Re-pick the model from the dropdown to complete it, or use the Discord buttons."
        : `🎛 会话弹出了「Switch model?」确认框（涉及 ${fams}），不是你发起的切换，我没有代按。` + "要切就去右上模型下拉重选一次（会自动确认），或到 Discord 点按钮。";
    }
    case "model_drift":
      return lang === "en"
        ? `⚠️ Model drift — expected \`${String(d.expected ?? "?")}\` but the session is actually using \`${String(d.actual ?? "?")}\` ` +
            "(likely Claude Code usage-protection downgrade). Restart to pull it back."
        : `⚠️ 模型漂移 —— 预期 \`${String(d.expected ?? "?")}\`，会话实际在用 \`${String(d.actual ?? "?")}\`` + "（多半是 Claude Code 用量保护静默降级）。restart 可拉回。";
    case "link_down":
      return lang === "en"
        ? `⚠️ Link down for ${mins} min — Claude Code is running in tmux, but its channel-server is not connected to the bridge, ` +
            "so messages cannot get in or out. Restarting this agent fixes it."
        : `⚠️ 链路已断开 ${mins} 分钟 —— tmux 里 Claude Code 还在跑，但它的 channel-server 没连上 bridge，` + "消息进不来也出不去。重启这个 agent 可修复。";
    case "ctx_boundary_blocked":
      return ctxBlockedText(d, lang);
  }
  return null;
}

/** BridgeEvent → WebStreamEvent（null = 该事件 v1 不消费） */
export function translate(evt: BridgeEvent, lang: Lang, selfIds: ReadonlySet<string>): WebStreamEvent | null {
  const d = evt.data || {};
  switch (evt.type) {
    case "agent_status":
      return d.status === "done"
        ? { t: "done", ...(d.trigger === "interrupt" ? { interrupted: true, ...(d.cause === "preempt" ? { preempted: true } : {}) } : {}), ...(d.bgPending ? { bgPending: true } : {}) }
        : { t: "status", status: d.status === "compacting" ? "compacting" : "running" };
    case "tool_start":
      return {
        t: "tool",
        name: String(d.name ?? "?"),
        summary: String(d.summary ?? ""),
        state: d.done ? "done" : "running", // AUQ 作答补的卡落地就是完成的（src/lib/auq-echo.ts）
        ...(typeof d.toolId === "string" && d.toolId ? { id: d.toolId } : {}),
        ...(typeof d.detail === "string" && d.detail ? { detail: d.detail } : {}),
        ...recordSrc(d),
      };
    case "tool_done":
      return typeof d.toolId === "string" && d.toolId ? { t: "tool-state", id: d.toolId, state: d.error ? "error" : "done" } : null;
    case "assistant_text":
      if (d.apiError || d.rateLimited) return { t: "notice", text: String(d.text ?? ""), ...recordSrc(d) };
      return { t: "text", text: String(d.text ?? ""), ...(d.progress ? { progress: true } : {}), ...recordSrc(d) };
    case "reply_pending":
      return { t: "replying" };
    case "chat_message":
      return chatMessage(d, selfIds);
    case "question":
      return { t: "ask", id: `auq-${evt.seq}`, questions: mapAuqQuestions(d.questions) };
    case "question_cleared":
      return { t: "ask-cleared" };
    case "auto_deny": {
      const reason = d.reason ? String(d.reason) : "";
      return { t: "text", text: lang === "en" ? `🚫 An action was blocked by auto mode${reason ? `: ${reason}` : ""}` : `🚫 一个操作被 auto 模式拦下${reason ? `：${reason}` : ""}` };
    }
    case "session_anomaly": {
      const text = anomalyText(d, lang);
      return text ? { t: "text", text } : null;
    }
    case "compact_progress":
      return typeof d.pct === "number" ? { t: "compact-progress", pct: d.pct } : null;
    case "thinking_telemetry":
      return {
        t: "telemetry",
        ...(typeof d.elapsedRaw === "string" && d.elapsedRaw ? { elapsed: d.elapsedRaw } : {}),
        ...(typeof d.tokens === "number" ? { tokens: d.tokens } : {}),
        ...(typeof d.effort === "string" && d.effort ? { effort: d.effort } : {}),
      };
    case "bg_task_started":
      return { t: "bg-start", id: String(d.id ?? ""), kind: d.kind === "shell" ? "shell" : "subagent", title: String(d.title ?? ""), ...bgMetaOf(d) };
    case "bg_task_update":
      if (!Array.isArray(d.items) || d.items.length === 0) return null; // 老 bridge 没 items → 无内容可渲染
      return { t: "bg-update", id: String(d.id ?? ""), items: (d.items as unknown[]).map(String), progress: bgProgressOf(d.progress) };
    case "bg_task_completed":
      return { t: "bg-done", id: String(d.id ?? ""), durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined, status: bgEndStatusOf(d.status) };
    case "turn_duration":
      return typeof d.durationMs === "number" ? { t: "turn", ms: d.durationMs } : null;
    case "compact_done":
      return { t: "compact", pre: typeof d.preTokens === "number" ? d.preTokens : 0, post: typeof d.postTokens === "number" ? d.postTokens : 0 };
    default:
      return null;
  }
}

/** 连流即补发的挂起态：thinking / compacting → status；未答的 AUQ → ask（question 事件可能发生在订阅之前） */
export function pendingEvents(p: { question?: { questions: unknown; ts: number } | null; thinking?: boolean; compacting?: boolean }): WebStreamEvent[] {
  const out: WebStreamEvent[] = [];
  if (p.compacting) out.push({ t: "status", status: "compacting" });
  else if (p.thinking) out.push({ t: "status", status: "running" });
  if (p.question) out.push({ t: "ask", id: `auq-pending-${p.question.ts}`, questions: mapAuqQuestions(p.question.questions) });
  return out;
}

/** 连流即补发的后台任务快照：bg-start + 已积累的尾部行，最后一条 bg-sync 全集（空数组也发，幽灵 working 卡靠它收敛） */
export function bgReplayEvents(tasks: ({ id: string; kind: "subagent" | "shell"; title: string; lines?: string[] } & Record<string, unknown>)[]): WebStreamEvent[] {
  const out: WebStreamEvent[] = [];
  for (const t of tasks) {
    out.push({ t: "bg-start", id: t.id, kind: t.kind, title: t.title, ...bgMetaOf(t) });
    if (t.lines?.length) out.push({ t: "bg-update", id: t.id, items: t.lines });
  }
  out.push({ t: "bg-sync", ids: tasks.map((t) => t.id) });
  return out;
}

/** 一个 SSE 帧的 data 行拼起来（心跳 / 注释帧 → null） */
export function frameData(frame: string): string | null {
  const lines = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
  return lines.length ? lines.join("\n") : null;
}

/** 累积的 SSE 字节缓冲 → 其中完整帧解析出的事件 + 剩下的半帧；心跳 / 注释帧和坏帧都跳过（坏帧丢了流照样继续） */
export function drainFrames(buffer: string): { events: BridgeEvent[]; rest: string } {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() || "";
  const events: BridgeEvent[] = [];
  for (const f of frames) {
    const data = frameData(f);
    if (data === null) continue;
    try {
      events.push(JSON.parse(data) as BridgeEvent);
    } catch {
      continue; // 坏帧丢弃：少一条事件由调用方的重连 / 全量拉兜底
    }
  }
  return { events, rest };
}
