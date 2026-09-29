/**
 * v2.0.19+ AskUserQuestion (Claude Code 内建工具) Discord 化适配。
 * 现状：远程作答（Discord / 网页替 owner 按键）停用，只发通知、请到终端作答（auq-answer.ts 文件头）；下面第 2-4 步与键位模型留给重新开启时用。
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
import type { AuqPaneParse } from "../lib/auq-pane.js";
import { isLocalChannel } from "../lib/pending-ops.js";
import { windowTarget } from "../lib/tmux-helper.js";
import { emitEvent } from "./event-bus.js";

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
  /** Discord 那条带 select menu 的消息 id：只认按这一版画的那条（auq-answer.ts 按它判旧消息） */
  messageId: string;
  /** 代际：jsonl 检测到的是那次 tool_use 的 id，pane 检测每登记一次生成一个新的。提交方看到的不是这一代 = 409 */
  dialogId: string;
  /** agent 的 tmux 目标（e.g. "master:agent-foo"），按键发这里 */
  tmuxTarget: string;
  ts: number;
  /** 检测来源：jsonl（旧版 CC 即时落盘）或 pane（v2.17.2+ 及时通路） */
  source?: "jsonl" | "pane";
}

export const auqStates = new Map<string, AuqState>();

/**
 * 注册 AUQ 状态，与 Discord 渲染解耦。
 *
 * Web-only 模式（或 Discord post 失败）下也必须有 AuqState，否则
 * POST /api/v1/agents/:name/answer 无从下键。watcher 检测到 AUQ 先调这里，
 * 再尝试 postAskUserQuestionMessage（成功时只回填 messageId）。
 */
export function registerAuqState(
  channelId: string,
  tmuxTarget: string,
  questions: AuqQuestion[],
  source: "jsonl" | "pane" = "jsonl",
  dialogId = `pane-${crypto.randomUUID()}`,
): AuqState {
  const state: AuqState = {
    channelId,
    questions,
    selections: questions.map(() => []),
    messageId: "",
    dialogId,
    tmuxTarget,
    ts: Date.now(),
    source,
  };
  auqStates.set(channelId, state);
  return state;
}

/** 那次 AskUserQuestion tool_use 的 id：jsonl 通路拿它当代际（AuqState.dialogId） */
export function auqToolUseId(content: any[]): string | undefined {
  const b = Array.isArray(content) ? content.find((x) => x?.type === "tool_use" && x.name === "AskUserQuestion") : undefined;
  return typeof b?.id === "string" && b.id ? b.id : undefined;
}

/**
 * 从 assistant content blocks 里查 AskUserQuestion tool_use。返回 questions
 * 数组，没有返回 null。watcher 拿到 questions 之后调 announceAuq。
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
          .map((o) => ({
            label: String(o.label), // 不截：画面上是全文，截了就和画面对不上（auq-answer.ts）；Discord 渲染时再截
            description: o.description ? String(o.description) : undefined,
            preview: o.preview ? String(o.preview).slice(0, 200) : undefined,
          })),
        multiSelect: !!q.multiSelect,
      }))
      .filter((q) => q.options.length >= 2);
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}

/**
 * 检测到一个 AUQ（jsonl / pane 两条通路共用）：登记一个新代际的状态 → 有 Discord 面就为这一版发一条新消息 → 广播 question。
 * 新一版一定发新消息、换新的 messageId，绝不原地改旧消息去画新一版（旧消息上的选择 / 提交靠 messageId 判旧，tests/auq-answer.test.ts）
 */
export function announceAuq(discord: Client, a: { channelId: string; agentName: string; questions: AuqQuestion[]; source: "jsonl" | "pane"; dialogId?: string }): AuqState {
  const state = registerAuqState(a.channelId, windowTarget(a.agentName), a.questions, a.source, a.dialogId);
  if (!isLocalChannel(a.channelId)) postAskUserQuestionMessage(discord, state).catch((e) => console.error(`AUQ Discord post 失败（${a.source}）:`, e));
  emitEvent({ agent: a.agentName, chatId: a.channelId, type: "question", data: { questions: a.questions, dialogId: state.dialogId } });
  return state;
}

/**
 * 把这一版 AskUserQuestion 渲染成一条新的 Discord 通知：列出问题和选项，请到终端作答——远程作答停用（auq-answer.ts），不带选单和按钮。
 * 发完只把 messageId 记在这一版的状态上：发的途中换了一版，这条就不绑任何状态
 */
export async function postAskUserQuestionMessage(discord: Client, state: AuqState): Promise<string | null> {
  const { channelId, questions } = state;
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
      `请到终端作答。`,
    ];
    const body = headerLines.join("\n").slice(0, 1900);

    const msg = await textCh.send({ content: body });
    state.messageId = msg.id;
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
