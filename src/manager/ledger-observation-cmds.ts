/**
 * 观察期登记的命令（agents-PMAUTO1，逻辑在 lib/observation-plan*.ts）：
 * - `observation-register <卡> --target recovery:<恢复键>|autostart:<字段> --project <id> --rule v1 --source ledger-events [--hours N] [--start <毫秒|ISO>] --reason`
 *   登记「观察满 N 小时自动转正」这一个动作的授权；--hours 不给就取规格「## 上线后 PM」第一行的观察期，起点不给就取该卡最近一次 verified。
 * - `observation-cancel` 撤自动转正；`observation-mark` / `observation-unmark` 标 / 清人工误判；`observation-recheck` 把交过 PM 的登记放回重核。
 *   以上都要该项目 PM（调度助理除外）/ master / owner。
 * - `observation-due <卡> <登记号> [--sent]`：到期核对，调度服务每轮对到期的登记调；PM 也能手动调。--sent = 通知已送达。
 * - `observation-plans`：只读列表。
 * paths 只给测试指向临时文件。
 */
import { LedgerError } from "../lib/ledger-store.js";
import {
  cancelObservation, markObservation, observationHours, OBSERVATION_PLANS_PATH, OBSERVATION_RULE_VERSION, OBSERVATION_SOURCE, autoMode, parseTarget, planById,
  readPlans, registerObservation, requireConfigurer, targetLabel, type ObservationPlan, type PlanPaths,
} from "../lib/observation-plan.js";
import { ackObservation, observationDue, recheckObservation, type DueOpts } from "../lib/observation-plan-due.js";
import { adaptedTargets } from "../lib/observation-plan-evidence.js";
import { postVerifySection, readPostVerifySpec } from "../lib/scheduler-post-verify-ledger.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export interface ObservationCmdOpts extends DueOpts { readSpec?(taskId: string): { text: string } | null }

const view = (p: ObservationPlan) => ({ id: p.id, task: p.taskId, project: p.project, target: targetLabel(p.target), status: p.status, hours: p.hours,
  startAt: new Date(p.startAt).toISOString(), dueAt: new Date(p.dueAt).toISOString(), ruleVersion: p.ruleVersion, source: p.source, specRev: p.specRev,
  generation: p.generation, configRev: p.configRev ?? null, by: p.by, misjudged: p.misjudged, ...(p.dryRun ? { dryRun: p.dryRun } : {}), ...(p.receipt ? { receipt: p.receipt } : {}),
  ...(p.judge ? { judge: { code: p.judge.code, reason: p.judge.reason, sent: !!p.judge.sentAt } } : {}), ...(p.cancelled ? { cancelled: p.cancelled } : {}) });

function startFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(t)) throw new LedgerError("invalid", `--start 要是毫秒时间戳或 ISO 时间，收到 ${raw}`);
  return t;
}

function recordFlag(c: LedgerCli): number {
  const raw = c.need("misjudged");
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new LedgerError("invalid", `--misjudged 要给观察记录号（台账事件 seq），收到 ${raw}`);
  return Number(raw);
}

const planId = (c: LedgerCli): string => {
  const [, id, ...extra] = c.p.pos;
  if (!id || extra.length) throw new LedgerError("invalid", "要给且只给一个登记号（obs-N）");
  return id;
};

