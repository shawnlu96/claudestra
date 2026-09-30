/**
 * start_node 给执行者的说明（自动卡口径）：写进 ledger/reviews/<卡号>-exec-prompt.md，执行者的 agent 目的里指向它。
 * 自动卡的生命周期归调度器：执行者按调度派单做，不给 PM 发进度 / 交付 / 收到——这一节总是附上，模板覆盖不掉；
 * 去掉它，执行者会照手动卡的习惯去找 PM，PM 和调度器两头推同一张卡。
 * 项目要换正文：放一份 ledger/prompts/exec-template.md（占位符同 DEFAULT_TEMPLATE），不改代码。tests/dag-tools-start.test.ts。
 */

export interface PromptVars {
  task: string;
  title: string;
  pm: string;
  branch: string;
  base: string;
  worktree: string;
  /** 规格卡的绝对路径 */
  spec: string;
  /** 台账目录（reviews/ 在它下面） */
  ledgerDir: string;
}

const DEFAULT_TEMPLATE = `你是 {TASK}「{TITLE}」的执行者。PM 是 {PM}。审查由调度器另派一个跨模型的审查会话做，你不用自己找审查员。

## 先读
1. 规格卡 {SPEC}（只读）。
2. 仓库根目录的 CLAUDE.md / AGENTS.md 里的规矩（worktree 里同一份）。

## 做法
- 你的 worktree 就是当前目录 {WORKTREE}，分支 {BRANCH}（base {BASE}）。小步 commit。
- 按仓库规矩自检全绿再交付；能在沙箱实测的实测。
- 不合并、不部署、不打 tag、不发 release；push 分支和开 PR 可以。只在当前 worktree 改文件，不碰主树。
- 代码里不放 secrets、IP、个人信息。
`;

const AUTO_SECTION = `
## 本卡是自动卡：生命周期归调度器，不找 PM
- 派单全部来自调度服务（take_order 取单）。**不要给 {PM} 发任何进度、交付或「收到」消息**，PM 不在这条链上。
- 「复述」单：把复述（≤ 40 行）写进 {LEDGER}/reviews/{TASK}-restate.md，再把阶段推到 restate（\`ledger stage {TASK} --from spec --to restate --text "复述见 reviews/{TASK}-restate.md"\`），然后停下等开工单。
- 「开工 / 修复」单：做完 push，用 deliver 工具（或 \`ledger deliver {TASK} --from build|fix --head <完整 sha>\`）交付，就结束这一轮。调度器会自己派审、转修复、排合并。
- 只有这三种情况才找 PM：要改的文件超出卡上的文件范围；规格有歧义、必须有人拍板；环境坏了、自己修不了。找的时候一条消息说清楚，首行写「[需 PM 定 {TASK}]」。
`;

export function renderExecPrompt(v: PromptVars, template: string = DEFAULT_TEMPLATE): string {
  const map: Record<string, string> = {
    "{TASK}": v.task, "{TITLE}": v.title, "{PM}": v.pm, "{BRANCH}": v.branch, "{BASE}": v.base, "{WORKTREE}": v.worktree, "{SPEC}": v.spec, "{LEDGER}": v.ledgerDir,
  };
  // 一次替换：值里恰好有 {TASK} 这类字样也不会被二次展开
  return (template.trimEnd() + "\n" + AUTO_SECTION).replace(/\{(TASK|TITLE|PM|BRANCH|BASE|WORKTREE|SPEC|LEDGER)\}/g, (m) => map[m] ?? m);
}
