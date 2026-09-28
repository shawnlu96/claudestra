/**
 * 侧栏 agent 行尾的台账阶段小标（docs 10-ledger §8 T8e）：GET /agents 行上的 ledgerTask {id, stage, round} → 人话标签与色调。
 * 阶段名跟 src/lib/ledger-stages.ts 的 STAGES；web 不能 import src，认不出的阶段原样显示、中性色，bridge 先加阶段也不会白屏。
 * 中文原文同时是 i18n key（lib/i18n-dict.ts），组件里再 t()。
 */
import type { LedgerTaskRef } from "@/lib/chat/agents";

/** 返工 / 卡住 = 红；等别人（复述确认、审查、合并、上线后待验证）= 黄；开发 = 主色；验证完 = 绿 */
export type StageTone = "error" | "warning" | "primary" | "success" | "neutral";
export type StageIcon = "spec" | "wait" | "build" | "fix" | "blocked" | "done" | "cancel";

interface StageDef {
  /** 行上的短名 */
  short: string;
  /** 悬停 / 长按菜单里整句的中段 */
  state: string;
  tone: StageTone;
  icon: StageIcon;
}

const STAGE_DEFS: Record<string, StageDef> = {
  spec: { short: "规格", state: "写规格中", tone: "neutral", icon: "spec" },
  restate: { short: "复述", state: "等复述确认", tone: "warning", icon: "wait" },
  build: { short: "开发", state: "开发中", tone: "primary", icon: "build" },
  review: { short: "审查", state: "审查中", tone: "warning", icon: "wait" },
  fix: { short: "返工", state: "返工中", tone: "error", icon: "fix" },
  merge: { short: "合并", state: "等合并", tone: "warning", icon: "wait" },
  live: { short: "上线", state: "已上线，待验证", tone: "warning", icon: "wait" },
  verified: { short: "验证", state: "已验证", tone: "success", icon: "done" },
  blocked: { short: "卡住", state: "卡住了", tone: "error", icon: "blocked" },
  // 下面两个是终态，bridge 本来不下发（activeTasksByAgent 滤掉了），留着防御
  done: { short: "已完成", state: "已完成", tone: "success", icon: "done" },
  cancelled: { short: "已取消", state: "已取消", tone: "neutral", icon: "cancel" },
};

/** round 只在进 review 时 +1（ledger-stages.ts nextTaskState），所以只有审查 / 返工带轮次才有意义 */
const ROUND_STAGES = new Set(["review", "fix"]);

export interface StageChipView extends StageDef {
  id: string;
  /** 要显示的轮次（R2）；不带轮次的阶段或第 0 轮 = null */
  round: number | null;
}

export function stageChipView(task: LedgerTaskRef): StageChipView {
  const def = STAGE_DEFS[task.stage] ?? { short: task.stage, state: task.stage, tone: "neutral", icon: "spec" };
  const round = ROUND_STAGES.has(task.stage) && task.round >= 1 ? task.round : null;
  return { ...def, id: task.id, round };
}

type Translate = (s: string, params?: Record<string, string | number>) => string;

/** 悬停 / 长按的整句：「T5 · 返工中 · 第 1 轮」「T12b · 开发中」 */
export function stageSentence(v: StageChipView, t: Translate): string {
  const state = t(v.state);
  return v.round === null ? t("{id} · {state}", { id: v.id, state }) : t("{id} · {state} · 第 {n} 轮", { id: v.id, state, n: v.round });
}

/** 名字里已经带任务号（task-t12b 挂 T12b）就不再重复显示任务号——窄侧栏省下的宽度留给名字 */
export function taskIdInName(name: string, id: string): boolean {
  const want = id.toLowerCase();
  return name.toLowerCase().split(/[^a-z0-9]+/).includes(want);
}
