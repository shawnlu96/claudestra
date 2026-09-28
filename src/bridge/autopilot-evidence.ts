/**
 * Autopilot 的证据收集（归类在 lib/autopilot-run.ts）：订阅事件总线，只给进行中的 run 记账，外加每个 agent 最近一次人类信号的时刻（让位用）。
 * 证据只在内存：bridge 重启后 run 的证据就没了，takeEvidence 会标 evidenceLost，日志里如实写「证据不全」。
 * 只认 trackRun 之后的事件——owner 早先发的、还没答的按钮不会被算成这一轮在等人。tests/autopilot-evidence.test.ts。
 */
import { subscribeEvents, type BridgeEvent } from "./event-bus.js";
import { emptyEvidence, type RunEvidence } from "../lib/autopilot-run.js";
import { countsAsTool, isMutatingTool } from "../lib/autopilot-tools.js";
import { parseInlineButtons } from "../lib/inline-buttons.js";
import type { ActiveRun } from "../lib/autopilot-wake.js";

const key = (agent: string) => agent.replace(/^agent-/, "");

interface Tracking {
  runId: string;
  run: ActiveRun;
  missionId: string;
  ev: RunEvidence;
  /** 投递之后见过 thinking（deliver 投给本地时发）：这之前到的 done 是上一回合迟到的 Stop，不是这个 run 的结束 */
  started: boolean;
  lastEventAt: number;
  /** 本轮最后一句 assistant 文字：api_error_turn 只带 error:"rate_limit"，重置时间在这句里 */
  lastText?: string;
}
const tracking = new Map<string, Tracking>();
const lastHumanAt = new Map<string, number>();
const RL_NO_TEXT = "rate_limit（没有原文）";
const LIMIT_TEXT = /\blimit\b/i;

/** 开始给这个 run 记账（投递提醒之前调用，免得回合开头的事件漏掉） */
export function trackRun(agent: string, run: ActiveRun, missionId: string, now = Date.now()): void {
  tracking.set(key(agent), { runId: run.runId, run, missionId, ev: emptyEvidence(), started: false, lastEventAt: now });
}

/** 取走证据并停止记账；不是这个 run 在记（bridge 重启过、或早被取走）→ 空证据 + evidenceLost */
export function takeEvidence(agent: string, runId: string): RunEvidence {
  const t = tracking.get(key(agent));
  if (!t || t.runId !== runId) return { ...emptyEvidence(), evidenceLost: true };
  tracking.delete(key(agent));
  return t.ev;
}

/** 本进程正在给这个 run 记账；false = bridge 重启过（证据丢了）或早已收尾 */
export function isTracking(agent: string, runId: string): boolean {
  return tracking.get(key(agent))?.runId === runId;
}

/** 这个 run 的回合已经开始了（见过投递之后的 thinking） */
export function runStarted(agent: string, runId: string): boolean {
  const t = tracking.get(key(agent));
  return t?.runId === runId && t.started;
}

/** 最近一条记进这个 run 的事件的时刻：收尾前等它安静下来（watcher 在 Stop 之后才把最后几行 jsonl 读完） */
export function lastEvidenceAt(agent: string): number | undefined {
  return tracking.get(key(agent))?.lastEventAt;
}

/** 放弃记账（领到的 run 没递出去） */
export function untrackRun(agent: string, runId: string): void {
  if (tracking.get(key(agent))?.runId === runId) tracking.delete(key(agent));
}

/** 本进程还在记账、但 missions.json 里已经不是它的 run（stop 后立刻 start 换了一代）：取走，让调用方给旧一代补一行日志 */
export function takeOrphan(agent: string, currentRunId: string | undefined): { run: ActiveRun; missionId: string; ev: RunEvidence } | null {
  const t = tracking.get(key(agent));
  if (!t || t.runId === currentRunId) return null;
  tracking.delete(key(agent));
  return { run: t.run, missionId: t.missionId, ev: t.ev };
}

/** 最近一次人类信号（Discord 用户 / 网页消息、点「打断」）的时刻；bridge 启动以来没有 → undefined */
export function lastHumanMessageAt(agent: string): number | undefined {
  return lastHumanAt.get(key(agent));
}

function humanSignal(k: string, t: Tracking | undefined, now: number): void {
  lastHumanAt.set(k, now);
  if (t) t.ev.humanInterleaved = true;
}

/** 带按钮：components 字段，或 reply 正文里的行内按钮 [[{#id}文字]]（channel-server 推荐的写法） */
const hasButtons = (d: Record<string, unknown>) =>
  (Array.isArray(d.components) && d.components.length > 0) || parseInlineButtons(String(d.text ?? "")).length > 0;

function onChatMessage(k: string, d: Record<string, unknown>, t: Tracking | undefined, now: number): void {
  if (d.direction === "in" && (d.srcKind === "user" || d.srcKind === "api")) return humanSignal(k, t, now);
  // 「⚙️ 来源」是 bridge 的 notify（cron、脚本），不是 agent 自己发的按钮
  if (t && d.direction === "out" && hasButtons(d) && !String(d.from ?? "").startsWith("⚙️")) t.ev.buttonsSent += 1;
}

function onRunEvent(t: Tracking, type: BridgeEvent["type"], d: Record<string, unknown>, now: number): void {
  const ev = t.ev;
  if (type === "tool_start" && typeof d.name === "string" && countsAsTool(d.name)) {
    ev.tools += 1;
    if (isMutatingTool(d.name, d.detail)) ev.mutating += 1;
  } else if (type === "assistant_text" && !d.progress) {
    t.lastText = String(d.text ?? "");
    if (d.rateLimited === true || (ev.rateLimitText === RL_NO_TEXT && LIMIT_TEXT.test(t.lastText))) {
      ev.rateLimitText = t.lastText || RL_NO_TEXT;
      ev.rateLimitAt = now;
    }
  } else if (type === "api_error_turn") {
    const err = String(d.error ?? "");
    // 新版 Claude Code 撞额度（session / weekly limit）落成 isApiErrorMessage + error:"rate_limit"，文字另起一条 assistant_text
    if (/rate.?limit|usage.?limit/i.test(err)) {
      ev.rateLimitText ??= t.lastText && LIMIT_TEXT.test(t.lastText) ? t.lastText : RL_NO_TEXT;
      ev.rateLimitAt ??= now;
    } else ev.failure = `API 报错：${err.slice(0, 140) || "（没有原文）"}`;
  } else if (type === "question") {
    ev.questionOpen = true;
  } else if (type === "question_cleared") {
    ev.questionOpen = false;
  }
}

export function onAutopilotEvent(evt: BridgeEvent, now = Date.now()): void {
  const k = key(evt.agent);
  const t = tracking.get(k);
  const d = evt.data ?? {};
  if (t) t.lastEventAt = now;
  if (evt.type === "chat_message") return onChatMessage(k, d, t, now);
  if (evt.type === "agent_status") {
    if (d.status === "thinking" && t) t.started = true;
    if (d.status === "done" && d.trigger === "interrupt") humanSignal(k, t, now); // 人点了「打断」或人类消息抢占：和人说话一样让位
    return;
  }
  if (t) onRunEvent(t, evt.type, d, now);
}

export function initAutopilotEvidence(): () => void {
  return subscribeEvents({}, (evt) => onAutopilotEvent(evt));
}

/** 单测清场 */
export function resetAutopilotEvidence(): void {
  tracking.clear();
  lastHumanAt.clear();
}
