/**
 * 哨兵试点（agents-T14b）的单次证据：目标 agent 的会话记录行 + 本次运行的时间窗（dispatchAttemptedAt → finishedAt）→ RunEvidence + 结果行。
 * 分类内核为纯逻辑；入口热读恢复键并登记观察差异。工具只看原时间窗；结果回复另有落盘宽限，不越过下次派发。
 * 工具分类复用 Autopilot，唯独 ssh 只读命令在这里剥开判断；不改变 Autopilot 或执行权限。
 */
import { emptyEvidence } from "./autopilot-run.js";
import { bashCommandOf, countsAsTool, isMutatingTool } from "./autopilot-tools.js";
import { parseInlineButtons } from "./inline-buttons.js";
import { isLimitHitText } from "./quota-wall-text.js";
import { translateSessionLine } from "./session-source.js";
import type { ResultLine, RunSessionEvidence, RunWindow } from "./sentinel-pilot.js";
import { isReadOnlySentinelSsh } from "./sentinel-pilot-ssh.js";
import { createHash } from "node:crypto";
import { openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";

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
const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell"]);

/** user 行的正文（tool_result 行返回 null） */
function userText(rec: AnyRecord): string | null {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b: AnyRecord) => b?.type === "tool_result")) return null;
  return c.filter((b: AnyRecord) => b?.type === "text" && typeof b.text === "string").map((b: AnyRecord) => b.text).join("\n");
}

