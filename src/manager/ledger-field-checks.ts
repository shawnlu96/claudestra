/**
 * 台账写命令在 CLI 层的输入校验（docs 10-ledger「附：编排班子」）：
 *   任务的 --branch / --pr / --head 写进库之前就校验格式——它们会进 show、网页、bridge 通知和审查员 prompt，
 *   读取方各自清洗挡不住所有下游；`review --to merge` 在规格卡还欠对抗式时拒绝（与路由、currentHandler 同一个判定）。
 * tests/manager-ledger.test.ts（字段）、tests/manager-ledger-dispatch.test.ts（--to merge）。
 */
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getMeta, LedgerError, listEvents } from "../lib/ledger-store.js";
import { owesAdversarial, type PendingReview } from "../lib/ledger-handler.js";
import { specPathFor, specPolicyOf } from "../lib/task-spec.js";
import type { LedgerCli } from "./ledger-context.js";

/** 数字、#N，或 github.com/<owner>/<repo>/pull/N（不限定哪个仓库，兄弟仓库也用；归属由 verify 判）。owner / repo 按 GitHub 的命名规则 */
const PR_RE = /^(#?\d{1,7}|https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?\/)[\w.-]{1,100}\/pull\/\d{1,7})$/;
const HEAD_RE = /^[0-9a-f]{7,40}$/i;

/** git 自己的分支名规则；以 - 开头会被当成选项、@{ 是 reflog 语法、单个 @ 是 HEAD 的别名（check-ref-format --branch 会放行），先挡掉 */
function branchOk(v: string): boolean {
  if (v === "@" || v.startsWith("-") || v.includes("@{")) return false;
  return Bun.spawnSync(["git", "check-ref-format", "--branch", v], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** task-new / task-set / deliver 带的 --branch / --pr / --head；空串 = 清空，放行 */
export function checkTaskRefs(flags: Record<string, string | undefined>): void {
  const { branch, pr, head } = flags;
  if (branch && !branchOk(branch)) throw new LedgerError("invalid", "--branch 不是合法的 git 分支名（git check-ref-format --branch）");
  if (pr && !PR_RE.test(pr)) throw new LedgerError("invalid", "--pr 只收数字、#N 或 https://github.com/<owner>/<repo>/pull/N");
  if (head && !HEAD_RE.test(head)) throw new LedgerError("invalid", "--head 只收 7–40 位十六进制的 commit sha");
}

/**
 * `review --to merge`：开了班子的项目，还欠对抗式（owesAdversarial：当前 head 上没有对抗式 pass、PM 豁免，这一条也不是）就拒绝；
 * 规格卡在、但提到对抗式却读不出「审查：」（unknown）同样拒绝——按规格卡核对。读不到规格卡、派审记录里也没记过要对抗式的不拦（说不清欠不欠）；没开班子照旧。
 * 文案按角色给出口：PM 可以 --waive adversarial；别人只能去派对抗式，或升级给 PM。
 */
/** 团队项目里这一轮、当前 head 还欠不欠对抗式（owesAdversarial）；欠或说不清时给出原因，不欠 / 非团队项目 / 找不到规格卡 = null */
function adversarialDebt(c: LedgerCli, task: LedgerTask, pending?: PendingReview): string | null {
  const meta = getMeta(c.db, task.project);
  if (!meta.team) return null;
  const events = listEvents(c.db, { project: task.project, target: task.id });
  const owes = owesAdversarial(specPolicyOf(task, meta.docsDir), events, task.round, pending);
  if (owes === false || (owes === "unknown" && !specPathFor(task, meta.docsDir))) return null;
  return owes === true
    ? `${task.id} 的规格卡（或之前派审时记下的规格卡策略）要求对抗式，这一轮、当前 head 上还没有对抗式轮的通过（或 PM 豁免）`
    : `${task.id} 的规格卡提到对抗式，但读不出「审查：」那一行，说不清还欠不欠`;
}

/**
 * 进 merge 的闸门：review --to merge（pending = 正要记的这条结论）、PM 手动 stage review → merge 和 blocked → merge（不带 pending）都过它；
 * 真要跳过对抗式统一走 review --waive adversarial --text <理由>，理由记进事件；blocked 被拦时先退回 review（lib/ledger-stages.ts）
 */
export function checkMergeGate(c: LedgerCli, task: LedgerTask, pending?: PendingReview): void {
  const why = adversarialDebt(c, task, pending);
  if (!why) return;
  const waive = pending ? "带 --waive adversarial --text <理由>" : `ledger review ${task.id} … --verdict pass --to merge --waive adversarial --text <理由>（理由会记进事件）`;
  const out = c.isRealPm(task.project)
    ? `PM 核对后确实不需要再审，可以${waive}`
    : `把这件事升级给 PM（ledger escalate ${task.id} --reason …）`;
  const back = task.stage === "blocked" ? `回不了 merge：先 stage ${task.id} --from blocked --to review，再` : "先";
  throw new LedgerError("conflict", `${why}：${back} ledger dispatch ${task.id}（会按规格卡选对抗式）派审，通过后 review --to merge；${out}`);
}
