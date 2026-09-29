/**
 * AskUserQuestion 作答的唯一执行点（T65）：网页「待你处理」卡、聊天卡、Discord 三个入口都到这里，替 owner 按键，按安全类对待：
 * 1. 提交方必须带上它看到的那一版（网页：题面 + askId / dialogId；Discord：消息 id），和当前状态对上才往下走，缺了一律 409；
 * 2. 拿窗口执行权（ctx-boundary-inject.ts withWindow）→ 抓屏 → 画面上的问题 / 选项 / 描述和这一版逐项对上（lib/auq-pane.ts
 *    auqPaneMatches）才发键；抓屏失败、画面读不全、对不上一律 409，零发键；
 * 3. 每个 await 之后核代际（auqStates 里还是同一个状态对象），变了就停，剩下的键不发。
 * 已知边界见 PR：终端里有人手动按键、不走 withWindow 的消息注入、恰好在两个词之间折行。单测 tests/auq-answer.test.ts
 */
import { auqIdentity } from "../lib/ask-fingerprint.js";
import { auqPaneMatches, parseAuqPane } from "../lib/auq-pane.js";
import { t } from "../lib/i18n.js";
import { recordMetric } from "../lib/metrics.js";
import { tmuxCapture, tmuxRawStrict, tmuxSendEscape } from "../lib/tmux-helper.js";
import { settleAuq, staleAuqCard } from "./ask-runtime.js";
import { auqStates, buildAuqKeystrokes, clearAuqState, type AuqState } from "./ask-user-question.js";
import { withWindow } from "./ctx-boundary-inject.js";
import { emitEvent } from "./event-bus.js";

/** 提交方看到的那一版。网页：questions 原样 + askId（卡片）或 dialogId（聊天卡）；Discord：点的那条消息的 id */
export interface AuqSeen {
  askId?: unknown;
  dialogId?: unknown;
  questions?: unknown;
  messageId?: string;
}

export interface AuqAnswerInput {
  channelId: string;
  agentName: string;
  action: "submit" | "cancel";
  /** 网页一次性带来的选择；Discord 用 select 攒在状态上的 */
  selections?: unknown;
  seen: AuqSeen;
  via: "api" | "discord";
  who: { principal: string; device?: string };
  /** Discord 点的人（question_cleared 带上，ask-runtime 记是谁取消的） */
  uid?: string;
}

export type AuqAnswerResult =
  | { ok: true; cancelled?: true; keys: number; summary: string[] }
  | { ok: false; status: number; code: string; error: string };

