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
 * TUI 键位（实测 + 提示文字 `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`）：
 *   - ↑↓ 在当前 question 的选项之间移动光标
 *   - Enter 切换当前选项的 [ ] / [✓]
 *   - ←→ 在不同 question section 之间切换（最后一个 section 是 "✔ Submit"）
 *   - Esc 取消
 *
 * 键序列构造（提交 N 个 question 的选择 → 最后 Enter 提交）：
 *   for each question Q:
 *     for each selected option index O (升序):
 *       Down × (O - cursor)，把光标移到 option O
 *       Enter，切换 [ ]
 *     Right，去下一个 section
 *   最后 cursor 落到 "Submit" → Enter
 */

import type { Client, TextChannel } from "discord.js";

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
): AuqState {
  const state: AuqState = {
    channelId,
    questions,
    selections: questions.map(() => []),
    messageId: "",
    tmuxTarget,
    ts: Date.now(),
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
          .map((o) => ({
            label: String(o.label).slice(0, 100),
            description: o.description ? String(o.description).slice(0, 100) : undefined,
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
 * 把 AskUserQuestion 渲染成 Discord 消息 + components。
 * 1-4 个 question 每个一个 select menu（multiSelect 时 max_values=options.length）。
 * 最后一行是 Submit / Cancel 按钮。
 *
 * 返回新建的 message id 给调用方存进 auqStates；失败返回 null。
 */
export async function postAskUserQuestionMessage(
  discord: Client,
  channelId: string,
  tmuxTarget: string,
  questions: AuqQuestion[],
): Promise<string | null> {
  try {
    const ch = await discord.channels.fetch(channelId);
    if (!ch || !("send" in ch)) return null;
    const textCh = ch as TextChannel;

    const headerLines = [
      `🎛 **agent 在等你选**（Claude Code AskUserQuestion）`,
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
        custom_id: `auq:${channelId}:q${i}`,
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
        { type: 2, style: 3, label: "✅ Submit", custom_id: `auq:${channelId}:submit` }, // SUCCESS
        { type: 2, style: 4, label: "❌ Cancel (Esc)", custom_id: `auq:${channelId}:cancel` }, // DANGER
      ],
    });

    const msg = await textCh.send({ content: body, components: rows });

    // 状态可能已由 registerAuqState 预注册（web-only 回路），只回填 messageId
    const existing = auqStates.get(channelId);
    if (existing) {
      existing.messageId = msg.id;
    } else {
      auqStates.set(channelId, {
        channelId,
        questions,
        selections: questions.map(() => []),
        messageId: msg.id,
        tmuxTarget,
        ts: Date.now(),
      });
    }

    return msg.id;
  } catch (e) {
    console.error("AskUserQuestion Discord post 失败:", e);
    return null;
  }
}

/**
 * 给定 AuqState 的 selections，生成发给 tmux 的 keystroke 序列。
 *
 *   for each question Q (i 0..N-1):
 *     for each selected option index O (sorted asc):
 *       Down × (O - cursor)
 *       Enter (toggle)
 *     Right (next section)  —— 最后一次 Right 落到 "Submit"
 *   Enter (在 Submit 上按下提交)
 *
 * 实测注意：每次 Right 切换到下一个 section 时，新 section 的光标重置到 option 0
 *（这是常见 TUI 行为；如果实际不是，需要调整算法）。
 */
export function buildAuqKeystrokes(state: AuqState): string[] {
  const keys: string[] = [];
  for (let qIdx = 0; qIdx < state.questions.length; qIdx++) {
    const sel = (state.selections[qIdx] || []).slice().sort((a, b) => a - b);
    let cursor = 0;
    for (const optIdx of sel) {
      const diff = optIdx - cursor;
      for (let d = 0; d < diff; d++) keys.push("Down");
      keys.push("Enter");
      cursor = optIdx;
    }
    // 切到下一个 section（或 Submit）
    keys.push("Right");
  }
  // 最后一个 Right 已经把光标落到 Submit，再按 Enter 提交
  keys.push("Enter");
  return keys;
}

/** 清掉一个 channel 的 AUQ 状态（提交完 / 取消 / stale）。 */
export function clearAuqState(channelId: string): boolean {
  return auqStates.delete(channelId);
}
