/**
 * Autopilot 的证据收集（归类在 lib/autopilot-run.ts）：订阅事件总线，只给进行中的 run 记账，外加每个 agent 最近一次人类信号的时刻（让位用）。
 * 证据只在内存：bridge 重启后 run 的证据就没了，takeEvidence 会标 evidenceLost，日志里如实写「证据不全」。
 * 只认 trackRun 之后的事件——owner 早先发的、还没答的按钮不会被算成这一轮在等人；run 的回合结束后、下一个回合一开始（thinking /
 * 新的入站消息）就冻结，收尾等证据的那几秒里新回合的工具不算进来。事件按频道认 agent（watcher 缺位时 agent 字段会是 "?"）。
 * tests/autopilot-evidence.test.ts。
 */
import { subscribeEvents, type BridgeEvent } from "./event-bus.js";
import { emptyEvidence, type RunEvidence } from "../lib/autopilot-run.js";
import { countsAsTool, isMutatingTool } from "../lib/autopilot-tools.js";
import { parseInlineButtons } from "../lib/inline-buttons.js";
import type { ActiveRun } from "../lib/autopilot-wake.js";
import { readPrincipals, tokenIdOf } from "../lib/principals.js";

const key = (agent: string) => agent.replace(/^agent-/, "");

interface Tracking {
  runId: string;
  run: ActiveRun;
  missionId: string;
  channelId?: string;
  ev: RunEvidence;
  /** 投递之后见过 thinking（deliver 投给本地时发）：这之前到的 done 是上一回合迟到的 Stop，不是这个 run 的结束 */
  started: boolean;
  /** 见过这个 run 的回合结束；之后再见到 thinking / 入站消息就是下一个回合了 → frozen，不再记 */
  ended: boolean;
  frozen: boolean;
  lastEventAt: number;
  /** 本轮最后一句 assistant 文字：api_error_turn 只带 error:"rate_limit"，重置时间在这句里 */
  lastText?: string;
}
const tracking = new Map<string, Tracking>();
/** 频道 → 在记账的 agent：事件的 agent 字段认不出（"?"、频道 id）时按频道找 */
const byChannel = new Map<string, string>();
const lastHumanAt = new Map<string, number>();
/** 上一个 done 之后有没有真实的回合活动（thinking / 工具 / assistant 文字 / agent 发消息）：重复的 Stop、reconcile 补发的 done 之前没有 */
const turnActivity = new Set<string>();
const ACTIVITY = new Set(["tool_start", "assistant_text", "reply_pending"]);
const RL_NO_TEXT = "rate_limit（没有原文）";
/** 撞额度那句话：本轮早先无关的、带 limit 字样的话不能拿来当额度原文 */
const LIMIT_TEXT = /hit your (?:\w+ )?limit/i;

/** 开始给这个 run 记账（投递提醒之前调用，免得回合开头的事件漏掉） */
export function trackRun(agent: string, run: ActiveRun, missionId: string, channelId?: string, now = Date.now()): void {
  const k = key(agent);
  tracking.set(k, { runId: run.runId, run, missionId, channelId, ev: emptyEvidence(), started: false, ended: false, frozen: false, lastEventAt: now });
  if (channelId) byChannel.set(channelId, k);
}

function drop(k: string): void {
  const t = tracking.get(k);
  if (t?.channelId && byChannel.get(t.channelId) === k) byChannel.delete(t.channelId);
  tracking.delete(k);
}

/** 此刻（同步）这个 agent 在记账的 run 和它的回合开始了没有：回合结束的处理要 await，得在事件到达时就拍下来 */
export function trackedTurn(agent: string): { runId: string; started: boolean } | null {
  const t = tracking.get(key(agent));
  return t ? { runId: t.runId, started: t.started } : null;
}

/** 在记账的 run 的元信息（不取走）：收尾时发现换了一代，要用它给旧一代补日志 */
export function peekTracked(agent: string, runId: string): { run: ActiveRun; missionId: string } | null {
  const t = tracking.get(key(agent));
  return t?.runId === runId ? { run: t.run, missionId: t.missionId } : null;
}

/** 取走证据并停止记账；不是这个 run 在记（bridge 重启过、或早被取走）→ 空证据 + evidenceLost */
export function takeEvidence(agent: string, runId: string): RunEvidence {
  const t = tracking.get(key(agent));
  if (!t || t.runId !== runId) return { ...emptyEvidence(), evidenceLost: true };
  drop(key(agent));
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
  if (tracking.get(key(agent))?.runId === runId) drop(key(agent));
}

