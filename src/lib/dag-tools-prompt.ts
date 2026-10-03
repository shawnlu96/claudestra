/**
 * start_node 给执行者的说明（自动卡口径）：写进 ledger/reviews/<卡号>-exec-prompt.md，执行者的 agent 目的里指向它。
 * 自动卡的生命周期归调度器：执行者按调度派单做，不给 PM 发进度 / 交付 / 收到——这一节总是附上，模板覆盖不掉；
 * 去掉它，执行者会照手动卡的习惯去找 PM，PM 和调度器两头推同一张卡。
 * 项目要换正文：放一份 ledger/prompts/exec-template.md（占位符同 DEFAULT_TEMPLATE），不改代码。tests/dag-tools-start.test.ts。
 * ui 卡另附截图交付一节（同样覆盖不掉）：缺截图时调度器在审查通过后把卡交回 PM，执行者得先知道要交什么。
 */
import type { WorkflowTemplate } from "./ledger-scheduler.js";
import { ASK_DEFAULT_GUIDANCE } from "./order-standard-answers.js";

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
  /** 流程模板；缺省 code。只有 ui 多一节，code / security 的说明逐字不变 */
  template?: WorkflowTemplate;
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
- 「开工 / 修复」单：做完 push，**开好 PR（base main，已开过的不用重开）**，再用 deliver 工具（或 \`ledger deliver {TASK} --from build|fix --head <完整 sha> --pr <完整 PR 链接>\`）交付，就结束这一轮。PR 链接由 deliver 自动登记，没开 PR 会被拒。调度器会自己派审、转修复、排合并。
- ${ASK_DEFAULT_GUIDANCE}
- 规格外文件交付时自动登记，审查员判断理由是否充分（不充分记 P2）；与其他在跑卡共改时冲突两边保留。
`;

const UI_SECTION = `
## ui 卡：合并前要过前后截图验收
- 审查通过后调度器把截图发给 PM 验收（改整体观感的卡由 owner 看）；PM 不通过时卡退回 fix，意见在修复单里。
- 交付前登记截图：\`extra.screenshots\` 至少 2 个图片的绝对路径（改前 / 改后；深浅色或桌面 / 手机按规格），\`extra.screenshotsDigest\` 写这组图片的 sha256（64 位十六进制）。
- 用 \`ledger task-set {TASK} --rev <rev> --extra '<json>'\` 写，它整份替换 extra，原有字段（fileGlobs、ownerVisual 等）要带上；截图用 headless 脚本拍，不用 Playwright MCP 工具。
- 缺截图或摘要，审查通过了也合不了，调度器会把卡交回 PM；代码再改过就重拍、重算摘要。
`;

export function renderExecPrompt(v: PromptVars, template: string = DEFAULT_TEMPLATE): string {
  const map: Record<string, string> = {
    "{TASK}": v.task, "{TITLE}": v.title, "{PM}": v.pm, "{BRANCH}": v.branch, "{BASE}": v.base, "{WORKTREE}": v.worktree, "{SPEC}": v.spec, "{LEDGER}": v.ledgerDir,
  };
  // 一次替换：值里恰好有 {TASK} 这类字样也不会被二次展开
  return (template.trimEnd() + "\n" + AUTO_SECTION + (v.template === "ui" ? UI_SECTION : "")).replace(/\{(TASK|TITLE|PM|BRANCH|BASE|WORKTREE|SPEC|LEDGER)\}/g, (m) => map[m] ?? m);
}
