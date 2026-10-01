/**
 * 派单自带的标准答复：审查员 / 执行者反复拿去问 PM 的那几件事，答案固定成一段文字随单下发（审查单另带分级规则）。
 * 只此一份：本机审查单（review-order.ts）、出借池审查单（ledger-lend.ts）、调度派单（scheduler-work-order.ts）都并进 inputs；
 * 审查单上的 ask 由 order-ask.ts 当场回 REVIEW_ASK_REPLY，不转 PM。整段是一个 input 项：出借单的规格分段已占 inputs 项数，别拆成多项。
 * 远端（出借方）旧版只把拒绝原因截前 400 字给审查员看，REVIEW_ASK_REPLY 要短于这个数。tests/order-standard-answers.test.ts。
 */

/** 审查单带分级规则；写单 / 修复单不带 */
export type StandardAnswerFor = "review" | "author";

export const STANDARD_ANSWERS_HEAD = "标准答复（系统固定文字，这些不用再问 PM）：";

const ENVIRONMENT = "环境：独立 clone 里自己 `bun install --frozen-lockfile` 装依赖（web/ 目录同理）；本机 Bun 版本与 CI 不同导致的崩溃不算问题；全量测试以 PR head 上的 CI 三项为准";
const DUTIES = "职责：CI 由合并闸核对；ui 卡截图由 PM 验收；审查员只审代码";
const SPEC_FIRST = "规格里的「PM 定」「PM 补」小节都在规格原文里，以规格为准";

export const GRADING_RULE = "分级：违反规格「验收线」某一条（写出编号）或本次 diff 引入的正确性 / 安全 bug → P1；其余（验收线以外、改动之前就有的、风格）→ P2。"
  + "拿不准就写进报告并说明理由，不提问";

/** 审查单上的 ask 当场得到的答复（不开 PM ask、不发通知） */
export const REVIEW_ASK_REPLY = `${GRADING_RULE}。\n把你的判断和理由写进报告，交结论。`;

/** 并进派单 inputs 的那一项 */
export function standardAnswers(kind: StandardAnswerFor): string {
  const items = [ENVIRONMENT, DUTIES, ...(kind === "review" ? [GRADING_RULE] : []), SPEC_FIRST];
  return [STANDARD_ANSWERS_HEAD, ...items.map((s) => `- ${s}`)].join("\n");
}