/** 本进程还在记账、但 missions.json 里已经不是它的 run（stop 后立刻 start 换了一代）：取走，让调用方给旧一代补一行日志 */
export function takeOrphan(agent: string, currentRunId: string | undefined): { run: ActiveRun; missionId: string; ev: RunEvidence } | null {
  const t = tracking.get(key(agent));
  if (!t || t.runId === currentRunId) return null;
  drop(key(agent));
  return { run: t.run, missionId: t.missionId, ev: t.ev };
}

/**
 * 取走「上一个 done 之后有没有真实回合活动」：回合结束的订阅者在 done 事件到达时同步调用，每个 done 只消费一次——
 * 所以同一回合的第二个 Stop、没有活动的 reconcile 补发 done 拿到的都是 false，不能放行待命 / 等人拍板（P2-9）。
 */
export function takeTurnActivity(agent: string, chatId: string): boolean {
  const byName = turnActivity.delete(key(agent));
  return turnActivity.delete(`#${chatId}`) || byName; // 两边都删：agent 字段填的是频道 id 的事件也对得上
}

/** 最近一次人类信号（Discord 用户 / 网页消息、点「打断」）的时刻；bridge 启动以来没有 → undefined */
export function lastHumanMessageAt(agent: string): number | undefined {
  return lastHumanAt.get(key(agent));
}

function humanSignal(k: string, t: Tracking | undefined, now: number): void {
  lastHumanAt.set(k, now);
  if (t && !t.frozen) t.ev.humanInterleaved = true;
}

/** peer 的 token（principals 里带 peer 标记）：peer 经 /api/v1 发来的请求不是人，不触发让位。每分钟刷新一次 */
let peerTokens = new Set<string>();
async function refreshPeerTokens(): Promise<void> {
  const f = await readPrincipals();
  peerTokens = new Set(f.principals.filter((p) => p.peer).map((p) => `api:${tokenIdOf(p)}`));
}
const isHumanInbound = (d: Record<string, unknown>) => d.srcKind === "user" || (d.srcKind === "api" && !peerTokens.has(String(d.fromId ?? "")));

/** 带按钮：components 字段，或 reply 正文里的行内按钮 [[{#id}文字]]（channel-server 推荐的写法） */
const hasButtons = (d: Record<string, unknown>) =>
  (Array.isArray(d.components) && d.components.length > 0) || parseInlineButtons(String(d.text ?? "")).length > 0;

function onChatMessage(k: string, d: Record<string, unknown>, t: Tracking | undefined, now: number): void {
  if (d.direction === "in") {
    if (t?.ended) t.frozen = true; // 回合结束后又有消息进来：下一个回合
    if (isHumanInbound(d)) humanSignal(k, t, now);
    return;
  }
  // 「⚙️ 来源」是 bridge 的 notify（cron、脚本），不是 agent 自己发的按钮
  if (t && !t.frozen && hasButtons(d) && !String(d.from ?? "").startsWith("⚙️")) t.ev.buttonsSent += 1;
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

function onStatus(k: string, t: Tracking | undefined, d: Record<string, unknown>, now: number): void {
  if (d.status === "thinking" && t) {
    if (t.ended) t.frozen = true;
    else t.started = true;
  }
  if (d.status === "done" && d.trigger === "interrupt") humanSignal(k, t, now); // 人点了「打断」或人类消息抢占：和人说话一样让位
  if (d.status === "done" && t?.started && d.reason !== "bridge_restarted") t.ended = true;
}

export function onAutopilotEvent(evt: BridgeEvent, now = Date.now()): void {
  const k0 = key(evt.agent);
  const k = tracking.has(k0) ? k0 : (byChannel.get(evt.chatId) ?? k0);
  const t = tracking.get(k);
  const d = evt.data ?? {};
  if (t && !t.frozen) t.lastEventAt = now;
  const d0 = d as { status?: unknown; direction?: unknown };
  if (ACTIVITY.has(evt.type) || d0.status === "thinking" || (evt.type === "chat_message" && d0.direction === "out")) {
    turnActivity.add(k);
    turnActivity.add(`#${evt.chatId}`);
  }
  if (evt.type === "chat_message") return onChatMessage(k, d, t, now);
  if (evt.type === "agent_status") return onStatus(k, t, d, now);
  if (t && !t.frozen) onRunEvent(t, evt.type, d, now);
}

export function initAutopilotEvidence(): () => void {
  const refresh = () => void refreshPeerTokens().catch((e) => console.warn("⏱ Autopilot 读 peer token 失败（peer 请求暂按人类算）:", (e as Error).message));
  refresh();
  setInterval(refresh, 60_000).unref?.();
  return subscribeEvents({}, (evt) => onAutopilotEvent(evt));
}

/** 单测清场；peers 给定时直接设 peer token 集合 */
export function resetAutopilotEvidence(peers: string[] = []): void {
  tracking.clear();
  byChannel.clear();
  lastHumanAt.clear();
  turnActivity.clear();
  peerTokens = new Set(peers);
}
