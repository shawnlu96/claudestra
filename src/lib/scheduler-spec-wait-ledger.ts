/**
 * 缺规格提醒（team-project-PMWAKE）台账侧：调度身份每次「本该提醒」写一条 feature 事件 `spec_wait`，事务里按台账判节流（时钟 = ctx.now），
 * 去重扛得过调度服务重启（不靠进程内 memo）。同一 (feature, 节点, DAG 版本, 模式) 上一条不满 30 分钟 → due:false 不写；
 * 否则写第 n 条，dedupKey `spec-wait:<feature>:<节点>:v<版本>:<模式>:<n>`。observe 与 on 各算各的，切到 on 时立即发第一条。
 * 调度服务的台账连接是只读的（LedgerReader，query_only），所以写入一律经调度身份、带租约守卫的 ledger CLI：
 * `ledger scheduler-autostart spec-wait <feature> <节点> --version N --mode on|observe --pm <agent> --text <正文>`（specWaitCli）。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { getFeature } from "./ledger-feature.js";
import { textOneLine } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { currentViews, readSwitch } from "./scheduler-autostart.js";
import { switchOff } from "./shared-ledger-gate-switch.js";

export const SPEC_WAIT_REPEAT_MS = 30 * 60_000;

interface SpecWaitRecordInput { featureId: string; key: string; version: number; mode: string; pm: string; text: string }

function recordSpecWait(db: Database, ctx: WriteCtx, input: SpecWaitRecordInput): { due: boolean; seq: number | null } {
  return tx(db, () => {
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "缺规格提醒的记录只有调度服务能写");
    if (input.mode !== "on" && input.mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
    if (!Number.isInteger(input.version) || input.version <= 0) throw new LedgerError("invalid", "--version 要是正整数");
    if (!input.key) throw new LedgerError("invalid", "spec-wait <feature> <节点> --version N --mode on|observe --pm <agent> --text <正文>");
    const f = getFeature(db, input.featureId);
    if (!f) throw new LedgerError("not_found", `没有 feature ${input.featureId}`);
    // 写前在事务里重算台账能判的条件（调度侧读的是上一刻的快照）：开关与模式、feature 在做、版本没换、节点仍 planned 未绑且在 startNow
    const sw = readSwitch(db, f.project);
    const node = currentViews(db, f).find((n) => n.key === input.key);
    if ((sw.specWait ?? "observe") !== input.mode || switchOff(sw, f.id) || f.status !== "active" || f.currentVersion !== input.version
      || !node || node.taskId || node.status !== "planned" || !featureLanes(db, f)?.startNow.includes(input.key)) {
      throw new LedgerError("conflict", "缺规格提醒的条件已变（开关 / 版本 / 节点就绪），这轮不记");
    }
    const now = ctx.now ?? Date.now();
    const rows = db.query(`SELECT ts FROM events WHERE target = ? AND kind = 'feature' AND json_extract(data, '$.op') = 'spec_wait'
      AND json_extract(data, '$.key') = ? AND json_extract(data, '$.version') = ? AND json_extract(data, '$.mode') = ? ORDER BY seq DESC`)
      .all(f.id, input.key, input.version, input.mode) as { ts: number }[];
    if (rows.length && now - rows[0].ts < SPEC_WAIT_REPEAT_MS) return { due: false, seq: null };
    const text = textOneLine(input.text, "正文", 600);
    const e = insertEvent(db, { actor: ctx.actor, now, dedupKey: `spec-wait:${f.id}:${input.key}:v${input.version}:${input.mode}:${rows.length + 1}` }, {
      project: f.project, target: f.id, kind: "feature", text,
      data: { op: "spec_wait", key: input.key, version: input.version, mode: input.mode, pm: input.pm, n: rows.length + 1 },
    }, true);
    return { due: true, seq: e.seq };
  });
}

/** `scheduler-autostart spec-wait` 的参数解析（manager/ledger-autostart-cmds.ts 只接线） */
export function specWaitCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>): { ok: true; due: boolean; seq: number | null } {
  const [featureId = "", key = ""] = pos;
  return { ok: true, ...recordSpecWait(db, ctx, { featureId, key, version: Number(flags.version), mode: flags.mode ?? "", pm: flags.pm ?? "", text: flags.text ?? "" }) };
}
