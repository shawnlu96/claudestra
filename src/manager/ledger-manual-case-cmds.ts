/**
 * `ledger manual-queue`（merge-arch-VIEW1）：只读列出项目全部 mode=manual 的卡，活动（含 blocked / live）与终态分区，每张卡的理由、子原因、
 * 停留起点、缺省责任人与期限、解除条件、下一步、证据缺口、人工合并请求状态；--history-hours 再附进入时间窗口内的人工处置段统计。
 * 投影在 lib/manual-case-view.ts、历史在 lib/manual-case-history.ts；本命令走只读连接（write-commands.ts READER_ONLY_SUBS），
 * 不补记、不修复、不恢复、不发提醒。
 * `ledger manual-case-set`（OWN1）：有效 PM / master / owner 给当前段写显式责任人 / 响应期限 / 下一步；`scheduler-manual-case-default`：
 * 调度身份经带租约写口按 manualCaseOwnership 档位补记缺省（on）或只记会分给谁（observe）。两者都在 lib/manual-case-owner-write.ts 事务里重核。
 * `scheduler-manual-case-sla`（SLA1）：调度身份给逾期合并提醒记账（认领一段 / 只记会提醒谁 / 批次结果 sent、unknown、unsent），
 * 在 lib/manual-case-sla-write.ts 事务里重核；manual-queue 的输出附这批提醒的批数、结果不明与叫醒成本。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { setManualCase, writeManualCaseDefault } from "../lib/manual-case-owner-write.js";
import { manualCaseSlaLines, manualCaseSlaReport, SLA_OUTCOMES, writeManualCaseSla, type ManualCaseSlaInput, type SlaOutcome } from "../lib/manual-case-sla-write.js";
import { manualCaseView, type ManualCaseRow } from "../lib/manual-case-view.js";
import { manualHistory } from "../lib/manual-case-history.js";
import { trainSignal, type TrainSignal } from "../lib/manual-merge-queue.js";
import { defaultTrainStore } from "../lib/scheduler-merge-train-hold-slot.js";
import type { LedgerCli } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const DEFAULT_HOURS = 168, MAX_HOURS = 24 * 90;
const iso = (ms: number | null) => (ms === null ? "未知" : new Date(ms).toISOString());

/** OWN1 fields the view's owner carries on top of VIEW1's (manual-case-owner.ts ManualCaseOwner). */
type OwnerExtra = { origin?: string; next?: string | null; authorizer?: string | null };

function line(r: ManualCaseRow): string {
  const o = r.owner as ManualCaseRow["owner"] & OwnerExtra;
  return `${r.taskId}｜${r.stage}｜段#${r.episodeId ?? "未知"}｜${r.reasonCode ?? "未知"}${r.subreason ? `/${r.subreason}` : ""}` +
    `｜自 ${iso(r.since)}${r.ageMin === null ? "" : `（${r.ageMin} 分钟）`}｜责任 ${r.owner.who ?? "未定"}（${o.origin ?? "derived"}）｜期限 ${iso(r.due.at)}${r.due.overdue ? "（已超期）" : ""}` +
    `${o.authorizer ? `｜放行 ${o.authorizer}` : ""}${o.next ? `｜指派下一步：${o.next}` : ""}` +
    `｜下一步：${r.nextStep}${r.candidate ? "｜可恢复候选（只显示）" : ""}${r.gaps.length ? `｜缺：${r.gaps.join("；")}` : ""}` +
    `${r.request ? `｜人工合并#${r.request.seq} ${r.request.state}` : ""}`;
}

function int(c: LedgerCli, flag: string, min: number): number {
  const n = intFlag(c.p, flag);
  if (n === undefined || n < min) throw new LedgerError("invalid", `要带 --${flag} >= ${min}`);
  return n;
}

function isoMs(raw: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isSafeInteger(ms)) throw new LedgerError("invalid", `--due-at 要是 ISO 时间（如 2026-10-13T12:00:00Z），收到 ${raw}`);
  return ms;
}

/** The leased writer's checks before and inside its transaction: lease held, project still under automatic dispatch. */
const active = (c: LedgerCli, project: string) => () => {
  c.deps.assertLease?.();
  if (c.deps.autoDispatch?.() !== true || !c.deps.autoProjects?.().includes(project)) throw new LedgerError("forbidden", "本项目未启用自动调度");
};

const SET_CMD: CommandSpec = {
  valued: ["entry-seq", "responsible", "role", "due-at", "next", "reason", "waiting-on", "workflow-rev"], bools: [],
  usage: "manual-case-set <task> --entry-seq N --responsible <主体> --role pm|owner|executor --due-at <ISO> --next <文字> --reason <文字> [--waiting-on <节点>] [--workflow-rev N]" +
    "（有效 PM / master / owner 给当前 manual 段写责任人、响应期限与下一步；不改模式、不解除 hold）",
  run(c) {
    const task = c.task(c.p.pos[1]);
    return setManualCase(c.db, c.ctx(), { taskId: task.id, entrySeq: int(c, "entry-seq", 1), responsible: c.need("responsible"), role: c.need("role"),
      dueAt: isoMs(c.need("due-at")), next: c.need("next"), reason: c.need("reason"), waitingOn: c.p.flags["waiting-on"],
      workflowRev: c.p.flags["workflow-rev"] === undefined ? undefined : int(c, "workflow-rev", 1) });
  },
};

