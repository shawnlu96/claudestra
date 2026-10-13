/**
 * v2.0.19+ AskUserQuestion (Claude Code 内建工具) Discord 化适配。
 *
 * 背景：agent 在运行中调 AskUserQuestion 工具 → Claude Code TUI 弹一个多选 modal
 * （`❯ N. [ ] label` 风格 + 横向 section 切换）。手机用户没法 tmux attach 直接按
 * 键，bridge 不识别就当 "✅ 完成" 把 turn 当结束发，用户看不到问题。
 *
 * 这里做的事：
 *  1. watcher 解析 jsonl 时识别 `tool_use: AskUserQuestion`，抽 questions 数组
 *  2. 把每个 question 渲染成 Discord 一个 select menu（multiSelect → max_values=N）
 *  3. 加 Submit / Cancel 按钮
 *  4. 用户在 Discord 选完 + 点 Submit，bridge 翻译成 tmux 键序列（Down/Enter/Right/...）
 *     发回 agent 的 TUI 完成选择
 *
 * AskUserQuestion schema (Claude Code 内建)：
 *   questions: 1-4 个 question，每个 question 有
 *     question: string         (问题文本)
 *     header:   string  ≤12    (短标签，section 标题)
 *     options:  2-4 个 option，每个 option 有 label + description? + preview?
 *     multiSelect: boolean
 *
 * TUI 键位（CC 2.1.222 隔离会话逐键实测，v2.17.2 重校准）：
 *   - **单问题单选**（无 tab 栏）：↑↓/数字移光标，**Enter 一击即选定并提交**。
 *   - **tabbed**（多问题或任一 multiSelect，首行 `← ☐sec … ✔Submit →`）：
 *     多选 section 数字键直接 toggle `[ ]`（绝对定位，不依赖光标）；单选 section
 *     数字移光标、Enter 选定并自动跳下一段；Right 切段；Submit(Review) 段光标
 *     默认在 "1. Submit answers"，Enter 提交。
 *   - Esc 取消（两种形态同）。
 *
 * v2.17.2 起 buildAuqKeystrokes 可选传入 pane 解析结果（lib/auq-pane.ts）做
 * 现场对账：单选按当前光标位算相对步数、多选按当前勾选态算 toggle 差集 ——
 * 用户先在终端里拨过几下也不会答错。
 */

import type { Client, TextChannel } from "discord.js";
import { parseAuqPane, type AuqPaneParse } from "../lib/auq-pane.js";
import {
  auqDialogIdentity, auqQuestionFromScreen, auqQuestionsOnScreen, keepAuqOptionText, observeAuqByName, observeAuqPinned, sameAuqDialog, sameAuqTarget, sendAuqKeysChecked,
  type AuqDialogIdentity, type AuqIo, type AuqObservation, type AuqSendResult,
} from "../lib/auq-dialog-identity.js";
import { keysBlockedAt } from "../lib/codex-key-guard.js";
import { recordMetric } from "../lib/metrics.js";
import { isLocalChannel } from "../lib/pending-ops.js";
import { readRegistryAgents } from "../lib/registry.js";
import { tmuxRawStrict, tmuxSendEscape, windowTarget } from "../lib/tmux-helper.js";
import { settleAuq, staleAuqCard } from "./ask-runtime.js";
import { emitEvent } from "./event-bus.js";
import { tmuxScreenshot } from "./screenshot.js";

export interface AuqOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AuqQuestion {
  question: string;
  header: string;
  options: AuqOption[];
  multiSelect?: boolean;
}

