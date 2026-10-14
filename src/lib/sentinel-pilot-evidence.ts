/**
 * 哨兵试点（agents-T14b）的单次证据：目标 agent 的会话记录行 + 本次运行的时间窗（dispatchAttemptedAt → finishedAt）→ RunEvidence + 结果行。
 * 纯函数（tests/sentinel-pilot.test.ts）。只看时间窗内、带时间戳的行；发 prompt 之前、finishedAt 之后的工具调用和结果行都不算这一次。
 * 工具分类、按钮、撞额度的口径和 Autopilot 的事件侧（bridge/autopilot-evidence.ts）一致，只是这里从会话记录里读，不靠事件总线。
 */
import { emptyEvidence } from "./autopilot-run.js";
import { countsAsTool, isMutatingTool } from "./autopilot-tools.js";
import { parseInlineButtons } from "./inline-buttons.js";
import { isLimitHitText } from "./quota-wall-text.js";
import { translateSessionLine } from "./session-source.js";
import type { ResultLine, RunSessionEvidence } from "./sentinel-pilot.js";

type AnyRecord = Record<string, any>;

/** `哨兵结果:正常|异常|未检查 — <一句话>`；全角冒号、各种破折号都认，一行一条 */
const RESULT_RE = /哨兵结果\s*[:：]\s*(正常|异常|未检查)\s*(?:[—–\-]+\s*(.*))?$/;

/** 一段文字里最后一条结果行；没有返回 null，不去猜 */
export function parseResultLine(text: string): ResultLine | null {
  let last: ResultLine | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = RESULT_RE.exec(line.replace(/[`*]/g, "").trim());
    if (m) last = { verdict: m[1] as ResultLine["verdict"], note: (m[2] ?? "").trim() };
  }
  return last;
}

const REPLY_TOOL = /^(?:mcp__.+__)?reply$/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** user 行的正文（tool_result 行返回 null） */
function userText(rec: AnyRecord): string | null {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b: AnyRecord) => b?.type === "tool_result")) return null;
  return c.filter((b: AnyRecord) => b?.type === "text" && typeof b.text === "string").map((b: AnyRecord) => b.text).join("\n");
}

/**
 * 人工消息：渠道消息里不是 agent 发的（没有 is_agent="true"），或者在终端里直接敲的字。
 * cron 自己发的 prompt（第一次出现的同文）、系统注入的标签行（<system-reminder>、<command-…>、<task-notification> 等）不算。
 */
function isHumanText(text: string, prompt: { text: string; seen: boolean }): boolean {
  const t = text.trim();
  if (!t || t.startsWith("[Request interrupted")) return false;
  if (!prompt.seen && prompt.text && norm(t) === prompt.text) return (prompt.seen = true), false;
  if (t.startsWith("<channel")) return !/^<channel\b[^>]*\bis_agent="true"/.test(t);
  return !t.startsWith("<");
}

interface Acc { out: RunSessionEvidence; openQuestions: Set<string>; prompt: { text: string; seen: boolean } }

function onAssistant(rec: AnyRecord, acc: Acc): void {
  const ev = acc.out.evidence;
  const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
  const texts: string[] = [];
  for (const b of content as AnyRecord[]) {
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
    const input: AnyRecord = b.input && typeof b.input === "object" ? b.input : {};
    if (REPLY_TOOL.test(b.name)) {
      const text = typeof input.text === "string" ? input.text : "";
      texts.push(text);
      if ((Array.isArray(input.components) && input.components.length > 0) || parseInlineButtons(text).length > 0) ev.buttonsSent += 1;
    }
    if (b.name === "AskUserQuestion" && typeof b.id === "string") acc.openQuestions.add(b.id);
    if (!countsAsTool(b.name)) continue;
    ev.tools += 1;
    if (isMutatingTool(b.name, JSON.stringify(input))) ev.mutating += 1;
  }
  const all = texts.join("\n");
  if (rec.isApiErrorMessage === true ? /rate.?limit|usage.?limit/i.test(String(rec.error ?? "")) || isLimitHitText(all) : isLimitHitText(all)) {
    ev.rateLimitText ??= all.trim() || "rate_limit（没有原文）";
  } else {
    const r = parseResultLine(all);
    if (r) acc.out.result = r;
  }
}

function onUser(rec: AnyRecord, acc: Acc): void {
  const c = rec.message?.content;
  if (Array.isArray(c)) for (const b of c as AnyRecord[]) if (b?.type === "tool_result" && typeof b.tool_use_id === "string") acc.openQuestions.delete(b.tool_use_id);
  if (rec.isMeta === true) return;
  const text = userText(rec);
  if (text !== null && isHumanText(text, acc.prompt)) acc.out.evidence.humanInterleaved = true;
}

/**
 * 时间窗内的行 → 证据。`prompt` 是 cron 任务发出去的原文（不算人工消息）；`runtime` 交给 translateSessionLine 认行格式。
 * 结果行取时间窗内最后出现的那条（assistant 文字或 reply 正文）；撞额度那句不当结果行。
 */
export function collectRunEvidence(
  lines: readonly string[], window: { from: number; to: number }, opts: { runtime?: string; prompt?: string } = {},
): RunSessionEvidence {
  const acc: Acc = { out: { evidence: emptyEvidence(), result: null }, openQuestions: new Set(), prompt: { text: norm(opts.prompt ?? ""), seen: false } };
  const scope = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const rec = translateSessionLine(opts.runtime, line, scope);
    const ts = Date.parse(String(rec?.timestamp ?? ""));
    if (!rec || !Number.isFinite(ts) || ts < window.from || ts > window.to) continue;
    if (rec.type === "assistant") onAssistant(rec, acc);
    else if (rec.type === "user") onUser(rec, acc);
  }
  acc.out.evidence.questionOpen = acc.openQuestions.size > 0;
  return acc.out;
}
