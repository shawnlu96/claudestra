/**
 * 合并待 PM 处置提醒（dispatch-recovery-MQWAKE1）台账侧：调度身份、带租约守卫的
 * `ledger scheduler-autostart merge-pm <卡> record <阻塞键> --mode on|observe --pm <agent>` 与 `… merge-pm <卡> sent <发送意图 seq> --mode on --pm <agent>`。
 * 写前在同一个 BEGIN IMMEDIATE 事务里重算 mergePmCandidate：项目归调度管、开关模式、阻塞键（= 当前请求与绑定）、收件 PM 都要和预读一致，
 * 任一不符 → conflict，调度下一轮重判。正文与 dedup 键只在这里算，--text / --dedup 等旗标一律拒。只写本卡的 note 事件（op merge_pm_wait），
 * 不碰请求、审批、截图、审查、阶段、意图或合并槽。
 * - observe：每个阻塞实例一条 would 记录（`merge-pm-would:<卡>:<键>`），不发。
 * - on：已有 `merge-pm-sent:<卡>:<键>` → due:false；同一实例上一条发送意图不满 30 分钟 → due:false；否则写第 n 条发送意图
 *   `merge-pm-try:<卡>:<键>:<n>` 并返回正文。调度确认发出后用 sent 写确认（按实例只一条）；发送失败没有确认，30 分钟后重试。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { busyAsLedgerError, getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { readSwitch, type ServiceFacts } from "./scheduler-autostart.js";
import { mergePmCandidate, mergePmTarget } from "./scheduler-merge-pm-wait.js";

export const MERGE_PM_REPEAT_MS = 30 * 60_000;
export type MergePmMode = "on" | "observe" | "off";

/** 项目级开关 autostart.mergePmWait，缺省 observe；与 specWait 互不借用 */
export const mergePmMode = (db: Database, project: string): MergePmMode => readSwitch(db, project).mergePmWait ?? "observe";

const mergePmSentKey = (taskId: string, key: string) => `merge-pm-sent:${taskId}:${key}`;
const wouldKey = (taskId: string, key: string) => `merge-pm-would:${taskId}:${key}`;

/** 本实例 on 模式下的发送意图（新的在前） */
const tries = (db: Database, taskId: string, key: string) => listEvents(db, { target: taskId })
  .filter((e) => e.kind === "note" && e.actor === "scheduler" && e.data.op === "merge_pm_wait" && e.data.kind === "try" && e.data.key === key).reverse();

/** 这一轮该不该记 / 发：observe 每实例一条；on 已确认送达就停，否则上一条意图满 30 分钟才再来 */
export function mergePmDue(db: Database, taskId: string, key: string, mode: MergePmMode, now: number): boolean {
  if (mode === "off") return false;
  if (mode === "observe") return !getEventByDedup(db, wouldKey(taskId, key));
  if (getEventByDedup(db, mergePmSentKey(taskId, key))) return false;
  const last = tries(db, taskId, key)[0];
  return !last || now - last.ts >= MERGE_PM_REPEAT_MS;
}

type Out = { due: boolean; seq: number | null; to: string; text: string; key: string };

function recordInTx(db: Database, ctx: WriteCtx, pos: string[], mode: string, pm: string, svc: Pick<ServiceFacts, "projects">): Out {
  const [taskId, op, ref] = pos;
  const t = getTask(db, taskId);
  if (!t) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  if (!svc.projects.includes(t.project)) throw new LedgerError("forbidden", `项目 ${t.project} 不归调度服务管，不记合并待处置提醒`);
  const now = ctx.now ?? Date.now();
  if (op === "sent") {
    // 确认只认本卡本实例自己的发送意图；送达确认不要求候选此刻仍在（已经发出去了），但收件人须是意图里那位
    const intent = listEvents(db, { target: t.id }).find((e) => e.seq === Number(ref));
    if (!intent || intent.actor !== "scheduler" || intent.kind !== "note" || intent.data.op !== "merge_pm_wait" || intent.data.kind !== "try"
      || intent.data.pm !== pm || mode !== "on") throw new LedgerError("conflict", `#${ref} 不是本卡发给 ${pm} 的发送意图`);
    const key = String(intent.data.key);
    const r = appendEvent(db, { ...ctx, now, dedupKey: mergePmSentKey(t.id, key) },
      { project: t.project, target: t.id, kind: "note", text: `合并待处置提醒已送达 ${pm}`, data: { op: "merge_pm_wait", kind: "sent", key, pm, try: intent.seq } });
    return { due: false, seq: r.duplicate ? null : r.event.seq, to: pm, text: "", key };
  }
  const c = mergePmCandidate(db, t.id, now);
  if (mergePmMode(db, t.project) !== mode || !c || c.key !== ref || mergePmTarget(db, t.id) !== pm) {
    throw new LedgerError("conflict", "合并待处置提醒的条件已变（开关 / 请求与绑定 / 收件 PM），这轮不记");
  }
  const out = { due: false, seq: null, to: pm, text: c.text, key: c.key };
  if (!mergePmDue(db, t.id, c.key, mode, now)) return out;
  const data = { op: "merge_pm_wait", key: c.key, mode, pm, request: c.request, head: c.head, specRev: c.specRev, round: c.round, reasons: c.reasons };
  if (mode === "observe") {
    const r = appendEvent(db, { ...ctx, now, dedupKey: wouldKey(t.id, c.key) },
      { project: t.project, target: t.id, kind: "note", text: `合并待处置提醒（observe，本该发给 ${pm}）`, data: { ...data, kind: "would" } });
    return { ...out, seq: r.duplicate ? null : r.event.seq };
  }
  const n = tries(db, t.id, c.key).length + 1;
  const r = appendEvent(db, { ...ctx, now, dedupKey: `merge-pm-try:${t.id}:${c.key}:${n}` },
    { project: t.project, target: t.id, kind: "note", text: `合并待处置提醒第 ${n} 次发送意图（→ ${pm}）`, data: { ...data, kind: "try", n } });
  return { ...out, due: !r.duplicate, seq: r.duplicate ? null : r.event.seq };
}

const USAGE = "merge-pm <卡> record <阻塞键> | sent <发送意图 seq> --mode on|observe --pm <agent>";

/** `scheduler-autostart merge-pm` 的参数解析（manager/ledger-autostart-cmds.ts 只接线）；正文与 dedup 键只由这里算 */
export function mergePmCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>, svc: Pick<ServiceFacts, "projects">): Out & { ok: true } {
  const extra = Object.keys(flags).filter((k) => flags[k] !== undefined && k !== "mode" && k !== "pm");
  if (extra.length || pos.length !== 3 || ctx.dedupKey !== undefined || !["record", "sent"].includes(pos[1])) {
    throw new LedgerError("invalid", `${USAGE}（正文与 dedup 键由调度算，不收 ${extra.map((k) => `--${k}`).join(" ") || "额外参数"}）`);
  }
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "合并待处置提醒的记录只有调度服务能写");
  const mode = flags.mode ?? "", pm = flags.pm ?? "";
  if (mode !== "on" && mode !== "observe") throw new LedgerError("invalid", "--mode 只能是 on / observe");
  return { ok: true, ...busyAsLedgerError("记合并待处置提醒", () => db.transaction(() => recordInTx(db, ctx, pos, mode, pm, svc)).immediate()) };
}