export interface AuqAnswerDeps {
  capture: (target: string) => Promise<string>;
  sendKey: (target: string, key: string) => Promise<void>;
  sendEscape: (target: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const liveDeps: AuqAnswerDeps = {
  capture: (target) => tmuxCapture(target, 40),
  sendKey: async (target, key) => void (await tmuxRawStrict(["send-keys", "-t", target, key])),
  sendEscape: (target) => tmuxSendEscape(target, { strict: true }),
  sleep: (ms) => Bun.sleep(ms),
};
let deps = liveDeps;

/** 单测：换掉抓屏 / 发键 */
export function setAuqAnswerDepsForTest(d?: Partial<AuqAnswerDeps>): void {
  deps = d ? { ...liveDeps, ...d } : liveDeps;
}

/** 逐键间隔：批量 send-keys 会被 AUQ 组件吞掉前面的导航键（2026-08-07 实测，答错选项） */
const KEY_GAP_MS = 120;

const refuse = (status: number, code: string, error: string): AuqAnswerResult => ({ ok: false, status, code, error });
const stale = () => refuse(409, "auq_stale", t("弹框已经换了，刷新后按新的作答（这次没有按键）", "The dialog changed — refresh and answer the new one (no keys sent)"));
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** 提交方看到的是不是当前这一版：Discord 按消息 id（那条消息就是按这一版画的）；网页按 dialogId / askId + 题面精确比 */
function seenRefusal(state: AuqState, i: AuqAnswerInput): AuqAnswerResult | null {
  const { seen } = i;
  if (i.via === "discord") return seen.messageId && seen.messageId === state.messageId ? null : stale();
  const askId = str(seen.askId);
  const dialogId = str(seen.dialogId);
  if (!Array.isArray(seen.questions) || (!askId && !dialogId)) {
    return refuse(409, "auq_identity_required", t("页面是旧版本，没带上弹框身份：刷新后再答（这次没有按键）", "Outdated page sent no dialog identity — refresh and answer again (no keys sent)"));
  }
  if (dialogId && dialogId !== state.dialogId) return stale();
  if (askId && staleAuqCard(askId, state.channelId, state.questions)) return refuse(409, "ask_stale", t("这张卡是上一个弹框的，已作废（这次没有按键）", "This card is for an earlier dialog (no keys sent)"));
  return auqIdentity(seen.questions) === auqIdentity(state.questions) ? null : stale();
}

/** 网页带来的选择按当前题面收一遍（越界的丢掉）；没带就用状态上的（Discord 的 select 攒的） */
function pickSelections(state: AuqState, raw: unknown): number[][] {
  if (!Array.isArray(raw)) return state.selections;
  return state.questions.map((q, qi) => (Array.isArray(raw[qi]) ? raw[qi] : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < q.options.length));
}

export async function answerAuqDialog(i: AuqAnswerInput): Promise<AuqAnswerResult> {
  const state = auqStates.get(i.channelId);
  if (!state) return refuse(404, "auq_gone", t("没有待答的选择框（已经答过、取消了或过期了）", "No pending choice dialog (answered, cancelled or expired)"));
  const bad = seenRefusal(state, i);
  if (bad) return bad;
  const selections = i.action === "submit" ? pickSelections(state, i.selections) : [];
  return withWindow(state.tmuxTarget, t("选择框作答", "a choice-dialog answer"), () => answerHeld(state, i, selections),
    (holder) => refuse(409, "window_busy", t(`这个窗口正在做「${holder}」，这次没有按键，稍后再试`, `The window is busy with "${holder}" — no keys sent, try again`)));
}

/** 拿着窗口执行权：抓屏 → 比对 → 发键。每个 await 之后核一次代际 */
async function answerHeld(state: AuqState, i: AuqAnswerInput, selections: number[][]): Promise<AuqAnswerResult> {
  const live = () => auqStates.get(i.channelId) === state;
  let pane: string;
  try {
    pane = await deps.capture(state.tmuxTarget);
  } catch (e) {
    return refuse(409, "capture_failed", t(`看不到终端画面，这次没有按键：${(e as Error).message}`, `Can't read the terminal — no keys sent: ${(e as Error).message}`));
  }
  if (!live()) return stale();
  const parse = parseAuqPane(pane);
  if (!parse || !auqPaneMatches(state.questions, parse)) {
    // 画面上已经没有这个弹框（终端里答掉了）或换成了别的：这一版作废，pane 通路下一轮按画面重新登记
    finish(state, i, "stale", []);
    return parse
      ? refuse(409, "screen_mismatch", t("终端上的弹框和你看到的不一样，这次没有按键：刷新后按新的作答", "The terminal shows a different dialog — no keys sent; refresh and answer the new one"))
      : refuse(409, "auq_gone", t("弹框已经在终端里答掉或关掉了，这次没有按键", "The dialog was already answered or closed in the terminal — no keys sent"));
  }
  if (i.action === "cancel") {
    try {
      await deps.sendEscape(state.tmuxTarget);
    } catch (e) {
      return refuse(409, "send_failed", t(`取消没生效：${(e as Error).message}`, `Cancel failed: ${(e as Error).message}`)); // Esc 没发出去：弹框还在，可以再取消
    }
    finish(state, i, "cancel", []);
    return { ok: true, cancelled: true, keys: 1, summary: [] };
  }
  const keys = buildAuqKeystrokes({ ...state, selections }, parse);
  for (const [n, key] of keys.entries()) {
    if (!live()) return refuse(409, "dialog_changed", t(`发键途中弹框变了，已停下（发了 ${n} 个键）`, `The dialog changed mid-way — stopped after ${n} keys`));
    try {
      await deps.sendKey(state.tmuxTarget, key);
    } catch (e) {
      return refuse(500, "send_failed", t(`发键失败（发了 ${n} 个键）：${(e as Error).message}`, `Sending keys failed after ${n}: ${(e as Error).message}`));
    }
    await deps.sleep(KEY_GAP_MS);
  }
  finish(state, i, "submit", selections);
  return { ok: true, keys: keys.length, summary: summaryOf(state, selections) };
}

/** 收尾：清状态、记指标；提交的在广播之前把选了什么、谁选的记进「待你处理」（ask-runtime.ts），再广播收掉各端的卡 */
function finish(state: AuqState, i: AuqAnswerInput, reason: "submit" | "cancel" | "stale", selections: number[][]): void {
  clearAuqState(i.channelId);
  if (reason !== "stale") recordMetric(reason === "submit" ? "auq_submit" : "auq_cancel", { channelId: i.channelId, meta: { trigger: i.via, questions: String(state.questions.length) } });
  if (reason === "submit") settleAuq(i.channelId, i.via === "discord" ? "discord" : "interact", { questions: state.questions, selections }, i.who);
  emitEvent({ agent: i.agentName, chatId: i.channelId, type: "question_cleared", data: { reason, via: i.via, ...(i.uid ? { uid: i.uid } : {}) } });
}

function summaryOf(state: AuqState, selections: number[][]): string[] {
  return state.questions.map((q, qi) => {
    const sel = selections[qi] ?? [];
    return `Q${qi + 1}: ${sel.length ? sel.map((oi) => q.options[oi]?.label || `?${oi}`).join(", ") : "(none)"}`;
  });
}

/** Discord 上一个 Q 的 select：只认按当前这一版画的那条消息，旧消息上的选择不动状态（返回 false） */
export function auqDiscordSelect(channelId: string, messageId: string, qIdx: number, values: readonly string[]): boolean {
  const state = auqStates.get(channelId);
  if (!state || !messageId || state.messageId !== messageId || !Number.isInteger(qIdx) || qIdx < 0 || qIdx >= state.questions.length) return false;
  const picked = values.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < state.questions[qIdx].options.length);
  state.selections = state.selections.map((s, qi) => (qi === qIdx ? picked : s));
  return true;
}

/** Discord 那条消息作答后改成的文字 */
export function auqDiscordText(r: AuqAnswerResult): string {
  if (!r.ok) return `⚠️ ${r.error}`;
  return r.cancelled ? t("❌ 已取消（发了 Esc 给 agent）", "❌ Cancelled (sent Esc to the agent)") : `${t("✅ 已提交选择：", "✅ Submitted:")}\n${r.summary.join("\n")}`;
}