/** 一条正在进行的 AskUserQuestion 的状态 —— 等用户选完点 Submit。 */
export interface AuqState {
  channelId: string;
  questions: AuqQuestion[];
  /** selections[qIdx] = 这个 question 的选项 index 数组（0-based） */
  selections: number[][];
  /** Discord 那条带 select menu 的消息 id（按 Submit 时编辑掉 components） */
  messageId: string;
  /** agent 的 tmux 目标（e.g. "master:agent-foo"），按键发这里 */
  tmuxTarget: string;
  ts: number;
  /** 检测来源：jsonl（旧版 CC 即时落盘）或 pane（v2.17.2+ 及时通路） */
  source?: "jsonl" | "pane";
  /** 这一代的代号：Discord 按钮 id、question 事件都带着；换了弹框就换代，旧卡的代号对不上 */
  gen?: string;
  agentName?: string;
  /** 注册时核过的弹框身份 + 现场（lib/auq-dialog-identity.ts）；没有它的状态不能作答 */
  identity?: AuqDialogIdentity;
  /** 正有一次作答在发键：第二次作答拒掉，观察器这期间不换代 */
  busy?: boolean;
}

export const auqStates = new Map<string, AuqState>();

/**
 * 注册 AUQ 状态，与 Discord 渲染解耦。
 *
 * Web-only 模式（或 Discord post 失败）下也必须有 AuqState，否则
 * POST /api/v1/agents/:name/answer 无从下键。watcher 检测到 AUQ 先调这里，
 * 再尝试 postAskUserQuestionMessage（成功时只回填 messageId）。
 */
let genSeq = 0;

export function registerAuqState(
  channelId: string,
  tmuxTarget: string,
  questions: AuqQuestion[],
  source: "jsonl" | "pane" = "jsonl",
  live: { agentName?: string; identity?: AuqDialogIdentity } = {},
): AuqState {
  const state: AuqState = {
    ...live,
    gen: `${Date.now().toString(36)}${(++genSeq).toString(36)}`,
    channelId,
    questions,
    selections: questions.map(() => []),
    messageId: "",
    tmuxTarget,
    ts: Date.now(),
    source,
  };
  auqStates.set(channelId, state);
  return state;
}

/**
 * 从 assistant content blocks 里查 AskUserQuestion tool_use。返回 questions
 * 数组，没有返回 null。watcher 拿到 questions 之后调 postAskUserQuestionMessage
 * 渲染 Discord 组件。
 */
export function detectAskUserQuestion(content: any[]): AuqQuestion[] | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    if (block.name !== "AskUserQuestion") continue;
    const input = block.input as { questions?: any[] };
    if (!input || !Array.isArray(input.questions) || input.questions.length === 0) continue;
    const cleaned: AuqQuestion[] = input.questions
      .filter((q: any) => q && typeof q.question === "string" && Array.isArray(q.options))
      .map((q: any) => ({
        question: String(q.question),
        header: String(q.header || "").slice(0, 12),
        options: (q.options as any[])
          .filter((o) => o && typeof o.label === "string")
          // 截到 100 字是卡片的显示上限；弹框身份比原文（keepAuqOptionText 另记，不进卡片 / 事件）
          .map((o) => keepAuqOptionText({
            label: String(o.label).slice(0, 100),
            description: o.description ? String(o.description).slice(0, 100) : undefined,
            preview: o.preview ? String(o.preview).slice(0, 200) : undefined,
          }, { label: String(o.label), description: o.description ? String(o.description) : undefined })),
        multiSelect: !!q.multiSelect,
      }))
      .filter((q) => q.options.length >= 2);
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}

/**
 * 把 AskUserQuestion 渲染成 Discord 消息 + components。
 * 1-4 个 question 每个一个 select menu（multiSelect 时 max_values=options.length）。
 * 最后一行是 Submit / Cancel 按钮。
 *
 * 返回新建的 message id 给调用方存进 auqStates；失败返回 null。
 */
