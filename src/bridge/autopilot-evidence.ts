/**
 * Autopilot 的证据收集（归类在 lib/autopilot-run.ts）：订阅事件总线，只给进行中的 run 记账，外加每个 agent 最近一次人类消息的时刻（让位用）。
 * 证据只在内存：bridge 重启后 run 的证据就没了，takeEvidence 会标 evidenceLost，日志里如实写「证据不全」。
 * 只认 trackRun 之后的事件——owner 早先发的、还没答的按钮不会被算成这一轮在等人。tests/autopilot-evidence.test.ts。
 */
import { subscribeEvents, type BridgeEvent } from "./event-bus.js";
import { countsAsTool, emptyEvidence, isMutatingTool, type RunEvidence } from "../lib/autopilot-run.js";

const key = (agent: string) => agent.replace(/^agent-/, "");

const tracking = new Map<string, { runId: string; ev: RunEvidence }>();
const lastHumanAt = new Map<string, number>();

/** 开始给这个 run 记账（投递提醒之前调用，免得回合开头的事件漏掉） */
export function trackRun(agent: string, runId: string): void {
  tracking.set(key(agent), { runId, ev: emptyEvidence() });
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

/** 放弃记账（领到的 run 没递出去） */
export function untrackRun(agent: string, runId: string): void {
  if (tracking.get(key(agent))?.runId === runId) tracking.delete(key(agent));
}

/** 最近一次人类（Discord 用户 / 网页）消息进到这个 agent 的时刻；bridge 启动以来没有 → undefined */
export function lastHumanMessageAt(agent: string): number | undefined {
  return lastHumanAt.get(key(agent));
}

const hasComponents = (d: Record<string, unknown>) => Array.isArray(d.components) && d.components.length > 0;

function onChatMessage(k: string, d: Record<string, unknown>, ev: RunEvidence | undefined, now: number): void {
  if (d.direction === "in" && (d.srcKind === "user" || d.srcKind === "api")) {
    lastHumanAt.set(k, now);
    if (ev) ev.humanInterleaved = true;
  }
  // 「⚙️ 来源」是 bridge 的 notify（cron、脚本），不是 agent 自己发的按钮
  if (ev && d.direction === "out" && hasComponents(d) && !String(d.from ?? "").startsWith("⚙️")) ev.buttonsSent += 1;
}

export function onAutopilotEvent(evt: BridgeEvent, now = Date.now()): void {
  const k = key(evt.agent);
  const ev = tracking.get(k)?.ev;
  const d = evt.data ?? {};
  if (evt.type === "chat_message") return onChatMessage(k, d, ev, now);
  if (!ev) return;
  if (evt.type === "tool_start" && typeof d.name === "string" && countsAsTool(d.name)) {
    ev.tools += 1;
    if (isMutatingTool(d.name)) ev.mutating += 1;
  } else if (evt.type === "assistant_text" && d.rateLimited === true) {
    ev.rateLimitText = String(d.text ?? "rate limited");
  } else if (evt.type === "api_error_turn") {
    ev.failure = `API 报错：${String(d.error ?? "").slice(0, 140) || "（没有原文）"}`;
  } else if (evt.type === "question") {
    ev.questionOpen = true;
  } else if (evt.type === "question_cleared") {
    ev.questionOpen = false;
  }
}

export function initAutopilotEvidence(): () => void {
  return subscribeEvents({}, (evt) => onAutopilotEvent(evt));
}

/** 单测清场 */
export function resetAutopilotEvidence(): void {
  tracking.clear();
  lastHumanAt.clear();
}
