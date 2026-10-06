/**
 * session/update → Claude Code 形状的条目（与 codex-session.ts 翻 rollout 的产物同形），宿主推给 bridge，网页的流式展示不用改。
 * - 正文：agent_message_chunk 是增量，按 messageId 攒着，换消息 / 出工具调用 / 回合结束（flush）时整条吐出。
 *   思考（agent_thought_chunk）不吐：tmux 下 rollout 的 reasoning 也不显示，两条 transport 看到的东西一致；
 *   适配器标了 _meta.claudestra.display 的整块（Pi：tmux 下会话文件里的 thinking 也显示）吐成 thinking 块，watcher 当进度句。
 *   user_message_chunk 只在 session/load 回放历史时出现，宿主不需要它。
 * - 工具：tool_call 起头就吐 tool_use（watcher 据此发 tool_start），tool_call_update 到 completed / failed 吐 user 的 tool_result。
 *   MCP 调用从 rawInput 的 server / tool 拼成 mcp__<server>__<tool>（reply 的识别、隐藏照旧），入参是 rawInput.arguments；
 *   命令的标题就是去掉 shell 前缀的命令，输出攒 _meta.terminal_output_delta（只留末尾一段）。
 * - plan → update_plan（与 rollout 里 Codex 的计划工具同名同参）；usage_update → context_usage；config_option_update → model_state。
 * - 适配器的中性记号（Pi，pi-adapter/map.ts；codex-acp 不发）：tool_call 的 _meta.claudestra.toolUse 直接当 tool_use 的名字和入参；
 *   session_info_update 的 _meta.claudestra.compacted → compact_boundary，notice → 进度句。
 * - 压缩完成只认宿主按运行时定的那一个来源（CompactSource.from）：Pi 认上面的 compacted，Codex 认 ACP 的 compaction_update（只有 completed
 *   出边界，同一 compactionId 只出一次；开始 / 失败是进度句）。另一种来源的同类字段一律不认，免得别处带的字段冒充压缩完成。
 * tests/acp-updates.test.ts。
 */
import { codexCommandText, codexTextOf } from "../codex-session.js";
import { modelStateEntry, parseConfigOptions } from "./config.js";
import type { TurnEndFailure } from "./failures.js";

type Rec = Record<string, any>;

/** 一次工具调用攒到的全部字段（tool_call 起头，tool_call_update 只带变了的字段） */
interface ToolState {
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Rec;
  rawOutput?: Rec;
  content?: Rec[];
  locations?: Rec[];
  toolUse?: { name: string; input: Rec };
  mcp: boolean;
  out: string;
  started: boolean;
  finished: boolean;
}

/** 命令输出只留末尾这么多（transcript.ts 据此认出开头那行被截了一半） */
export const OUTPUT_TAIL = 64 * 1024;
/** 结束过的调用 id 记这么多个：迟到的 tool_call_update 不能让它再起一次头 */
const DONE_CAP = 500;
const TERMINAL = new Set(["completed", "failed"]);

/** compact_boundary 认哪种来源（见文件头）；trigger 由宿主按这一轮是不是 /compact 命令给 */
export interface CompactSource {
  from: "claudestra-meta" | "compaction-update";
  trigger?: () => "manual" | "auto";
}

export interface AcpTranslator {
  /** 一条 session/update 的 update 字段 → 零到多条条目 */
  push(update: unknown): Rec[];
  /** 回合结束：吐出攒着的正文 */
  flush(): Rec[];
}

/**
 * 线程状态（session_info_update 的 threadStatus.type：idle / active / systemError / notLoaded）；不是这类更新返回 null。
 * codex-acp 放在 _meta.codex，Pi 适配器用中性的 _meta.claudestra（pi-adapter/map.ts），两个都认。
 */
export function threadStatusOf(update: unknown): string | null {
  const u = update as Rec | null;
  if (u?.sessionUpdate !== "session_info_update") return null;
  const t = u._meta?.codex?.threadStatus?.type ?? u._meta?.claudestra?.threadStatus?.type;
  return typeof t === "string" ? t : null;
}

/** 适配器在 idle 上带的这一轮结局（Pi：pi-adapter/map.ts turnEnd；自研 Codex 适配器另带 id / retry 等）；codex-acp 2.1.0 不带，返回 null */
export function turnEndOf(update: unknown): { stopReason?: string; failure?: TurnEndFailure } | null {
  const t = (update as Rec | null)?._meta?.claudestra?.turn;
  return t && typeof t === "object" ? t : null;
}

