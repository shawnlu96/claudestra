/**
 * 侧栏 agent 行尾的台账阶段小标（docs 10-ledger §8 T8e）：GET /agents 行上的 ledgerTask {id, stage, round} → 人话标签与色调。
 * 阶段名跟 src/lib/ledger-stages.ts 的 STAGES；web 不能 import src，认不出的阶段原样显示、中性色，bridge 先加阶段也不会白屏。
 * 「开发」「验证」这类短词不进全局 i18n 字典（撞键就会改掉别处的译文），中英文都放在 STAGE_DEFS 里按语言取；整句模板在 lib/i18n-dict-ledger.ts。
 */
import type { LedgerReviewRef, LedgerTaskRef } from "@/lib/chat/agents";

/** 返工 / 卡住 = 红；等别人（复述确认、审查、合并、上线后待验证）= 黄；开发 = 主色；验证完 = 绿 */
export type StageTone = "error" | "warning" | "primary" | "success" | "neutral";
export type StageIcon = "spec" | "wait" | "build" | "fix" | "blocked" | "done" | "cancel" | "review";

/** 同 lib/i18n.tsx 的 Lang；那边带 JSX，根目录 tsc（跑 tests/）没开 jsx，不能 import */
type Lang = "zh" | "en";
type Words = Record<Lang, string>;
interface StageDef {
  /** 行上的短名 */
  short: Words;
  /** 悬停 / 长按菜单里整句的中段 */
  state: Words;
  tone: StageTone;
  icon: StageIcon;
}

const w = (zh: string, en: string): Words => ({ zh, en });
const STAGE_DEFS: Record<string, StageDef> = {
  spec: { short: w("规格", "Spec"), state: w("写规格中", "writing spec"), tone: "neutral", icon: "spec" },
  restate: { short: w("复述", "Restate"), state: w("等复述确认", "restate awaiting sign-off"), tone: "warning", icon: "wait" },
  build: { short: w("开发", "Build"), state: w("开发中", "building"), tone: "primary", icon: "build" },
  review: { short: w("审查", "Review"), state: w("审查中", "in review"), tone: "warning", icon: "wait" },
  fix: { short: w("返工", "Fix"), state: w("返工中", "fixing"), tone: "error", icon: "fix" },
  merge: { short: w("合并", "Merge"), state: w("等合并", "awaiting merge"), tone: "warning", icon: "wait" },
  live: { short: w("上线", "Live"), state: w("已上线，待验证", "live, awaiting verification"), tone: "warning", icon: "wait" },
  verified: { short: w("验证", "Verified"), state: w("已验证", "verified"), tone: "success", icon: "done" },
  blocked: { short: w("卡住", "Blocked"), state: w("卡住了", "blocked"), tone: "error", icon: "blocked" },
  // 下面两个是终态，bridge 本来不下发（activeTasksByAgent 滤掉了），留着防御
  done: { short: w("已完成", "Done"), state: w("已完成", "done"), tone: "success", icon: "done" },
  cancelled: { short: w("已取消", "Cancelled"), state: w("已取消", "cancelled"), tone: "neutral", icon: "cancel" },
};

/** round 只在进 review 时 +1（ledger-stages.ts nextTaskState），所以只有审查 / 返工带轮次才有意义 */
const ROUND_STAGES = new Set(["review", "fix"]);

export interface StageChipView {
  id: string;
  short: string;
  state: string;
  tone: StageTone;
  icon: StageIcon;
  /** 要显示的轮次（R2）；不带轮次的阶段或第 0 轮 = null */
  round: number | null;
}

/** 查表用 Object.hasOwn（同 src/lib/ledger-stages.ts）：stage 取到 "constructor" / "__proto__" 不能摸到原型上去 */
export function stageChipView(task: LedgerTaskRef, lang: Lang): StageChipView {
  const def = Object.hasOwn(STAGE_DEFS, task.stage) ? STAGE_DEFS[task.stage] : null;
  const round = ROUND_STAGES.has(task.stage) && Number.isInteger(task.round) && task.round >= 1 ? task.round : null;
  if (!def) return { id: task.id, short: task.stage, state: task.stage, tone: "neutral", icon: "spec", round };
  return { id: task.id, short: def.short[lang], state: def.state[lang], tone: def.tone, icon: def.icon, round };
}

type Translate = (s: string, params?: Record<string, string | number>) => string;

/** 悬停 / 长按 / 读屏的整句：「T5 · 返工中 · 第 1 轮」「T12b · 开发中」 */
export function stageSentence(v: StageChipView, t: Translate): string {
  return v.round === null ? `${v.id} · ${v.state}` : t("{id} · {state} · 第 {n} 轮", { id: v.id, state: v.state, n: v.round });
}

/** 行上显示的名字（显示名 + 会话名）里按词带着任务号，就不再重复显示任务号——窄侧栏省下的宽度留给名字 */
export function taskIdInName(names: (string | null | undefined)[], id: string): boolean {
  const want = id.toLowerCase();
  return names.some((n) => !!n && n.toLowerCase().split(/[^a-z0-9]+/).includes(want));
}


/**
 * 审查员行上的审查小标（GET /agents 的 ledgerReview）：在审 = 主色（它正在干活），通过 = 绿，要改 / 拦下 = 红；图标一律是眼睛，和执行者小标一眼分开。
 * 同一 agent 既执行又审查：执行者小标原样在前，审查小标跟在后面，两个都显示（agent-row.tsx）——各说各的卡，谁也不盖谁。
 */
const REVIEW_DEFS: Record<"reviewing" | NonNullable<LedgerReviewRef["verdict"]>, { short: Words; tone: StageTone }> = {
  reviewing: { short: w("在审", "Reviewing"), tone: "primary" },
  pass: { short: w("通过", "Passed"), tone: "success" },
  changes: { short: w("要改", "Changes"), tone: "error" },
  block: { short: w("拦下", "Blocked"), tone: "error" },
};

export interface ReviewChipView {
  id: string;
  short: string;
  tone: StageTone;
  icon: "review";
  /** 第 0 轮（派审早于进 review）不在行上显示 */
  round: number | null;
  /** 审完才有：不为 0 的 P 数，行上紧凑显示（「P1·1 P2·3」）；全 0 = 空串 */
  counts: string;
  /** 悬停 / 长按 / 读屏的整句 */
  sentence: string;
}

export function reviewChipView(r: LedgerReviewRef, lang: Lang, t: Translate): ReviewChipView {
  const def = REVIEW_DEFS[r.verdict ?? "reviewing"];
  const short = def.short[lang];
  const counts = r.verdict === null ? "" : (["p0", "p1", "p2"] as const).filter((k) => r[k] > 0).map((k) => `${k.toUpperCase()}·${r[k]}`).join(" ");
  const sentence = r.verdict === null
    ? t("在审 {id} · 第 {n} 轮", { id: r.id, n: r.round })
    : t("审完 {id} · 第 {n} 轮 · {verdict} · P0 {p0} / P1 {p1} / P2 {p2}", { id: r.id, n: r.round, verdict: short, p0: r.p0, p1: r.p1, p2: r.p2 });
  return { id: r.id, short, tone: def.tone, icon: "review", round: r.round >= 1 ? r.round : null, counts, sentence };
}