function startsPrompt(rec: AnyRecord): boolean {
  const text = userText(rec);
  // Both Claude Code and Codex mark delivered channels meta; they still start real turns.
  // Other metadata and tool results never do; attachment-only user turns do.
  if (text === null || rec.isMeta === true && !(/^\s*<channel\s+source\s*=/.test(text))) return false;
  return !!text.trim() || Array.isArray(rec.message?.content) && rec.message.content.length > 0;
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

/**
 * reply：时间窗内最后一条有文字的回复。回复边界：每次 reply 调用各算一条（同一次模型响应可以发多条渠道消息）；
 * 普通 assistant 文字按 message.id 合在一起（同一条 API 消息拆成的多行）。纯工具调用的行不算回复、不清它。
 */
interface Acc {
  out: RunSessionEvidence; openQuestions: Set<string>; prompt: { text: string; seen: boolean };
  reply: { id: unknown; texts: string[] } | null;
}

/** 一段回复：text 块带 message.id（同 id 相邻合并），reply 调用的 id 是 null（永远自成一条） */
interface Segment { id: unknown; text: string }

function onAssistant(rec: AnyRecord, acc: Acc, audit: boolean, result: boolean, boundary: boolean): void {
  const ev = acc.out.evidence;
  const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
  const msgId = rec.message?.id;
  const segs: Segment[] = [];
  for (const b of content as AnyRecord[]) {
    if (b?.type === "text" && typeof b.text === "string") segs.push({ id: msgId, text: b.text });
    if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
    const input: AnyRecord = b.input && typeof b.input === "object" ? b.input : {};
    if (REPLY_TOOL.test(b.name)) {
      const text = typeof input.text === "string" ? input.text : "";
      segs.push({ id: null, text });
      if (audit && ((Array.isArray(input.components) && input.components.length > 0) || parseInlineButtons(text).length > 0)) ev.buttonsSent += 1;
    }
    if (!audit) continue;
    if (b.name === "AskUserQuestion" && typeof b.id === "string") acc.openQuestions.add(b.id);
    if (!countsAsTool(b.name)) continue;
    ev.tools += 1;
    const detail = JSON.stringify(input);
    if (isMutatingTool(b.name, detail) && !(SHELL_TOOLS.has(b.name) && isReadOnlySentinelSsh(bashCommandOf(detail), boundary))) ev.mutating += 1;
  }
  const all = segs.map((x) => x.text).join("\n");
  if (rec.isApiErrorMessage === true ? /rate.?limit|usage.?limit/i.test(String(rec.error ?? "")) || isLimitHitText(all) : isLimitHitText(all)) {
    if (audit) ev.rateLimitText ??= all.trim() || "rate_limit（没有原文）";
    return;
  }
  if (!result) return;
  for (const seg of segs) {
    if (!seg.text.trim()) continue;
    const r = acc.reply;
    if (r && seg.id !== null && seg.id !== undefined && r.id === seg.id) r.texts.push(seg.text);
    else acc.reply = { id: seg.id, texts: [seg.text] };
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
 * 结果行只从结果窗口内最后一条回复（assistant 文字或 reply 正文）里取：没有结果行就不沿用更早结论；撞额度那句不当回复。
 */
function collectEvidence(
  lines: readonly string[], window: RunWindow, opts: { runtime?: string; prompt?: string }, boundary: boolean,
): RunSessionEvidence {
  const acc: Acc = { out: { evidence: emptyEvidence(), result: null }, openQuestions: new Set(), prompt: { text: norm(opts.prompt ?? ""), seen: false }, reply: null };
  const scope = {};
  let resultClosed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const rec = translateSessionLine(opts.runtime, line, scope);
    const ts = Date.parse(String(rec?.timestamp ?? ""));
    if (!rec || !Number.isFinite(ts) || ts < window.from) continue;
    const audit = ts <= window.to;
    const result = !resultClosed && ts <= (window.resultTo ?? window.to) && ts < (window.nextDispatchAt ?? Infinity);
    if (boundary && !audit && result && rec.type === "user" && startsPrompt(rec)) resultClosed = true;
    if (rec.type === "assistant" && (audit || result)) {
      onAssistant(rec, acc, audit, result, boundary);
    } else if (rec.type === "user" && audit) onUser(rec, acc);
  }
  acc.out.evidence.questionOpen = acc.openQuestions.size > 0;
  acc.out.result = acc.reply ? parseResultLine(acc.reply.texts.join("\n")) : null;
  return acc.out;
}

interface BoundaryPorts {
  policy?: RecoveryPolicyPort;
  observe?: (action: ObservedAction) => void;
}
interface RunIdentity { jobId: string; agent: string; sessionId: string; runKey: string }
const BOUNDARY_KEY = "sentinelEvidenceBoundary";
const PROJECT = "claude-orchestrator";

/** Hot-read the recovery key on every collection; observe returns the baseline and records only classification differences. */
export function collectRunEvidence(lines: readonly string[], window: RunWindow,
  opts: { runtime?: string; prompt?: string; boundary?: BoundaryPorts; run?: RunIdentity; dryRun?: boolean } = {}): RunSessionEvidence {
  const mode = (opts.boundary?.policy ?? recoveryPolicy)(PROJECT, BOUNDARY_KEY).mode;
  if (mode === "on") return collectEvidence(lines, window, opts, true);
  const before = collectEvidence(lines, window, opts, false);
  if (mode !== "observe" || opts.dryRun) return before;
  const after = collectEvidence(lines, window, opts, true);
  if (JSON.stringify(before) === JSON.stringify(after)) return before;
  // A later nextDispatchAt or late reply must not multiply samples for the same audited run.
  const runId = opts.run ? [opts.run.jobId, opts.run.agent, opts.run.sessionId, opts.run.runKey] : null;
  const digest = createHash("sha256").update(JSON.stringify([runId, opts.runtime ?? null, window.from, window.to])).digest("hex");
  // Ledger targets must be ledger tasks/items; cron job and session identities belong in data.run.
  const action: ObservedAction = { project: PROJECT, mechanism: BOUNDARY_KEY, target: "", actionKey: `evidence:${digest}`,
    action: "按新回合边界及安全重定向分类（本次仍沿用基线）", data: {
      window, run: opts.run ?? null, before: { verdict: before.result?.verdict ?? null, mutating: before.evidence.mutating },
      after: { verdict: after.result?.verdict ?? null, mutating: after.evidence.mutating },
    } };
  try {
    if (opts.boundary?.observe) opts.boundary.observe(action);
    else recordObserved(openLedger(), action, Date.now());
  } catch (e) { console.error(`[${BOUNDARY_KEY}] observe 样本记录失败，仍返回基线：`, e); }
  return before;
}