export async function postAskUserQuestionMessage(
  discord: Client,
  channelId: string,
  _tmuxTarget: string,
  questions: AuqQuestion[],
  gen: string = auqStates.get(channelId)?.gen ?? "",
): Promise<string | null> {
  try {
    const ch = await discord.channels.fetch(channelId);
    if (!ch || !("send" in ch)) return null;
    const textCh = ch as TextChannel;

    const headerLines = [
      `🎛 **agent 在等你选**`, // Claude Code 的 AskUserQuestion、Pi / Codex 的选择框都走这张卡
      ``,
      ...questions.map((q, i) => {
        const tag = q.multiSelect ? "（可多选）" : "（单选）";
        const opts = q.options.map((o, oi) => {
          const desc = o.description ? ` —— ${o.description}` : "";
          return `  ${oi + 1}. ${o.label}${desc}`;
        }).join("\n");
        return `**Q${i + 1}. ${q.header || q.question}${tag}**\n${q.question}\n${opts}`;
      }),
      ``,
      `下面每个 Q 用对应的 select menu 选；选完点 ✅ Submit。`,
    ];
    const body = headerLines.join("\n").slice(0, 1900);

    const rows: any[] = [];
    // 每个 question 一个 select menu — Discord 最多 5 rows，questions 上限 4，留 1 row 给按钮
    for (let i = 0; i < questions.length && rows.length < 4; i++) {
      const q = questions[i];
      const componentSelect = {
        type: 3, // STRING_SELECT
        custom_id: `auq:${channelId}:${gen}:q${i}`,
        placeholder: q.multiSelect
          ? `Q${i + 1} (可多选): ${q.header || q.question}`.slice(0, 150)
          : `Q${i + 1}: ${q.header || q.question}`.slice(0, 150),
        min_values: q.multiSelect ? 0 : 1,
        max_values: q.multiSelect ? q.options.length : 1,
        options: q.options.map((o, oi) => ({
          label: `${oi + 1}. ${o.label}`.slice(0, 100),
          value: String(oi),
          description: o.description?.slice(0, 100),
        })),
      };
      rows.push({ type: 1, components: [componentSelect] });
    }
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, label: "✅ Submit", custom_id: `auq:${channelId}:${gen}:submit` }, // SUCCESS
        { type: 2, style: 4, label: "❌ Cancel (Esc)", custom_id: `auq:${channelId}:${gen}:cancel` }, // DANGER
      ],
    });

    const msg = await textCh.send({ content: body, components: rows });

    // 只回填给发卡时的那一代：发送途中弹框已换 / 已清，这条消息上的按钮就是旧卡，当场收掉
    const state = auqStates.get(channelId);
    if (state && state.gen === gen) state.messageId = msg.id;
    else void retireAuqMessage(discord, channelId, msg.id);

    return msg.id;
  } catch (e) {
    console.error("AskUserQuestion Discord post 失败:", e);
    return null;
  }
}

/**
 * 给定 AuqState 的 selections，生成发给 tmux 的 keystroke 序列（CC 2.1.x 键位
 * 模型，见文件头）。可选传入 pane 解析结果做现场对账：
 *
 * - 单问题单选（无 tab 栏）：光标从 pane 实测位置（默认 0）走 Down/Up 到目标，
 *   Enter 一击即提交 —— 没有 Submit 段，绝不多发键。
 * - 单问题多选（tabbed，选项全可见）：按「目标勾选态 vs pane 实测勾选态」的
 *   差集发数字键 toggle，Right 到 Submit 段，Enter 提交。
 * - 多问题（tabbed）：假定弹窗未被人工拨动过（pane 只能看到当前 section，
 *   没法对账）。逐段：多选段数字 toggle + Right；单选段数字移光标 + Enter
 *  （选定并自动跳下一段）；最后在 Submit 段 Enter。
 */