export function observationCmds(o: ObservationCmdOpts = {}): Record<string, CommandSpec> {
  const paths: PlanPaths = { plans: o.plans ?? OBSERVATION_PLANS_PATH, ...(o.recovery ? { recovery: o.recovery } : {}), ...(o.lockMs ? { lockMs: o.lockMs } : {}) };
  return {
    "observation-register": {
      valued: ["target", "project", "rule", "source", "hours", "start", "reason", "dedup"],
      usage: "observation-register <卡> --target recovery:<恢复键>|autostart:<字段> --project <id> "
        + `--rule ${OBSERVATION_RULE_VERSION} --source ${OBSERVATION_SOURCE} [--hours <1–168>] [--start <毫秒|ISO>] --reason <为什么>`
        + "（登记观察期满自动转正；PM / master / owner；--hours 缺省取规格观察期，--start 缺省取最近一次 verified）",
      async run(c) {
        const task = c.task(c.p.pos[1]);
        if (c.p.flags.project === undefined) throw new LedgerError("invalid", "要明确写 --project <id>（必须是该卡所在项目）");
        const section = c.p.flags.hours === undefined ? postVerifySection((o.readSpec ?? readPostVerifySpec)(task.id)?.text) : null;
        const plan = await registerObservation(c.db, c.ctx(), { taskId: task.id, project: c.project(), target: parseTarget(c.p.flags.target),
          hours: observationHours(c.p.flags.hours, section), ruleVersion: c.need("rule"), source: c.need("source"), reason: c.need("reason"),
          startAt: startFlag(c.p.flags.start) }, paths);
        return { ok: true, plan: view(plan), autoMode: autoMode(c.db, plan.project), adapted: adaptedTargets().includes(targetLabel(plan.target)) };
      },
    },
    "observation-cancel": {
      valued: ["reason"], usage: "observation-cancel <登记号> --reason <为什么>（撤掉自动转正；PM / master / owner）",
      async run(c) { return { ok: true, plan: view(await cancelObservation(c.db, c.ctx(), planId(c), c.need("reason"), paths)) }; },
    },
    "observation-mark": {
      valued: ["misjudged", "reason"], usage: "observation-mark <登记号> --misjudged <观察记录号> --reason <理由>（标人工误判，到期不转正；PM / master / owner）",
      async run(c) { return { ok: true, plan: view(await markObservation(c.db, c.ctx(), { id: planId(c), record: recordFlag(c), reason: c.need("reason") }, paths)) }; },
    },
    "observation-unmark": {
      valued: ["misjudged", "reason"], usage: "observation-unmark <登记号> --misjudged <观察记录号> --reason <理由>（清误判标记，留审计；PM / master / owner）",
      async run(c) {
        return { ok: true, plan: view(await markObservation(c.db, c.ctx(), { id: planId(c), record: recordFlag(c), reason: c.need("reason"), clear: true }, paths)) };
      },
    },
    "observation-recheck": {
      valued: ["reason"], usage: "observation-recheck <登记号> --reason <为什么>（把已交 PM 判断的登记放回再核一次；PM / master / owner）",
      async run(c) { return { ok: true, plan: view(await recheckObservation(c.db, c.ctx(), planId(c), c.need("reason"), paths)) }; },
    },
    "observation-due": {
      valued: [], bools: ["sent"], usage: "observation-due <卡> <登记号> [--sent]（到期核对：调度服务每轮调；PM / master / owner 也可手动；--sent = 通知已送达）",
      async run(c) {
        const [, taskId, id, ...extra] = c.p.pos;
        if (!taskId || !id || extra.length) throw new LedgerError("invalid", "用法：observation-due <卡> <登记号> [--sent]");
        const found = planById(readPlans(paths.plans), id);
        if (found.taskId !== taskId) throw new LedgerError("invalid", `登记 ${id} 属于卡 ${found.taskId}，不是 ${taskId}`);
        if (c.deps.actor === "scheduler") c.deps.assertLease?.();
        else requireConfigurer(c.db, c.deps.actor, found.project, "核对观察期登记");
        if (c.p.bools.has("sent")) return { ok: true, plan: view(await ackObservation(c.deps.now(), id, paths)) };
        const { plan, ...r } = await observationDue(c.db, c.ctx(), id, { ...o, ...paths });
        return { ok: true, ...r, plan: view(plan) };
      },
    },
    "observation-plans": {
      valued: ["project"], bools: ["all"], usage: "observation-plans [--project <id>] [--all]（只读：观察期登记，缺省只列有效的）",
      run(c) {
        const project = c.project();
        const plans = readPlans(paths.plans).plans.filter((p) => p.project === project && (c.p.bools.has("all") || p.status === "active"));
        return { ok: true, project, autoMode: autoMode(c.db, project), adapted: adaptedTargets(), plans: plans.map(view) };
      },
    },
  };
}
