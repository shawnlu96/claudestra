/**
 * 台账写命令在 CLI 层的输入校验（docs 10-ledger「附：编排班子」）：
 *   任务的 --branch / --pr / --head 写进库之前就校验格式——它们会进 show、网页、bridge 通知和审查员 prompt，
 *   读取方各自清洗挡不住所有下游；`review --to merge` 在规格卡还欠对抗式时拒绝（与路由、currentHandler 同一个判定）。
 * tests/manager-ledger.test.ts（字段）、tests/manager-ledger-dispatch.test.ts（--to merge）。
 */
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getMeta, LedgerError, listEvents } from "../lib/ledger-store.js";
import { owesAdversarial } from "../lib/ledger-handler.js";
import { specPolicyOf } from "../lib/task-spec.js";
import type { LedgerCli } from "./ledger-context.js";

const PR_RE = /^(#?\d{1,7}|https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/\d{1,7})$/;
const HEAD_RE = /^[0-9a-f]{7,40}$/i;

/** git 自己的分支名规则；以 - 开头会被当成选项、@{ 是 reflog 语法，先挡掉 */
function branchOk(v: string): boolean {
  if (v.startsWith("-") || v.includes("@{")) return false;
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
 * `review --to merge`：开了班子的项目，规格卡要对抗式、台账里还没有对抗式轮的 pass（这一条也不是）就拒绝。
 * 对抗式要经 `ledger dispatch` 派（它记下派审种类）；确实审过但没走 dispatch 时由 PM 用 `ledger stage --from review --to merge` 手动推。
 * 没开班子的项目照旧（人工流程不走 dispatch，这里判不出对抗式）；读不到规格卡也不拦（说不清欠不欠）。
 */
export function checkMergeGate(c: LedgerCli, task: LedgerTask, verdict: string): void {
  const meta = getMeta(c.db, task.project);
  if (!meta.team) return;
  const events = listEvents(c.db, { project: task.project, target: task.id });
  if (owesAdversarial(specPolicyOf(task, meta.docsDir), events, { verdict }) !== true) return;
  throw new LedgerError(
    "conflict",
    `${task.id} 的规格卡要求对抗式，台账里还没有对抗式轮的通过：先 ledger dispatch ${task.id}（会自动选对抗式）派审，通过后再 --to merge；` +
      "确实审过对抗式但没走 dispatch，请 PM 用 ledger stage --from review --to merge",
  );
}