function toolUseOf(t: ToolState): { name: string; input: Rec } {
  if (t.toolUse) return t.toolUse;
  const raw = t.rawInput ?? {};
  if (t.mcp || (typeof raw.server === "string" && typeof raw.tool === "string")) {
    const args = raw.arguments && typeof raw.arguments === "object" ? raw.arguments : {};
    return { name: `mcp__${raw.server ?? "mcp"}__${raw.tool ?? "tool"}`, input: args };
  }
  const path = t.locations?.find((l) => typeof l?.path === "string")?.path as string | undefined;
  switch (t.kind) {
    case "execute":
      return { name: "Bash", input: { command: t.title || codexCommandText(raw.command) } };
    case "read":
      return { name: "Read", input: { file_path: path ?? t.title ?? "" } };
    case "edit":
      return { name: "Edit", input: { file_path: path ?? t.title ?? "" } };
    case "search":
      return { name: "Grep", input: { pattern: t.title ?? "" } };
    case "fetch":
      return { name: "WebSearch", input: { query: typeof raw.query === "string" ? raw.query : t.title ?? "" } };
    default:
      return { name: t.title || t.kind || "tool", input: raw };
  }
}

function resultText(t: ToolState): string {
  const ro = t.rawOutput ?? {};
  if (typeof ro.error?.message === "string" && ro.error.message) return ro.error.message;
  if (ro.result && typeof ro.result === "object") return codexTextOf(ro.result.content) || JSON.stringify(ro.result);
  if (t.out) return t.out;
  const texts = (t.content ?? []).map((c) => (c?.type === "content" && c.content?.type === "text" ? String(c.content.text ?? "") : "")).filter(Boolean);
  if (texts.length) return texts.join("\n");
  return typeof ro.exit_code === "number" ? `exit ${ro.exit_code}` : "";
}

function mergeTool(t: ToolState, u: Rec): void {
  for (const k of ["kind", "title", "status", "rawInput", "rawOutput", "content", "locations"] as const) {
    if (u[k] !== undefined && u[k] !== null) (t as any)[k] = u[k];
  }
  const m = u._meta ?? {};
  if (m.is_mcp_tool_call === true) t.mcp = true;
  const cc = m.claudestra?.toolUse;
  if (typeof cc?.name === "string" && cc.input && typeof cc.input === "object") t.toolUse = { name: cc.name, input: cc.input };
  const delta = m.terminal_output_delta?.data ?? m.mcp_output_delta?.data;
  if (typeof delta === "string" && delta) t.out = (t.out + delta).slice(-OUTPUT_TAIL);
}

/**
 * ACP compaction_update（unstable，宿主在 initialize 声明 session.compaction 才会收到；来源不是它就一概不理）。同一 compactionId
 * 到了终态就不再理：重复的 completed、终态后迟到的更新都不出第二条。completed → 边界的 compactMetadata，in_progress / failed → 进度句。
 * 终态 id 不按数量淘汰：compactionId 只在会话内唯一，translator 随会话 id 换新（host.ts），所以终态记到会话结束；
 * 淘汰了再来的 completed 会被当成首次完成，把失败 / 取消的压缩也报成成功。只有「已开始」的 id 有上限（只管进度句去重）
 */
function compactionTracker(compact: CompactSource): (u: Rec) => { boundary: Rec } | { progress: string } | null {
  const ended = new Set<string>();
  const started = new Set<string>();
  return (u) => {
    const id = typeof u.compactionId === "string" ? u.compactionId : "";
    if (compact.from !== "compaction-update" || !id || ended.has(id)) return null;
    const first = !started.has(id);
    if (["completed", "failed", "cancelled"].includes(u.status)) {
      ended.add(id);
      started.delete(id);
    } else {
      started.add(id);
      if (started.size > DONE_CAP) started.delete(started.values().next().value as string);
    }
    if (u.status === "completed") return { boundary: { trigger: compact.trigger?.() ?? "auto" } };
    if (u.status === "failed") return { progress: `上下文压缩没成功${typeof u.error === "string" && u.error ? `：${u.error}` : ""}` };
    return u.status === "in_progress" && first ? { progress: "📦 正在压缩上下文…" } : null;
  };
}