const DEFAULT_CMD: CommandSpec = {
  valued: ["entry-seq", "workflow-rev", "mode"], bools: [],
  usage: "scheduler-manual-case-default <task> --entry-seq N --workflow-rev N --mode on|observe（调度身份：按 manualCaseOwnership 补记缺省处置或只记会分给谁）",
  run(c) {
    if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "缺省处置补记只给调度服务");
    const task = c.task(c.p.pos[1]), mode = c.need("mode");
    if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", "--mode 要 on / observe");
    return writeManualCaseDefault(c.db, c.ctx(), { taskId: task.id, entrySeq: int(c, "entry-seq", 1), workflowRev: int(c, "workflow-rev", 1), mode },
      active(c, task.project));
  },
};

const SLA_PHASES: readonly string[] = ["claim", "observe", ...SLA_OUTCOMES];

/** `--episodes` of a batch outcome: a JSON list of [task, entry seq] pairs. */
function episodePairs(raw: string): [string, number][] {
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) { throw new LedgerError("invalid", `--episodes 不是 JSON：${(e as Error).message}`); }
  if (!Array.isArray(v) || !v.length || v.some((x) => !Array.isArray(x) || typeof x[0] !== "string" || !Number.isSafeInteger(x[1]))) {
    throw new LedgerError("invalid", "--episodes 要是 [[任务, 段号], …]");
  }
  return v as [string, number][];
}

function slaCmd(train: (project: string, now: number) => TrainSignal): CommandSpec {
  return {
    valued: ["phase", "entry-seq", "pm", "batch", "episodes", "receipt", "summary"], bools: [],
    usage: "scheduler-manual-case-sla <task> --phase claim|observe|sent|unknown|unsent --pm <PM> --batch <批次> [--entry-seq N]" +
      " [--episodes <JSON>] [--receipt <回执>] [--summary <摘要>]" +
      "（调度身份：逾期合并提醒记账；claim / observe 记一段，其余记整批结果，<task> 是批次里的第一张卡）",
    run(c) {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "逾期提醒记账只给调度服务");
      const task = c.task(c.p.pos[1]), phase = c.need("phase"), head = { taskId: task.id, pm: c.need("pm"), batchId: c.need("batch") };
      if (!SLA_PHASES.includes(phase)) throw new LedgerError("invalid", `--phase 要 ${SLA_PHASES.join(" / ")}`);
      const input: ManualCaseSlaInput = phase === "claim" || phase === "observe" ? { ...head, phase, entrySeq: int(c, "entry-seq", 1) }
        : { ...head, phase: phase as SlaOutcome, episodes: episodePairs(c.need("episodes")), receipt: c.p.flags.receipt, summary: c.p.flags.summary };
      return writeManualCaseSla(c.db, c.ctx(), input, active(c, task.project), train(task.project, c.deps.now()));
    },
  };
}

function manualCaseCmds(train: (project: string, now: number) => TrainSignal = (p, now) => trainSignal(defaultTrainStore(), p, now)): Record<string, CommandSpec> {
  return {
    "manual-case-set": SET_CMD,
    "scheduler-manual-case-default": DEFAULT_CMD,
    "scheduler-manual-case-sla": slaCmd(train),
    "manual-queue": {
      valued: ["project", "history-hours"], bools: [],
      usage: "manual-queue [--project <id>] [--history-hours <N>]（只读：全部 manual 卡的原因 / 责任 / 期限 / 解除条件 / 下一步，活动与终态分区；附 N 小时内（缺省 168）进入的人工处置段统计）",
      run(c) {
        const project = c.project(), now = c.deps.now(), raw = c.p.flags["history-hours"];
        const hours = raw === undefined ? DEFAULT_HOURS : Number(raw);
        if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new LedgerError("invalid", `--history-hours 要是 1..${MAX_HOURS} 的整数`);
        const view = manualCaseView(c.db, project, train(project, now), now);
        const h = manualHistory(c.db, project, hours, now);
        const sla = manualCaseSlaReport(c.db, project, now - hours * 3_600_000); // SLA1: batches / unknown / wake cost in the same window
        return {
          ok: true, project, active: view.active, terminal: view.terminal, history: h, sla,
          lines: [`活动 manual ${view.active.length} 张`, ...view.active.map(line), `终态 manual ${view.terminal.length} 张`, ...view.terminal.map(line),
            ...manualCaseSlaLines(sla), // before the history line: readers take the last line as the history summary
            `近 ${hours} 小时进入 ${h.entered} 段：已结束 ${h.ended.total}（hold 替换 ${h.ended.holdReplaced}、workflow_resume ${h.ended.resumed}` +
            `（其中自动 ${h.ended.autoResumed}）、改设其他模式 ${h.ended.modeChanged}、人工完成 ${h.ended.manualDone}），未结束 ${h.truncated}；已结束 p50 ${h.durationMin.p50 ?? "无"} / p90 ${h.durationMin.p90 ?? "无"} 分钟`],
        };
      },
    },
  };
}

export const MANUAL_CASE_CMDS = manualCaseCmds();
