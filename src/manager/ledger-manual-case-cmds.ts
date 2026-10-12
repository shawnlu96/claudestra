/**
 * `ledger manual-queue`（merge-arch-VIEW1）：只读列出项目全部 mode=manual 的卡，活动（含 blocked / live）与终态分区，每张卡的理由、子原因、
 * 停留起点、缺省责任人与期限、解除条件、下一步、证据缺口、人工合并请求状态；--history-hours 再附进入时间窗口内的人工处置段统计。
 * 投影在 lib/manual-case-view.ts、历史在 lib/manual-case-history.ts；本命令走只读连接（write-commands.ts READER_ONLY_SUBS），
 * 不补记、不修复、不恢复、不发提醒。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { manualCaseView, type ManualCaseRow } from "../lib/manual-case-view.js";
import { manualHistory } from "../lib/manual-case-history.js";
import { trainSignal, type TrainSignal } from "../lib/manual-merge-queue.js";
import { defaultTrainStore } from "../lib/scheduler-merge-train-hold-slot.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const DEFAULT_HOURS = 168, MAX_HOURS = 24 * 90;
const iso = (ms: number | null) => (ms === null ? "未知" : new Date(ms).toISOString());

function line(r: ManualCaseRow): string {
  return `${r.taskId}｜${r.stage}｜段#${r.episodeId ?? "未知"}｜${r.reasonCode ?? "未知"}${r.subreason ? `/${r.subreason}` : ""}` +
    `｜自 ${iso(r.since)}${r.ageMin === null ? "" : `（${r.ageMin} 分钟）`}｜责任 ${r.owner.who ?? "未定"}｜期限 ${iso(r.due.at)}${r.due.overdue ? "（已超期）" : ""}` +
    `｜下一步：${r.nextStep}${r.candidate ? "｜可恢复候选（只显示）" : ""}${r.gaps.length ? `｜缺：${r.gaps.join("；")}` : ""}` +
    `${r.request ? `｜人工合并#${r.request.seq} ${r.request.state}` : ""}`;
}

function manualCaseCmds(train: (project: string, now: number) => TrainSignal = (p, now) => trainSignal(defaultTrainStore(), p, now)): Record<string, CommandSpec> {
  return {
    "manual-queue": {
      valued: ["project", "history-hours"], bools: [],
      usage: "manual-queue [--project <id>] [--history-hours <N>]（只读：全部 manual 卡的原因 / 责任 / 期限 / 解除条件 / 下一步，活动与终态分区；附 N 小时内（缺省 168）进入的人工处置段统计）",
      run(c) {
        const project = c.project(), now = c.deps.now(), raw = c.p.flags["history-hours"];
        const hours = raw === undefined ? DEFAULT_HOURS : Number(raw);
        if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new LedgerError("invalid", `--history-hours 要是 1..${MAX_HOURS} 的整数`);
        const view = manualCaseView(c.db, project, train(project, now), now);
        const h = manualHistory(c.db, project, hours, now);
        return {
          ok: true, project, active: view.active, terminal: view.terminal, history: h,
          lines: [`活动 manual ${view.active.length} 张`, ...view.active.map(line), `终态 manual ${view.terminal.length} 张`, ...view.terminal.map(line),
            `近 ${hours} 小时进入 ${h.entered} 段：已结束 ${h.ended.total}（hold 替换 ${h.ended.holdReplaced}、workflow_resume ${h.ended.resumed}` +
            `（其中自动 ${h.ended.autoResumed}）、改设其他模式 ${h.ended.modeChanged}、人工完成 ${h.ended.manualDone}），未结束 ${h.truncated}；已结束 p50 ${h.durationMin.p50 ?? "无"} / p90 ${h.durationMin.p90 ?? "无"} 分钟`],
        };
      },
    },
  };
}

export const MANUAL_CASE_CMDS = manualCaseCmds();