export function buildAuqKeystrokes(state: AuqState, pane?: AuqPaneParse | null): string[] {
  const qs = state.questions;

  // ── 单问题单选：Down/Up 到目标 + Enter（Enter 即提交）──
  if (qs.length === 1 && !qs[0].multiSelect) {
    const target = state.selections[0]?.[0] ?? 0;
    let cursor = 0;
    if (pane && !pane.multiSelect && pane.options.length === qs[0].options.length) {
      const c = pane.options.findIndex((o) => o.cursor);
      if (c >= 0) cursor = c;
    }
    const diff = target - cursor;
    const keys: string[] = [];
    for (let d = 0; d < Math.abs(diff); d++) keys.push(diff > 0 ? "Down" : "Up");
    keys.push("Enter");
    return keys;
  }

  // ── 单问题多选：数字 toggle 差集 + Right + Enter ──
  if (qs.length === 1 && qs[0].multiSelect) {
    const want = new Set(state.selections[0] || []);
    const have = new Set<number>();
    if (pane && pane.multiSelect && pane.options.length === qs[0].options.length) {
      pane.options.forEach((o, i) => {
        if (o.checked) have.add(i);
      });
    }
    const keys: string[] = [];
    for (let i = 0; i < qs[0].options.length; i++) {
      if (want.has(i) !== have.has(i)) keys.push(String(i + 1));
    }
    keys.push("Right", "Enter");
    return keys;
  }

  // ── 多问题：假定全新弹窗（section 1 起步、全未选）──
  const keys: string[] = [];
  for (let qIdx = 0; qIdx < qs.length; qIdx++) {
    const sel = (state.selections[qIdx] || []).slice().sort((a, b) => a - b);
    if (qs[qIdx].multiSelect) {
      for (const optIdx of sel) keys.push(String(optIdx + 1));
      keys.push("Right");
    } else if (sel.length > 0) {
      keys.push(String(sel[0] + 1), "Enter"); // 数字移光标 + Enter 选定并跳下一段
    } else {
      keys.push("Right"); // 没选就跳过该段，让 TUI 自己校验
    }
  }
  keys.push("Enter"); // Submit(Review) 段光标默认在 "1. Submit answers"
  return keys;
}

/** 清掉一个 channel 的 AUQ 状态（提交完 / 取消 / stale）。 */
export function clearAuqState(channelId: string): boolean {
  return auqStates.delete(channelId);
}

// ── 弹框换代、作答（hardening-AUQID1）────────────────────────────────
// 身份与逐键重核在 lib/auq-dialog-identity.ts；这里接上 tmux、registry、事件与 Discord。

const auqIo = (agentName: string): AuqIo => ({
  query: (args) => tmuxRawStrict(args),
  session: async () => (await readRegistryAgents()).find((a) => a.name === agentName)?.sessionId ?? "",
  locked: (target, gate, send) => tmuxSendEscape.locked(target, gate, send),
  sleep: (ms) => Bun.sleep(ms),
});

/** 把键序列发给这一代的弹框：每一键之前重核同一代，对不上就停（sendAuqKeysChecked） */
export function sendAuqKeys(state: AuqState, keys: string[]): Promise<AuqSendResult> {
  if (!state.identity) return Promise.resolve({ sent: 0, stopped: "dialog identity unknown" });
  return sendAuqKeysChecked(auqIo(state.agentName ?? ""), state.identity, keys, () => auqStates.get(state.channelId) === state);
}

/** 旧卡那条 Discord 消息收掉按钮（尽力而为：收不掉时按钮的代号也已对不上） */
async function retireAuqMessage(discord: Client, channelId: string, messageId: string): Promise<void> {
  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    await (await ch.messages.fetch(messageId)).edit({ content: "🎛 这个选择框已经换掉 / 关闭，这张卡作废。", components: [] });
  } catch (e) {
    console.error(`AUQ 旧卡收按钮失败（${channelId}，按钮代号已失效）:`, e);
  }
}

/** 这一代作废：清状态、收卡（question_cleared 让「待你处理」里的旧 ask 结案，它的 askId 之后答不动新弹框） */
function retireAuq(state: AuqState, via: string, discord?: Client): void {
  if (auqStates.get(state.channelId) !== state) return;
  auqStates.delete(state.channelId);
  emitEvent({ agent: state.agentName ?? "master", chatId: state.channelId, type: "question_cleared", data: { reason: "stale", via } });
  if (discord && state.messageId) void retireAuqMessage(discord, state.channelId, state.messageId);
}

export interface AuqSighting {
  agentName: string;
  channelId: string;
  discord: Client;
  via: "pane" | "jsonl";
  /** JSONL 里读到的问题：只有和屏上的弹框对得上才用它开卡 */
  questions?: AuqQuestion[];
  /** 观察器是否仍归调用方（jsonl-watcher 的 retired）：等待期间被停就什么都不做 */
  alive?: () => boolean;
}
/** multi = 屏上是多问表单、凑不出完整卡（pane 观察器降级通知） */
export type AuqSeen = "unreadable" | "absent" | "kept" | "registered" | "multi";

