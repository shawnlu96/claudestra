/**
 * 派单自带的标准答复：审查员 / 执行者反复拿去问 PM 的那几件事，答案固定成一段文字随单下发（审查单另带分级规则）。
 * 只此一份：本机审查单（review-order.ts）、出借池审查单（ledger-lend.ts）、调度派单（scheduler-work-order.ts）都并进 inputs；
 * 审查单上的 ask 由 order-ask.ts 当场回 REVIEW_ASK_REPLY，不转 PM。整段是一个 input 项：出借单的规格分段已占 inputs 项数，别拆成多项。
 * 远端（出借方）旧版只把拒绝原因截前 400 字给审查员看，REVIEW_ASK_REPLY 要短于这个数。tests/order-standard-answers.test.ts。
 */

/** 审查单带分级规则；写单 / 修复单不带 */
export type StandardAnswerFor = "review" | "author";

export const STANDARD_ANSWERS_HEAD = "标准答复（系统固定文字，这些不用再问 PM）：";

/** 和仓库无关（i28-SECPOOL3）：子模块已拉好、依赖照该仓库 CI 装；括号里是本仓（公共仓）的做法。整句不比旧文长：贴近线长上限的出借单预算按旧长度算 */
const ENVIRONMENT = "环境：副本已拉好子模块；依赖照仓库 CI 装，子模块同理（本仓 `bun install --frozen-lockfile`，web/ 同理）；本机 Bun 版本差异的崩溃不算问题；全量以 PR head 的 CI 为准";
const DUTIES = "职责：CI 由合并闸核对；ui 卡截图由 PM 验收；审查员只审代码";
const SPEC_FIRST = "规格里的「PM 定」「PM 补」小节都在规格原文里，以规格为准";
/** 写单 / 修复单才带。CIF8 加 OUT_OF_SCOPE_RED 时压短了字句：author 整段不比之前长（tests/lend-wire-v1-golden.test.ts 钉着字节数），三件事都还在 */
export const ASK_DEFAULT_GUIDANCE = "拿不准就用 ask，写清 default（默认做法）和 class=design/scope，照默认继续做；"
  + "只有需要人的事（凭据、owner 拍板、安全）才用 class=blocker 等回复。出借池远端 ask 暂按 blocker 等 PM；"
  + "例外是测试类扩围：只加 tests/ 下的文件时，ask 里填 files 和 "
  + "reason=superseded_assertion / new_test，PM 15 分钟没回自动批准、追加进 fileGlobs，结论会发给你，照做继续。";
/** 写单 / 修复单才带（dispatch-recovery-CIF8）：范围外的偶发红由合并闸重跑或退回，执行者推空提交只会多一轮修复和审查 */
const OUT_OF_SCOPE_RED = "范围外测试红：不推空提交，交付说明写明并附 run 链接，由合并闸处理";

export const GRADING_RULE = "分级：违反规格「验收线」某一条（写出编号）或本次 diff 引入的正确性 / 安全 bug → P1；其余（验收线以外、改动之前就有的、风格）→ P2。"
  + "拿不准就写进报告并说明理由，不提问";

export const UI_BASIS_RULE = "ui 卡：和对照基准不一致（版式、组件、字号、错位、重叠、拿 id 当标题）按 P1，basis 写对应验收线；规格没写基准的，报 P1 basis=acceptance 缺基准";

/** 审查单上的 ask 当场得到的答复（不开 PM ask、不发通知） */
export const REVIEW_ASK_REPLY = `${GRADING_RULE}。\n把你的判断和理由写进报告，交结论。`;

/**
 * scheduler.json localMerge 项目（lib/scheduler-config.ts localMergeOf）没有 PR CI：requiredChecks 是本项目要跑的命令（按空白切参数、不经 shell），
 * 执行者单、审查单、调度派单都用这几行，说法只此一份。非本地项目不传 checks，整段逐字不变。
 */
const checksText = (checks: readonly string[]) => checks.map((c) => `\`${c}\``).join("；");
export const localAuthorAcceptance = (checks: readonly string[]): string[] => [`交付前在本卡 worktree 逐条跑本项目的必过检查，全绿再交付：${checksText(checks)}`,
  "本机负载造成的等待型超时、且在 base（本机 main）上同样复现的，不算不过；在证据报告里列出"];
export const localReviewRule = (checks: readonly string[]): string => `全量测试按本项目的必过检查（${checksText(checks)}）在审查目录里跑；本机超时不判 P1`;
const localEnvironment = (checks: readonly string[]) => ENVIRONMENT.replace("全量以 PR head 的 CI 为准", `本项目没有 PR CI，全量以必过检查为准：${checksText(checks)}`);
const LOCAL_DUTIES = DUTIES.replace("CI 由合并闸核对", "必过检查由 PM 本机合并时再跑一遍");

/**
 * 并进派单 inputs 的那一项；uiBasis = ui 卡审查单的对照基准一节（ui-acceptance.ts uiReviewBasis），带上时多一条 UI_BASIS_RULE；
 * localChecks = localMerge 项目的必过检查（换掉环境 / 职责里的 PR CI 说法）
 */
export function standardAnswers(kind: StandardAnswerFor, uiBasis?: string, localChecks?: readonly string[]): string {
  const env = localChecks ? [localEnvironment(localChecks), LOCAL_DUTIES] : [ENVIRONMENT, DUTIES];
  const items = [...env, ...(kind === "review" ? [GRADING_RULE] : [ASK_DEFAULT_GUIDANCE, OUT_OF_SCOPE_RED]), ...(uiBasis ? [UI_BASIS_RULE] : []), SPEC_FIRST];
  return [STANDARD_ANSWERS_HEAD, ...items.map((s) => `- ${s}`), ...(uiBasis ? [uiBasis] : [])].join("\n");
}
