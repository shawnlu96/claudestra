/**
 * `ledger scheduler-spec-place`（i28-RSM1，只给调度身份）：交回自动时（或存量）停在 spec 的 auto 卡，调度服务按容量池算出放置后的两种台账写。
 * - `--peer <名> --repo <owner/repo> --reason <放置理由>`：照开卡的规矩（scheduler-spec-resume-text.ts）记放置 decision、以「远端卡复述跳过」
 *   推到 restate；卡上没有 extra.repo 就补上（自动开卡的 peer 卡同样带它，planner 派开工单靠它核授权仓库）。
 * - `--wait <原因>`：放置算不出来，记一条可读的等待事件；同一张卡、同一规格版本里与上一条等待原因相同就不再记（recorded=false）；送达确认单独记录，失败可重试。
 * 两种写都在事务里重核 specPlaceBlock 与 rev / workflow-rev，过期了回 conflict，调用方下一轮重算。tests/scheduler-spec-resume.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { updateTask } from "./fix-strategy-task-write.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent, applyMove } from "./ledger-write.js";
import { peerRestateSkip } from "./scheduler-spec-resume-text.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { checkPreparedPeerPlacement, parsePlacementReservation } from "./scheduler-placement-reservations.js";

const SPEC_WAIT_OP = "spec_place_wait";

/** 最近一次「卡进了这一段 spec」：进 spec 的阶段事件，或之后的交回自动 / 开 auto；复述单只认这之后派的 */
function specSince(events: readonly LedgerEvent[]): number {
  return events.findLast((e) => (e.kind === "stage" && e.data.to === "spec") ||
    (e.kind === "scheduler" && (e.data.op === "workflow_resume" || (e.data.op === "workflow" && e.data.mode === "auto"))))?.seq ?? 0;
}

/** 有没有还没结清的自动开卡 claim 指着这张卡：开卡自己会推它过复述，这里不插手 */
function liveClaimOn(db: Database, taskId: string): boolean {
  return !!db.query(`SELECT c.seq FROM events AS c WHERE c.kind = 'feature' AND json_extract(c.data, '$.op') = 'autostart_claim'
    AND json_extract(c.data, '$.taskId') = ? AND NOT EXISTS (SELECT 1 FROM events AS s WHERE s.kind = 'feature'
    AND json_extract(s.data, '$.op') = 'autostart_settle' AND json_extract(s.data, '$.claim') = c.seq) LIMIT 1`).get(taskId);
}

/** 这张卡此刻要不要由放置接手；null = 要。只看台账，调度服务挑卡与事务里重核用同一份 */
export function specPlaceBlock(db: Database, task: LedgerTask, wf: TaskWorkflow | null): string | null {
  if (!wf || wf.mode !== "auto") return "不是 auto 卡";
  if (task.stage !== "spec") return `卡在 ${task.stage}，不在 spec`;
  if (task.kind !== "code" || wf.specRev !== task.specRev) return "流程与规格版本不一致";
  if (task.extra.placement === "local" || String(task.extra.placement ?? "").startsWith("peer:")) return "start_node 已固定放置";
  const author = getSchedulerSession(db, task.id, "author");
  if (author && author.transport !== "peer" && author.state !== "retired") return "已有本机作者绑定";
  if (!author && task.agent && db.query(`SELECT 1 FROM events WHERE target=? AND kind='task'
    AND json_extract(data,'$.op')='set' AND dedupKey LIKE 'dag-start:%:task-set' LIMIT 1`).get(task.id)) return "start_node 已创建本机作者";
  if (db.query("SELECT 1 FROM lend_write_leases WHERE taskId=? AND state='held'").get(task.id)) return "已有 peer 写租约";
  if (db.query("SELECT 1 FROM lend_orders WHERE taskId=? AND status IN ('claimed','unknown') LIMIT 1").get(task.id)) return "已有领取或结果不明的单";
  if (getMeta(db, task.project).queueFrozen.frozen) return "项目队列已冻结";
  if (liveClaimOn(db, task.id)) return "自动开卡还没结清";
  const since = specSince(listEvents(db, { project: task.project, target: task.id }));
  const busy = db.query(`SELECT id FROM scheduler_intents WHERE taskId = ? AND (status IN ('pending','submitted','unknown')
    OR (node = 'restate' AND action = 'dispatch' AND specRev = ? AND status = 'done' AND causalSeq >= ?)) LIMIT 1`).get(task.id, task.specRev, since);
  return busy ? "复述单或别的调度意图已在途" : null;
}

