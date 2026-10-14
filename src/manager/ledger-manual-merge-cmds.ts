/**
 * 人工合并排队（dispatch-recovery-MQ1）的 CLI，逻辑全在 lib/manual-merge-queue.ts：
 * - `manual-merge-request <task> --head --spec-rev --round --review-seq [--ui-digest] --reason`：PM（调度助理除外）/ master / owner 显式排队；
 * - `manual-merge-revoke <task> --request <seq> --reason`：撤销；已发出的合并撤不回；
 * - `manual-merge-claim <project> --mode on|observe --train … --required-checks …`：只给调度服务身份（同 SCHEDULER_SERVICE_COMMANDS 一样把关）；
 * - `manual-merge-record <task> --head --merge-sha --pr --base main --main-head --receipt`：真实 PM 登记已在仓库外 / 私仓发生的合入（AUDTRAIN4，
 *   lib/ledger-manual-merge-record.ts）：不合并、不查网络、不推阶段。
 * 只读视图在 `merge-queue`（ledger-merge-queue-cmds.ts）。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { recordManualMerge } from "../lib/ledger-manual-merge-record.js";
import { claimManualMerge, recordRequest, revokeRequest, TRAIN_SIGNALS, type TrainSignal } from "../lib/manual-merge-queue.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Sub-commands the scheduler identity may run besides lib/shared-ledger-gate-cli-services.ts (manager/ledger.ts reads both). */
export const MANUAL_MERGE_SERVICE_COMMANDS: ReadonlySet<string> = new Set(["manual-merge-claim"]);

const int = (c: LedgerCli, flag: string): number => {
  const raw = c.need(flag);
  if (!/^\d{1,12}$/.test(raw)) throw new LedgerError("invalid", `--${flag} 要是非负整数，收到 ${raw}`);
  return Number(raw);
};

const task = (c: LedgerCli, usage: string): string => {
  const [, id, ...extra] = c.p.pos;
  if (!id || extra.length) throw new LedgerError("invalid", usage);
  return c.task(id).id;
};

const REQUEST_USAGE = "manual-merge-request <task> --head <完整 sha> --spec-rev <n> --round <n> --review-seq <审查事件 seq> [--ui-digest <截图摘要>] --reason <为什么>";
const REVOKE_USAGE = "manual-merge-revoke <task> --request <请求 seq> --reason <为什么>";
const RECORD_USAGE = "manual-merge-record <task> --head <完整 sha> --merge-sha <合并提交> --pr <完整 PR 链接> --base main --main-head <含合并提交的 main> --receipt <证据路径或链接>";
const CLAIM_USAGE = "manual-merge-claim <project> --mode on|observe --train none|holds|cleanup|corrupt --required-checks <a,b>（调度服务专用）";

export const MANUAL_MERGE_CMDS: Record<string, CommandSpec> = {
  "manual-merge-request": {
    valued: ["head", "spec-rev", "round", "review-seq", "ui-digest", "reason"],
    usage: `${REQUEST_USAGE}（人工卡显式进合并队列：绑定当前 head / 规格 / 轮次 / 本轮审查事件；不代表自动审查证明）`,
    run(c) {
      const r = recordRequest(c.db, c.ctx(), { taskId: task(c, REQUEST_USAGE), head: c.need("head"), specRev: int(c, "spec-rev"), round: int(c, "round"),
        reviewSeq: int(c, "review-seq"), ...(c.p.flags["ui-digest"] !== undefined ? { uiDigest: c.p.flags["ui-digest"] } : {}), reason: c.need("reason") });
      return { ok: true, request: r.request.seq, task: r.request.taskId, duplicate: r.duplicate, state: r.status.state, why: r.status.why };
    },
  },
  "manual-merge-revoke": {
    valued: ["request", "reason"],
    usage: REVOKE_USAGE,
    run(c) {
      const r = revokeRequest(c.db, c.ctx(), { taskId: task(c, REVOKE_USAGE), seq: int(c, "request"), reason: c.need("reason") });
      return { ok: true, duplicate: r.duplicate, state: r.status.state, why: r.status.why };
    },
  },
  "manual-merge-record": {
    valued: ["head", "merge-sha", "pr", "base", "main-head", "receipt"],
    usage: `${RECORD_USAGE}（PM 先核过 PR、合并时 head、合并提交与 main 包含关系再登记；卡留在 merge 等部署）`,
    run(c) {
      const id = task(c, RECORD_USAGE);
      c.requireRealPm(c.task(id).project, "登记人工合入");
      const r = recordManualMerge(c.db, c.ctx(), { taskId: id, head: c.need("head"), mergeSha: c.need("merge-sha"), pr: c.need("pr"), base: c.need("base"),
        mainHead: c.need("main-head"), receipt: c.need("receipt") });
      return { ok: true, task: id, event: r.event.seq, duplicate: r.duplicate };
    },
  },
  "manual-merge-claim": {
    valued: ["mode", "train", "required-checks"],
    usage: CLAIM_USAGE,
    run(c) {
      const [, project, ...extra] = c.p.pos;
      if (!project || extra.length) throw new LedgerError("invalid", CLAIM_USAGE);
      if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project}`);
      const mode = c.need("mode"), train = c.need("train");
      if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", `--mode 只能是 on / observe（off 不调这个命令），收到 ${mode}`);
      if (!TRAIN_SIGNALS.includes(train as TrainSignal)) throw new LedgerError("invalid", `--train 只能是 ${TRAIN_SIGNALS.join(" / ")}`);
      const checks = c.need("required-checks").split(",").map((s) => s.trim()).filter(Boolean);
      return { ok: true, project, ...claimManualMerge(c.db, c.ctx(), { project, mode, train: train as TrainSignal, requiredChecks: checks }) };
    },
  },
};