/**
 * JSONL 与 pane 观察共用：读一次现场。登记着的那一代还在屏上就保留；现场换了（会话 / pane / 窗口）或屏上是另一个弹框，
 * 旧卡立即作废，凑得出完整问题就注册新一代并发新的 question。
 */
export async function noteAuqDialog(s: AuqSighting): Promise<{ seen: AuqSeen; obs: AuqObservation }> {
  const tmuxTarget = windowTarget(s.agentName);
  const obs = await observeAuqByName(auqIo(s.agentName), tmuxTarget);
  if (obs.kind === "unreadable" || (s.alive && !s.alive())) return { seen: "unreadable", obs };
  const cur = auqStates.get(s.channelId);
  if (cur?.busy || (cur?.identity && sameAuqDialog(cur.identity, obs, "midway"))) return { seen: "kept", obs };
  if (cur && (obs.kind !== "none" || !cur.identity || !sameAuqTarget(cur.identity.target, obs.target))) retireAuq(cur, s.via, s.discord);
  if (obs.kind !== "dialog") return { seen: "absent", obs };
  const fromJsonl = s.questions && auqQuestionsOnScreen(s.questions, obs) ? s.questions : null;
  const questions = fromJsonl ?? ((obs.tabs?.length ?? 1) > 1 ? null : [auqQuestionFromScreen(obs.parse)]);
  if (!questions) return { seen: "multi", obs };
  const state = registerAuqState(s.channelId, tmuxTarget, questions, s.via, { agentName: s.agentName, identity: auqDialogIdentity(questions, obs) });
  if (!isLocalChannel(s.channelId)) {
    postAskUserQuestionMessage(s.discord, s.channelId, tmuxTarget, questions, state.gen).catch((e) => console.error("AUQ Discord post 失败:", e));
  }
  console.log(`🎛 ${s.via} 检测到 AskUserQuestion (${questions.length} 问, ${obs.parse.form}${obs.parse.multiSelect ? ", 多选" : ""}) for ${s.agentName}`);
  recordMetric("auq_detect", { channelId: s.channelId, meta: { source: s.via, form: obs.parse.form } });
  emitEvent({ agent: s.agentName, chatId: s.channelId, type: "question", data: { questions, gen: state.gen } });
  return { seen: "registered", obs };
}

/** channelId → 连续未见弹窗的 tick 数（AuqState 在而弹窗消失 = 人工作答，2 次清卡） */
const auqPaneMiss = new Map<string, number>();
/** channelId → 已发过降级通知的多问弹窗 key（问题文本），防每 tick 刷屏 */
const auqMultiNotified = new Map<string, string>();

/** 多问表单 pane 只见当前段，完整卡片凑不出来 → 降级通知（每弹窗一次），引导开远程终端作答 */
async function notifyMultiAuq(agentName: string, channelId: string, parse: AuqPaneParse, allowedUserIds: string[], discord: Client): Promise<void> {
  if (auqMultiNotified.get(channelId) === parse.question) return;
  auqMultiNotified.set(channelId, parse.question);
  const text = `🎛 agent 弹了一个多问选择框(${parse.sections.join(" / ")}),交互卡暂不支持多问表单 —— 请开远程终端(🖥️)或 tmux 作答`;
  emitEvent({ agent: agentName, chatId: channelId, type: "assistant_text", data: { text } });
  console.log(`🎛 pane 检测到多问 AUQ (${parse.sections.length} 问) for ${agentName} → 降级通知`);
  recordMetric("auq_detect", { channelId, meta: { source: "pane", form: "multi-question" } });
  if (channelId.startsWith("local-")) return;
  try {
    const pngPath = await tmuxScreenshot(agentName);
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    await ch.send({
      content: [`🎛 **${agentName}** 弹了一个多问选择框(${parse.sections.join(" / ")}),请在终端作答`, mention].filter(Boolean).join("\n"),
      files: pngPath ? [{ attachment: pngPath }] : undefined,
    });
  } catch { /* Discord 面失败不影响 web 通知 */ }
}

