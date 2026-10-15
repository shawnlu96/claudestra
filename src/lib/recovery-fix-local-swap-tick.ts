/**
 * fixLocalSwap's tick half, after the card's plan (scheduler-auto-tick.ts). The planner only reads; durable facts go through the
 * leased `ledger scheduler-recovery-observe` writer: the slotless fixed peer's wait stretch (start / end notes, so the clock survives
 * a restart and restarts on any change), observe's one would-take-over note per card / spec / round / head / P1, and PM 定 5: a
 * review order the outbound gate refused that only a local reviewer could take, with no local room for the needed family, is told
 * to PM once per card and round. A manual fix card inside this key's manual grant keeps the same stretch notes (trackManualLocalSwap),
 * so the owner threshold has a durable clock to read. off records nothing. tests/recovery-fix-local-swap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listEvents } from "./ledger-store.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import { observeDedupKey } from "./recovery-policy.js";
import { FIX_LOCAL_SWAP_KEY, localSwapMode, stretchAnchor, takeoverKey, type LocalSwapFact, type SwapSnapshot } from "./recovery-fix-local-swap.js";
import { FIX_LOCAL_SWAP_MECHANISM, localSwapGrantEnded, manualSwapFact, manualSwapNow, ownerStallMs } from "./recovery-fix-local-swap-manual.js";
import { recoveryMark } from "./manual-recovery-release.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
interface TickPorts { manager: Manager; notifyPm(task: LedgerTask, text: string, level: PmNoticeLevel): Promise<void> }

const record = (m: Manager, task: LedgerTask, actionKey: string, action: string, data: Record<string, unknown>) =>
  m("ledger", "scheduler-recovery-observe", task.id, "--mechanism", FIX_LOCAL_SWAP_KEY, "--action-key", actionKey, "--action", action, "--data", JSON.stringify(data));

const warn = (task: LedgerTask, what: string, r: Record<string, unknown>): void => {
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} fixLocalSwap ${what}没记上，下轮重试：${String(r.error)}`);
};

async function reviewGateNotice(db: Database, task: LedgerTask, snap: SwapSnapshot, plan: PlannerDecision, ports: TickPorts): Promise<void> {
  if (plan.kind !== "wait" || !snap.workflow || ["in_flight", "intent_in_flight", "unknown_effect"].includes(plan.code)) return;
  const mode = localSwapMode(db, task.project);
  if (mode === "off") return;
  const events = listEvents(db, { project: task.project, target: task.id });
  const window = events.findLast((e) => e.kind === "stage" && e.data.to === "review")?.seq ?? 0;
  if (!events.some((e) => e.seq > window && e.kind === "scheduler" && e.data.op === "gate_refused")) return;
  const family = snap.workflow.authorFamily === "claude" ? "codex" : "claude";
  const actionKey = `review-gate:s${task.specRev}:r${task.round}`;
  if (getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: FIX_LOCAL_SWAP_KEY, target: task.id, actionKey }))) return;
  const text = `[调度引擎] ${task.id} 第 ${task.round} 轮审查单被外发闸拒收，只能本机审；本机没有 ${family} 审查名额（${plan.reason}）。` +
    "不加审查容量、不放行同家族审查：PM 核对后处理";
  if (mode === "on") {
    try { await ports.notifyPm(task, text, "action"); }
    catch (e) { console.error(`⚠️ [scheduler] ${task.id} 审查闸拒通知没发出去，下轮重发：${(e as Error).message}`); return; }
  }
  warn(task, "审查闸拒通知回执", await record(ports.manager, task, actionKey, mode === "on" ? `已通知 PM：${text}` : `会通知 PM：${text}`,
    { round: task.round, specRev: task.specRev, family }));
}

/** PM 定值 2: a manual card handed back by this key returns to manual once its granted fix and next cross-model review are done. */
async function grantEnd(db: Database, task: LedgerTask, ports: TickPorts): Promise<string | null> {
  const why = localSwapGrantEnded(task, listEvents(db, { project: task.project, target: task.id }));
  if (!why) return null;
  const r = await ports.manager("ledger", "scheduler-fallback-manual", task.id, "--reason", why);
  if (r.ok !== true) { console.error(`⚠️ [scheduler] ${task.id} fixLocalSwap 授权结束回 manual 没写上，下轮重试：${String(r.error)}`); return null; }
  if (r.duplicate !== true) {
    await ports.notifyPm(task, `[调度引擎] ${task.id} fixLocalSwap 授权已用完，照旧回 manual：${why}`, "action")
      .catch((e: Error) => console.error(`⚠️ [scheduler] ${task.id} 回 manual 通知没发出去（台账已记）：${e.message}`));
  }
  return why;
}

