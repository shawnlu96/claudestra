/**
 * AskUserQuestion 的作答在聊天里留痕（T11b 第 7 条）：工具卡摘要写成「答复：<问题> · <选项>」，分得清答的是哪一问。
 * 来源是 tool_result 那条 user 记录的 toolUseResult（{questions, answers: {问题: 选项}}，多选是一串「, 」连起来的，Other 是 owner 写的字）。
 * 历史（session-history 回填工具卡）和直播（jsonl-watcher 补一张已完成的卡）都走这里，刷新前后一样。
 * 权限弹框的作答在会话记录里没有来源，聊天里不留痕，只在「待你处理」卡片上显示已答。tests/asks-b.test.ts。
 */
import { t } from "./i18n.js";

const Q_MAX = 40;

interface AuqResult {
  questions?: unknown;
  answers?: unknown;
}

const resultOf = (rec: unknown): AuqResult | null => {
  const r = (rec as { toolUseResult?: AuqResult } | null)?.toolUseResult;
  return r && typeof r === "object" && Array.isArray(r.questions) && r.answers && typeof r.answers === "object" ? r : null;
};

/** 摘要一行；不是 AUQ 的结果、一问都没答（取消）→ null */
export function auqAnswerSummary(rec: unknown): string | null {
  const r = resultOf(rec);
  if (!r) return null;
  const parts = Object.entries(r.answers as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1].trim())
    .map(([q, a]) => `${q.length > Q_MAX ? `${q.slice(0, Q_MAX)}…` : q} · ${a.trim()}`);
  return parts.length ? `💬 ${t("答复", "Answer")}：${parts.join("；")}` : null;
}

/** 历史：tool_result 回填到对应工具卡——摘掉「还没结果」标记、失败标红；AUQ 的换成作答摘要 */
export function settleToolCard(tc: { name: string; summary: string; error?: boolean; open?: boolean } | undefined, b: { is_error?: unknown }, rec: unknown): void {
  if (!tc) return;
  delete tc.open;
  if (b.is_error === true) tc.error = true;
  const echo = tc.name === "AskUserQuestion" ? auqAnswerSummary(rec) : null;
  if (echo) tc.summary = echo;
}

/** 直播：AUQ 的 tool_use 不进工具管线（弹框另有交互卡），作答落盘时补一张已完成的卡（tool_start 带 done）；详情用 watcher 的格式化 */
export function auqEchoCard(rec: unknown, detailOf: (name: string, input: unknown) => string) {
  const summary = auqAnswerSummary(rec);
  const content = (rec as { message?: { content?: unknown } }).message?.content;
  const block = Array.isArray(content) ? content.find((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string") : null;
  if (!summary || !block) return null;
  const name = "AskUserQuestion";
  return { toolId: block.tool_use_id as string, name, summary, detail: detailOf(name, { questions: resultOf(rec)!.questions }), done: true };
}