/**
 * permission-watcher 每轮每个 agent 调一次（pane = 它按名字抓到的那一屏，只用来决定要不要细看）。返回 true = 弹窗在场，
 * 本轮其余弹窗检测不用再跑。弹窗在而卡不在 → 开卡；换了弹框 → 立即换代；登记着而连续 2 轮（~16s）没见到 → 人工在终端答掉了，清卡。
 */
export async function watchAuqPane(agentName: string, channelId: string, pane: string, allowedUserIds: string[], discord: Client): Promise<boolean> {
  const hinted = parseAuqPane(pane) !== null;
  if (!hinted && !auqStates.has(channelId)) {
    auqPaneMiss.delete(channelId);
    auqMultiNotified.delete(channelId);
    return false;
  }
  const { seen, obs } = await noteAuqDialog({ agentName, channelId, discord, via: "pane" });
  if (seen === "kept" || seen === "registered" || seen === "multi") {
    auqPaneMiss.delete(channelId);
    if (seen === "multi" && obs.kind === "dialog") await notifyMultiAuq(agentName, channelId, obs.parse, allowedUserIds, discord);
    return true;
  }
  if (seen === "unreadable" && hinted) return true; // 按名字那一屏有弹框、细看没读到：这一轮不算消失，也不往下跑别的弹窗检测
  if (seen === "absent") auqMultiNotified.delete(channelId);
  const miss = auqStates.has(channelId) ? (auqPaneMiss.get(channelId) || 0) + 1 : 0;
  if (miss === 1) auqPaneMiss.set(channelId, miss);
  else auqPaneMiss.delete(channelId);
  if (miss < 2) return false;
  clearAuqState(channelId);
  console.log(`🎛 AUQ 弹窗已在 TUI 侧消失(人工作答/取消)→ 清卡 agent=${agentName}`);
  emitEvent({ agent: agentName, chatId: channelId, type: "question_cleared", data: { reason: "stale", via: "pane" } });
  return false;
}

export interface AuqAnswerRequest {
  action: "submit" | "cancel";
  via: "api" | "discord";
  /** 卡片带来的代号：Discord 按钮必带（旧格式的按钮 = ""）；网页带了就核 */
  gen?: string;
  askId?: unknown;
  /** 被点的那条 Discord 消息 */
  messageId?: string;
  /** 网页一次提交的全部选择；核过卡和现场之后才写进状态 */
  selections?: unknown;
  who: { principal: string; device?: string };
  uid?: string;
}

export type AuqAnswerResult =
  | { status: "none" }
  /** 零键或中途停下：sent = 停下前确认发出的键数 */
  | { status: "stale"; reason: string; sent: number }
  | { status: "failed"; error: string }
  | { status: "cancelled" }
  | { status: "submitted"; keys: number; state: AuqState };

const stale = (reason: string, sent = 0): AuqAnswerResult => ({ status: "stale", reason, sent });

/** 这次作答是不是冲着登记着的这一代来的：代号、Discord 消息、「待你处理」的 askId 有一样对不上就是旧卡 */
function cardMismatch(state: AuqState, r: AuqAnswerRequest): boolean {
  if (r.via === "discord" ? r.gen !== state.gen : r.gen !== undefined && r.gen !== state.gen) return true;
  if (r.messageId && state.messageId && r.messageId !== state.messageId) return true;
  return staleAuqCard(r.askId, state.channelId, state.questions);
}

class AuqChanged extends Error {}

/**
 * API 与 Discord 的提交 / 取消共用。先核卡是当前这一代的，再按名字读现场、比完整身份与会话 / pane；
 * 读不到、对不上、已换代 = stale、零键，旧卡的选择不写进任何状态。发键见 sendAuqKeys（逐键重核），取消的 Esc 在护栏的 gate 里重核。
 */