export function createAcpTranslator(now: () => string = () => new Date().toISOString(), compact: CompactSource = { from: "claudestra-meta" }): AcpTranslator {
  let text = "";
  let textId: string | undefined;
  let planSeq = 0;
  const tools = new Map<string, ToolState>();
  const done = new Set<string>();

  const flushText = (): Rec[] => {
    const t = text;
    text = "";
    textId = undefined;
    return t.trim() ? [{ type: "assistant", timestamp: now(), message: { content: [{ type: "text", text: t }] } }] : [];
  };

  const toolEntries = (id: string, t: ToolState): Rec[] => {
    const out: Rec[] = [];
    if (!t.started) {
      t.started = true;
      out.push(...flushText(), { type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", id, ...toolUseOf(t) }] } });
    }
    if (!t.finished && t.status && TERMINAL.has(t.status)) {
      t.finished = true;
      tools.delete(id);
      done.add(id);
      if (done.size > DONE_CAP) done.delete(done.values().next().value as string);
      const block = { type: "tool_result", tool_use_id: id, content: resultText(t), ...(t.status === "failed" ? { is_error: true } : {}) };
      out.push({ type: "user", timestamp: now(), message: { content: [block] } });
    }
    return out;
  };

  const chunk = (u: Rec): Rec[] => {
    const piece = u.content?.type === "text" && typeof u.content.text === "string" ? u.content.text : "";
    if (!piece) return [];
    const id = typeof u.messageId === "string" ? u.messageId : undefined;
    const out = text && id !== textId ? flushText() : [];
    textId = id;
    text += piece;
    return out;
  };

  /** 进度句：watcher 认的 thinking 块（💭 一行，不算答复），当场吐 */
  const progress = (text: unknown): Rec[] =>
    typeof text === "string" && text.trim() ? [...flushText(), { type: "assistant", timestamp: now(), message: { content: [{ type: "thinking", thinking: text }] } }] : [];

  const boundary = (compactMetadata: Rec): Rec[] => [...flushText(), { type: "system", subtype: "compact_boundary", timestamp: now(), compactMetadata }];
  const info = (c: Rec): Rec[] =>
    compact.from === "claudestra-meta" && c.compacted && typeof c.compacted === "object" ? boundary(c.compacted) : progress(c.notice);
  const compaction = compactionTracker(compact);

  const plan = (u: Rec): Rec[] => {
    const id = `acp-plan-${++planSeq}`;
    const steps = (Array.isArray(u.entries) ? u.entries : []).map((e: Rec) => ({ step: String(e?.content ?? ""), status: String(e?.status ?? "pending") }));
    return [
      ...flushText(),
      { type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", id, name: "update_plan", input: { plan: steps } }] } },
      { type: "user", timestamp: now(), message: { content: [{ type: "tool_result", tool_use_id: id, content: "Plan updated" }] } },
    ];
  };

  return {
    push(update) {
      const u = update as Rec | null;
      if (!u || typeof u !== "object") return [];
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          return chunk(u);
        case "agent_thought_chunk":
          return u._meta?.claudestra?.display === true ? progress(u.content?.text) : [];
        case "session_info_update":
          return info(u._meta?.claudestra ?? {});
        case "compaction_update":
          return ((r) => (!r ? [] : "boundary" in r ? boundary(r.boundary) : progress(r.progress)))(compaction(u));
        case "tool_call":
        case "tool_call_update": {
          const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
          if (!id || done.has(id)) return [];
          const t = tools.get(id) ?? { mcp: false, out: "", started: false, finished: false };
          tools.set(id, t);
          mergeTool(t, u);
          return toolEntries(id, t);
        }
        case "plan":
          return plan(u);
        case "usage_update":
          return typeof u.used === "number" && u.used > 0
            ? [{ type: "system", subtype: "context_usage", timestamp: now(), tokens: u.used, window: typeof u.size === "number" ? u.size : null }]
            : [];
        case "config_option_update": {
          const e = modelStateEntry(parseConfigOptions(u.configOptions), now());
          return e ? [e] : [];
        }
        default:
          return []; // 历史回放、命令表等：不进流式条目（线程状态见 threadStatusOf）
      }
    },
    flush: flushText,
  };
}