/** The fixed-peer wait stretch's end / start notes the fact asks for (leased observe writer; keyed, so a repeat is the same note). */
async function recordStretch(db: Database, task: LedgerTask, f: LocalSwapFact, mode: string, manager: Manager): Promise<void> {
  if (f.endSeq !== null) warn(task, "等待终点", await record(manager, task, `wait-end:${f.endSeq}`, "固定 peer 无空位等待结束（条件已变，下次重新计时）",
    { stretch: "end", startSeq: f.endSeq }));
  const c = f.candidate;
  if (f.openKey && c) {
    const anchor = stretchAnchor(listEvents(db, { project: task.project, target: task.id }), c.window);
    warn(task, "等待起点", await record(manager, task, `wait-start:${f.openKey}:a${anchor}`,
      `固定 peer ${c.peer} 无 ${c.fromFamily} 空位，开始计时（${mode}）`,
      { stretch: "start", key: f.openKey, specRev: c.specRev, round: c.round, head: c.head, peer: c.peer, family: c.fromFamily }));
  }
}

/**
 * Review r1 manual-wait-clock: a manual fix card inside this key's manual grant — the owner set manualStallHours, the card's manual
 * entry is one fixLocalSwapManual releases and no sticky hold / live manual merge stands (recoveryMark) — gets the stretch notes the
 * auto path would write, on the judge's own as-if-auto fact. Notes only: mode, lease, assignee and intents stay until the owner
 * threshold and the ripe trigger hand the card back through the manual recovery tick. off, no threshold or outside the grant: nothing.
 */
export async function trackManualLocalSwap(db: Database, projects: readonly string[], manager: Manager): Promise<void> {
  if (!projects.length) return;
  const rows = db.query(`SELECT t.id FROM tasks AS t JOIN task_workflows AS w ON w.taskId = t.id WHERE w.mode = 'manual' AND t.stage = 'fix'
    AND t.project IN (${projects.map(() => "?").join(", ")}) ORDER BY t.id`).all(...projects) as { id: string }[];
  for (const { id } of rows) {
    const task = getTask(db, id);
    if (!task || task.stage !== "fix") continue;
    const mode = localSwapMode(db, task.project);
    if (mode === "off" || ownerStallMs(db, task.project) === null || !recoveryMark(db, task, getWorkflow(db, task.id), FIX_LOCAL_SWAP_MECHANISM).ok) continue;
    const f = manualSwapFact(db, task, manualSwapNow(db));
    if (f) await recordStretch(db, task, f, `manual · ${mode}`, manager);
  }
}

/** After the card's plan; a non-null answer means the card went back to manual and its plan must not be written. */
export async function trackLocalSwap(db: Database, task: LedgerTask, snap: SwapSnapshot, plan: PlannerDecision, ports: TickPorts): Promise<string | null> {
  const back = await grantEnd(db, task, ports);
  if (back) return back;
  if (task.stage === "review") { await reviewGateNotice(db, task, snap, plan, ports); return null; }
  const f = snap.localSwap;
  if (!f || f.mode === "off") return null;
  await recordStretch(db, task, f, f.mode, ports.manager);
  const c = f.candidate;
  if (f.mode === "observe" && f.ripe && c) {
    warn(task, "观察", await record(ports.manager, task, takeoverKey(task.id, c),
      `本机 ${c.family} 接手修复（${c.source === "gate" ? "外发闸拒收本窗口材料" : `固定 peer ${c.peer} 无空位`}已超阈值）；observe 不收租约、不撤单、不建会话`,
      { evidence: c }));
  }
  return null;
}