export async function answerAuq(channelId: string, r: AuqAnswerRequest): Promise<AuqAnswerResult> {
  const state = auqStates.get(channelId);
  if (!state) return { status: "none" };
  if (cardMismatch(state, r)) return stale("card is for an earlier dialog");
  if (state.busy) return stale("another answer is in flight");
  const id = state.identity;
  if (!id) return retireAuq(state, r.via), stale("dialog identity unknown");
  state.busy = true;
  try {
    const io = auqIo(state.agentName ?? "");
    const current = () => auqStates.get(channelId) === state;
    const obs = await observeAuqByName(io, state.tmuxTarget);
    if (!current()) return stale("dialog superseded");
    if (obs.kind === "unreadable") return stale(`pane unreadable: ${obs.why}`); // 读不到不等于弹框没了：状态留着，不发键
    if (!sameAuqDialog(id, obs, r.action === "cancel" ? "midway" : "fresh")) return retireAuq(state, r.via), stale("dialog changed");
    return r.action === "cancel" ? await cancelAuq(state, id, io, r, current) : await submitAuq(state, obs, r);
  } finally {
    state.busy = false;
  }
}

async function cancelAuq(state: AuqState, id: AuqDialogIdentity, io: AuqIo, r: AuqAnswerRequest, current: () => boolean): Promise<AuqAnswerResult> {
  const gate = async () => {
    const blocked = await keysBlockedAt(state.tmuxTarget, () => io.query(["capture-pane", "-t", id.target.pane, "-p", "-J", "-S", "-30"])); // 运行时按名字查，画面抓钉住的 pane
    if (blocked) throw blocked;
    if (!current() || !sameAuqDialog(id, await observeAuqPinned(io, id.target), "midway")) throw new AuqChanged("dialog changed");
  };
  const failed = await tmuxSendEscape(id.target.pane, { strict: true, gate }).then(() => null, (e: Error) => e);
  if (failed instanceof AuqChanged) return retireAuq(state, r.via), stale(failed.message);
  if (failed) return { status: "failed", error: `取消没生效：${failed.message}` }; // Esc 没发出去：问题还在，状态留着可以再取消
  if (current()) auqStates.delete(state.channelId);
  recordMetric("auq_cancel", { channelId: state.channelId, ...(r.via === "api" ? { meta: { trigger: "api" } } : {}) });
  emitEvent({ agent: state.agentName ?? "master", chatId: state.channelId, type: "question_cleared", data: { reason: "cancel", via: r.via, ...(r.uid ? { uid: r.uid } : {}) } });
  return { status: "cancelled" };
}

async function submitAuq(state: AuqState, obs: AuqObservation, r: AuqAnswerRequest): Promise<AuqAnswerResult> {
  if (Array.isArray(r.selections)) {
    const given = r.selections as unknown[];
    state.selections = state.questions.map((q, i) => {
      const sel = Array.isArray(given[i]) ? (given[i] as unknown[]) : [];
      return sel.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    });
  }
  const keys = buildAuqKeystrokes(state, obs.kind === "dialog" ? obs.parse : null);
  const res = await sendAuqKeys(state, keys);
  if (res.stopped !== null) return retireAuq(state, r.via), stale(res.stopped, res.sent);
  const current = auqStates.get(state.channelId) === state;
  if (current) auqStates.delete(state.channelId);
  recordMetric("auq_submit", { channelId: state.channelId, meta: { ...(r.via === "api" ? { trigger: "api" } : {}), questions: String(state.questions.length) } });
  // 「待你处理」的 AUQ ask 在广播之前记成是谁答的（ask-runtime.ts）：凭据 id 不进 question_cleared，那是发给所有订阅者的
  if (current) settleAuq(state.channelId, r.via === "api" ? "interact" : "discord", state, r.who);
  if (current) emitEvent({ agent: state.agentName ?? "master", chatId: state.channelId, type: "question_cleared", data: { reason: "submit", via: r.via, ...(r.uid ? { uid: r.uid } : {}) } });
  return { status: "submitted", keys: keys.length, state };
}

