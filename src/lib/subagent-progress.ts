/**
 * 后台 subagent 的进度与真实状态（bg-activity-watcher → web 后台任务卡）。
 *
 * 状态只认记录里的真信号，不再「3 分钟没输出就算完」——等 CI、跑长测试时 subagent
 * 可以十几分钟不写一行，旧规则会把还在跑的任务标成完成（2026-09-24 实测 21 分钟被判结束，
 * 27 分钟时 CC 底栏还显示在跑）。
 *   - 完成：最后一条 assistant 记录 stop_reason = end_turn（subagent 交回最终答复）
 *   - 已停止：同名 .meta.json 里 stoppedByUser = true（CC 在用户停掉它时写入）
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
  /** 最后一条 assistant 是 end_turn —— subagent 已交回最终答复 */
  ended: boolean;
}

export const EMPTY_PROGRESS: SubagentProgress = { toolCount: 0, ended: false };

/** 吃进一条 jsonl 记录，返回新的进度（纯函数，tests/subagent-progress.test.ts） */
export function nextProgress(p: SubagentProgress, rec: unknown): SubagentProgress {
  if (!rec || typeof rec !== "object") return p;
  const r = rec as { type?: string; timestamp?: string; message?: { stop_reason?: string; usage?: Record<string, unknown>; content?: unknown } };
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  const out: SubagentProgress = Number.isFinite(ts) ? { ...p, firstTs: p.firstTs ?? ts, lastTs: ts } : { ...p };
  if (r.type !== "assistant" || !r.message) return out;
  const u = r.message.usage;
  const n = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
  const ctx = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  const tools = Array.isArray(r.message.content) ? r.message.content.filter((b) => (b as { type?: string })?.type === "tool_use").length : 0;
  return { ...out, ctxTokens: ctx > 0 ? ctx : out.ctxTokens, toolCount: out.toolCount + tools, ended: r.message.stop_reason === "end_turn" };
}

/** 该不该收尾、以什么状态收尾（null = 还在跑）。silentLimitMs 是「彻底没动静」的兜底上限 */
export function subagentEndStatus(p: SubagentProgress, meta: SubagentMeta, silentMs: number, silentLimitMs: number): "done" | "stopped" | "idle" | null {
  if (meta.stoppedByUser) return "stopped";
  if (p.ended) return "done";
  return silentMs > silentLimitMs ? "idle" : null;
}
