/**
 * 侧栏会话行芯片的「一句话解释」（UXSIDE1）：上下文余量、台账阶段、工作中、压缩中各一句人话。
 * 桌面芯片的 title / aria-label 和手机的图例卡（components/chip-legend.tsx）都读这张表，解释文字只在这里写一份。
 * 不用「压缩线」「硬上限」这类术语；纯数据 + 纯函数，不 import React（根目录 tsc 跑 tests/ 时没开 jsx）。单测 tests/web-chip-words.test.ts。
 */
import { boundaryLabel, type CtxBoundaryInfo } from "./ctx-boundary-view";
import type { LedgerTaskRef } from "@/lib/chat/agents";

/** 同 lib/i18n.tsx 的 Lang（那边带 JSX，这里不能 import） */
type Lang = "zh" | "en";
type Words = Record<Lang, string>;
const w = (zh: string, en: string): Words => ({ zh, en });

const k = (n: number) => `${Math.round(Math.abs(n) / 1000)}k`;
const POLICY_EN: Record<string, string> = { 执行类: "Executor", 协调类: "Coordinator", 全局: "Global" };

/** 「协调类 · 余 77k」→「协调类会话：上下文还能用约 77k，快到时会提醒压缩」；超出 / 软线关着各一句 */
export function ctxChipWords(b: CtxBoundaryInfo, lang: Lang): string {
  const label = boundaryLabel(b.policy);
  const name = lang === "zh" ? `${label}会话` : `${POLICY_EN[label] ?? label} session`;
  const sep = lang === "zh" ? "：" : ": ";
  const body =
    b.remaining === null
      ? b.hardCap === null
        ? w("上下文没有设上限", "no context limit is set")
        : w(`上下文最多用到约 ${k(b.hardCap)}`, `context can grow to about ${k(b.hardCap)}`)
      : b.remaining >= 0
        ? w(`上下文还能用约 ${k(b.remaining)}，快到时会提醒压缩`, `about ${k(b.remaining)} of context left; it will be reminded to compact near the end`)
        : w(`上下文已多用了约 ${k(b.remaining)}，该压缩了`, `context is about ${k(b.remaining)} past its budget; time to compact`);
  const warn = b.warnings?.length ? (lang === "zh" ? `（配置有问题：${b.warnings.join("；")}）` : ` (config problem: ${b.warnings.join("; ")})`) : "";
  return `${name}${sep}${body[lang]}${warn}`;
}

/** 阶段 → 一句话（键同 src/lib/ledger-stages.ts 的 STAGES；认不出的阶段在 stageWords 里兜底） */
const STAGE_WORDS: Record<string, Words> = {
  spec: w("它的卡还在写规格", "its card's spec is still being written"),
  restate: w("它复述了需求，等 PM 确认", "it restated the requirements and waits for PM sign-off"),
  build: w("它在开发这张卡", "it is building this card"),
  review: w("它的卡在审查，等审查结论", "its card is in review, waiting for the verdict"),
  fix: w("审查提了意见，它在返工", "review asked for changes; it is fixing them"),
  merge: w("它的卡审完了，等合并", "its card passed review and waits to be merged"),
  live: w("它的卡已上线，等 PM 验证", "its card is live and waits for PM verification"),
  verified: w("它的卡已上线，PM 已验证", "its card is live and verified by the PM"),
  blocked: w("它的卡卡住了，要有人处理", "its card is blocked and needs someone to step in"),
  done: w("它的卡已完成", "its card is done"),
  cancelled: w("它的卡已取消", "its card was cancelled"),
};

/** 只说阶段的那半句（图例卡逐行用）；Object.hasOwn：stage 取到 "constructor" 也不摸原型 */
export function stageWords(stage: string, lang: Lang): string {
  if (Object.hasOwn(STAGE_WORDS, stage)) return STAGE_WORDS[stage][lang];
  return lang === "zh" ? `它的卡在「${stage}」阶段` : `its card is at stage "${stage}"`;
}

/** 行上阶段芯片的整句：「T5：审查提了意见，它在返工（第 2 轮）」；轮次只对审查 / 返工有意义（同 ledger-stage.ts） */
export function stageChipWords(task: LedgerTaskRef, lang: Lang): string {
  const round = (task.stage === "review" || task.stage === "fix") && Number.isInteger(task.round) && task.round >= 1 ? task.round : null;
  const tail = round === null ? "" : lang === "zh" ? `（第 ${round} 轮）` : ` (round ${round})`;
  return `${task.id}${lang === "zh" ? "：" : ": "}${stageWords(task.stage, lang)}${tail}`;
}

export type RowState = "busy" | "compacting";
const STATE_WORDS: Record<RowState, Words> = {
  busy: w("它正在跑一轮", "it is running a turn"),
  compacting: w("正在压缩上下文，稍后恢复", "compacting its context; back shortly"),
};

/** 「工作中」「压缩中」的一句话 */
export function rowStateWords(s: RowState, lang: Lang): string {
  return STATE_WORDS[s][lang];
}

/** 行尾时间的短写（行窄时代替「12分钟前」「3小时12分前」）：只留最大一个单位，给名字让出约 8 个字（agent-row.tsx） */
export function agoShort(ts: number | null | undefined, lang: Lang, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const [n, zh, en] = s < 60 ? [s, "秒", "s"] : m < 60 ? [m, "分", "m"] : h < 24 ? [h, "小时", "h"] : [d, "天", "d"];
  return `${n}${lang === "en" ? en : zh}`;
}