/** 结构化的 CLI 端口：lib 不依赖 manager（同 scheduler-family-pick-notice.ts） */
interface PlaceCommand {
  db: Database; p: { pos: string[]; flags: Record<string, string | undefined> }; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask;
}

function placePeer(c: PlaceCommand, ctx: WriteCtx, task: LedgerTask): Record<string, unknown> {
  const peer = c.need("peer"), repo = c.need("repo"), reason = c.need("reason").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(peer) || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new LedgerError("invalid", "--peer / --repo 不合法");
  const reservation = parsePlacementReservation(c.p.flags.reservation);
  const extra = { ...task.extra, repo: task.extra.repo ?? repo, placement: `peer:${peer}`,
    ...(reservation ? { placementReservation: reservation } : {}) };
  checkPreparedPeerPlacement(c.db, { ...task, extra }, ctx.now ?? Date.now());
  const w = peerRestateSkip(`交回自动时卡还在 spec，按容量池放到 peer:${peer}（${reason}）；复述环节跳过，开工单由放置结果派给它`);
  const decision = appendEvent(c.db, ctx, { project: task.project, target: task.id, kind: "decision", text: w.decision,
    data: { op: "spec_placement", placement: `peer:${peer}`, repo, specRev: task.specRev, transcribed: false } }).event;
  updateTask(c.db, ctx, task, { extra });
  const fresh = c.task(task.id);
  const moved = applyMove(c.db, ctx, fresh, { from: "spec", to: "restate" }, true, w.stage.text, "pm");
  return { ok: true, placed: `peer:${peer}`, decision, event: moved.event, task: moved.task };
}

function recordWait(c: PlaceCommand, ctx: WriteCtx, task: LedgerTask): Record<string, unknown> {
  const reason = c.need("wait").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!reason) throw new LedgerError("invalid", "--wait 要写等待原因");
  const events = listEvents(c.db, { project: task.project, target: task.id });
  const last = events.findLast((e) => e.kind === "note" && e.data.op === SPEC_WAIT_OP && e.data.specRev === task.specRev && e.seq > specSince(events));
  if (last && last.data.reason === reason) return { ok: true, recorded: false, event: last,
    notified: events.some((e) => e.data.op === "spec_place_notified" && e.data.waitSeq === last.seq) };
  const event = appendEvent(c.db, ctx, { project: task.project, target: task.id, kind: "note", text: `交回自动后卡停在 spec，${reason}`,
    data: { op: SPEC_WAIT_OP, kind: "inform", specRev: task.specRev, reason } }).event;
  return { ok: true, recorded: true, event };
}

export const specPlaceCommand = {
  valued: ["rev", "workflow-rev", "peer", "repo", "reason", "wait", "notified", "reservation"], bools: [],
  usage: "scheduler-spec-place <task> --rev N --workflow-rev N (--peer <名> --repo <owner/repo> --reason <理由> | --wait <原因>)（调度服务专用：spec 阶段 auto 卡的放置）",
  run(c: PlaceCommand): Record<string, unknown> {
    return c.db.transaction(() => {
      const ctx = c.ctx(), task = c.task(c.p.pos[1]), wf = getWorkflow(c.db, task.id);
      if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "spec 阶段的放置只由调度服务记账");
      if (task.rev !== Number(c.need("rev")) || wf?.rev !== Number(c.need("workflow-rev"))) throw new LedgerError("conflict", "卡或流程已被改过，下一轮重算");
      if (c.p.flags.notified !== undefined) {
        const seq = Number(c.need("notified"));
        const events = listEvents(c.db, { project: task.project, target: task.id });
        if (!events.some((e) => e.seq === seq && e.data.op === SPEC_WAIT_OP && e.data.specRev === task.specRev))
          throw new LedgerError("conflict", "等待事件已失效");
        if (!events.some((e) => e.data.op === "spec_place_notified" && e.data.waitSeq === seq))
          appendEvent(c.db, ctx, { project: task.project, target: task.id, kind: "note", text: "spec 放置等待已通知 PM",
            data: { op: "spec_place_notified", waitSeq: seq } });
        return { ok: true };
      }
      const blocked = specPlaceBlock(c.db, task, wf);
      if (blocked) throw new LedgerError("conflict", `不再由放置接手：${blocked}`);
      if ((c.p.flags.wait === undefined) === (c.p.flags.peer === undefined)) throw new LedgerError("invalid", "--peer 与 --wait 二选一");
      return c.p.flags.peer !== undefined ? placePeer(c, ctx, task) : recordWait(c, ctx, task);
    }).immediate();
  },
};