/** POST /agents/:name/answer {kind:"auq"} 的全部逻辑：api-routes 只把结果包成响应 */
export async function answerAuqApi(channelId: string, body: any, who: AuqAnswerRequest["who"]): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await answerAuq(channelId, {
    action: String(body?.action || "submit") === "cancel" ? "cancel" : "submit", via: "api", who,
    gen: body?.gen === undefined ? undefined : String(body.gen), askId: body?.askId, selections: body?.selections,
  });
  if (r.status === "none") return { status: 404, body: { ok: false, error: "no pending AskUserQuestion for this agent" } };
  if (r.status === "stale") return { status: 409, body: { ok: false, code: "ask_stale", error: `AskUserQuestion card is stale, nothing more was sent: ${r.reason}`, keys: r.sent } };
  if (r.status === "failed") return { status: 409, body: { ok: false, error: r.error } };
  return { status: 200, body: r.status === "cancelled" ? { ok: true, cancelled: true } : { ok: true, keys: r.keys } };
}

interface AuqInteraction {
  user: { id: string };
  message?: { id?: string } | null;
  editReply(reply: { content: string; components?: never[] }): Promise<unknown>;
}

/** 按钮 / 选单 id：auq:<channel>:<代号>:<submit|cancel|qN>；没有代号的旧格式 = 旧卡 */
function parseAuqId(id: string): { channelId: string; gen: string; action: string } {
  const parts = id.split(":");
  return { channelId: parts[1] ?? "", gen: parts.length >= 4 ? parts[2] : "", action: parts[parts.length - 1] ?? "" };
}

/** Discord 的 Submit / Cancel 按钮（discord-interactions 一行） */
export async function answerAuqDiscord(interaction: AuqInteraction, id: string): Promise<void> {
  const say = (content: string, keep = false) => interaction.editReply(keep ? { content } : { content, components: [] }).catch(() => { /* 回执发不出去不影响已做的事 */ });
  try {
    const { channelId, gen, action } = parseAuqId(id);
    if (action !== "submit" && action !== "cancel") return;
    const uid = interaction.user.id;
    const r = await answerAuq(channelId, { action, via: "discord", gen, messageId: interaction.message?.id, who: { principal: `discord:${uid}` }, uid });
    if (r.status === "none") return void (await say(`⚠️ AskUserQuestion 状态已过期，请等 agent 重新发起。`));
    const sentNote = r.status === "stale" && r.sent ? `已发出 ${r.sent} 键后停下` : "没有发键";
    if (r.status === "stale") return void (await say(`⚠️ 这张卡对应的弹窗已被应答 / 关闭或换成了另一个问题，本次操作作废（${sentNote}）。`));
    if (r.status === "failed") return void (await say(`❌ ${r.error}`, true)); // 状态留着可以再按
    if (r.status === "cancelled") return void (await say(`❌ 已取消 AskUserQuestion（发了 Esc 给 agent）`));
    const summary = r.state.selections.map((sel, i) => {
      const labels = sel.map((oi) => r.state.questions[i].options[oi]?.label || `?${oi}`).join(", ");
      return `Q${i + 1}: ${sel.length === 0 ? "(none)" : labels}`;
    }).join("\n");
    await say(`✅ 已提交 AskUserQuestion 选择：\n${summary}`);
  } catch (e) {
    console.error("AUQ button 处理异常:", e);
  }
}

/** Discord 的 select menu：只改它自己那一代的选择，旧卡的选单不动新状态 */
export function selectAuqDiscord(id: string, values: string[], messageId?: string): void {
  const { channelId, gen, action } = parseAuqId(id);
  const state = auqStates.get(channelId);
  const qIdx = parseInt(action.slice(1), 10);
  if (!state || state.gen !== gen || (messageId && state.messageId && messageId !== state.messageId)) return;
  if (!Number.isInteger(qIdx) || qIdx < 0 || qIdx >= state.questions.length) return;
  state.selections[qIdx] = values.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < state.questions[qIdx].options.length);
  console.log(`🎛 AUQ Q${qIdx + 1} 选了 ${state.selections[qIdx].length} 项 (channel=${channelId})`);
}
