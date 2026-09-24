/**
 * 后台 subagent 的进度与真实状态（bg-activity-watcher → web 后台任务卡）。
 *
 * 状态只认记录里的真信号，不按「N 分钟没输出」猜——等 CI、跑长测试时 subagent 可以十几分钟不写一行。
 * CC 把一条 assistant 消息按内容块逐条落盘（同一 message.id），只有末块带 stop_reason，且最终答复的
 * stop_reason 常是 null，所以「完成」按整条消息的形态判，规则见 subagentEndStatus。
 */
import { readFileSync } from "fs";

export interface SubagentMeta {
  description?: string;
  agentType?: string;
  model?: string;
  stoppedByUser?: boolean;
}

/** `agent-<id>.jsonl` 旁边的 `agent-<id>.meta.json`。读不到 / 坏 JSON → 空对象（卡片退回显示 id） */
export function readSubagentMeta(jsonlPath: string): SubagentMeta {
  try {
    const j = JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, ".meta.json"), "utf-8")) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim() : undefined);
    return { description: str("description"), agentType: str("agentType"), model: str("model"), stoppedByUser: j.stoppedByUser === true };
  } catch {
    return {};
  }
}

export interface SubagentProgress {
  /** 第一条记录的时间（ms）——耗时从这里算，不从 bridge 发现文件那一刻算 */
  firstTs?: number;
  /** 最后一条记录的时间（ms）——「静默 N 分钟」从这里算 */
  lastTs?: number;
  /** 最近一条 assistant 的上下文占用（input + cache 读写），与 CC 底栏「↓ 407k tokens」同口径 */
  ctxTokens?: number;
  toolCount: number;
  /** 最近一条 assistant 以 end_turn / stop_sequence 收尾 —— subagent 明确交回了最终答复 */
  ended: boolean;
  /** 最近一条 assistant 消息的形态（优先级 tool > structured > text）。tool = 调了别的工具：结果没回来是在跑工具
   *  （等 CI），回来了模型还要接着想，都不算完；structured = 用 StructuredOutput 交答卷；undefined = 只有 thinking */
  turn?: "text" | "structured" | "tool";
  /** turn = text 时这条消息的文本长度——短文本多半是「Let me write the file.」这类工具调用前的开场白 */
  textChars: number;
  /** 最新 user 记录是「[Request interrupted by user…]」—— 被中断（CC 不一定往 meta 写 stoppedByUser） */
  interrupted: boolean;
  msgId?: string;
}

export const EMPTY_PROGRESS: SubagentProgress = { toolCount: 0, ended: false, textChars: 0, interrupted: false };

const FINAL_TOOL = "StructuredOutput";
const ENDED_STOPS = new Set(["end_turn", "stop_sequence"]);
const INTERRUPT_RE = /^\[Request interrupted by user/;

type Block = { type?: string; text?: string; name?: string; is_error?: boolean };
type RawMessage = { id?: string; stop_reason?: string | null; usage?: Record<string, unknown>; content?: unknown };

/** 吃进一条 jsonl 记录，返回新的进度（纯函数，tests/subagent-progress.test.ts） */
export function nextProgress(p: SubagentProgress, rec: unknown): SubagentProgress {
  if (!rec || typeof rec !== "object") return p;
  const r = rec as { type?: string; timestamp?: string; message?: RawMessage };
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  const out: SubagentProgress = Number.isFinite(ts) ? { ...p, firstTs: p.firstTs ?? ts, lastTs: ts } : { ...p };
  if (!r.message) return out;
  if (r.type === "user") return onUser(out, r.message.content);
  return r.type === "assistant" ? onAssistant(out, r.message) : out;
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

function onUser(p: SubagentProgress, content: unknown): SubagentProgress {
  const blocks = blocksOf(content);
  const text = typeof content === "string" ? content : blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
  if (INTERRUPT_RE.test(text.trim())) return { ...p, interrupted: true };
  // turn=structured 时最新消息里只有 StructuredOutput 一个工具：它的结果报错 = 答卷被驳回，模型要重交
  if (p.turn === "structured" && blocks.some((b) => b.type === "tool_result" && b.is_error === true)) return { ...p, turn: undefined };
  return p;
}

function onAssistant(p: SubagentProgress, msg: RawMessage): SubagentProgress {
  const fresh = !msg.id || msg.id !== p.msgId; // 同一 message.id 的后续内容块并进同一条消息
  let turn = fresh ? undefined : p.turn;
  let textChars = fresh ? 0 : p.textChars;
  let tools = 0;
  for (const b of blocksOf(msg.content)) {
    if (b.type === "text" && b.text?.trim()) {
      textChars += b.text.trim().length;
      turn ??= "text";
    } else if (b.type === "tool_use") {
      tools++;
      turn = b.name === FINAL_TOOL && turn !== "tool" ? "structured" : "tool";
    }
  }
  const u = msg.usage;
  const n = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
  const ctx = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  return {
    ...p,
    ctxTokens: ctx > 0 ? ctx : p.ctxTokens,
    toolCount: p.toolCount + tools,
    ended: ENDED_STOPS.has(msg.stop_reason ?? ""),
    turn,
    textChars,
    interrupted: false,
    msgId: msg.id,
  };
}

/** 像最终答复的消息要静默多久才判完成：CC 可能还在流式生成同一条消息的下一块（大文件 Write 的入参实测 279s） */
const ANSWER_QUIET_MS = 90_000;
/** 短文本答复（< PREAMBLE_MAX_CHARS）等更久：本机实测工具前开场白都 ≤76 字、stop=null 的最终答复都 ≥156 字 */
const PREAMBLE_MAX_CHARS = 120;
const PREAMBLE_QUIET_MS = 5 * 60_000;

/**
 * 该不该收尾、以什么状态收尾（null = 还在跑）。silentMs = 文件多久没长，silentLimitMs = 彻底没动静的兜底上限。
 *   - stopped：meta.stoppedByUser，或最新 user 记录是中断标记
 *   - done：end_turn / stop_sequence 立即；最新消息只有文本或 StructuredOutput（stop_reason 可为 null）且静默够久
 *   - 其余（在跑工具、等模型回话、只有 thinking）只受 silentLimitMs 约束 → idle
 */
export function subagentEndStatus(p: SubagentProgress, meta: SubagentMeta, silentMs: number, silentLimitMs: number): "done" | "stopped" | "idle" | null {
  if (meta.stoppedByUser || p.interrupted) return "stopped";
  if (p.ended) return "done";
  const quiet = p.turn === "structured" ? ANSWER_QUIET_MS : p.turn === "text" ? (p.textChars >= PREAMBLE_MAX_CHARS ? ANSWER_QUIET_MS : PREAMBLE_QUIET_MS) : null;
  if (quiet !== null && silentMs >= quiet) return "done";
  return silentMs > silentLimitMs ? "idle" : null;
}
