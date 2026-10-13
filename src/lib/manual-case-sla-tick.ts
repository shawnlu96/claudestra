/**
 * merge-arch-SLA1 pass: overdue manual episodes that still need a person, one message per project and PM. Run by the manual-recovery
 * wiring (scheduler-recovery-ports.ts) after MAN2, the evidence mechanisms and OWN1, so every recovery of this round was judged first
 * and the cards are read again: a card handed back is gone, a recoverable-looking one whose mechanism did not act is still reminded,
 * marked as a candidate that was not executed (the switch stays the PM's). Per PM the pending episodes wait a 30 min window from the
 * earliest deadline (and from the PM's last batch), then: observe (default) records who would be told about which cards and sends
 * nothing; on claims each episode through the leased writer, has the writer judge the whole claimed batch once more right before the
 * send (confirm: an episode that moved while the later claims were written is released unsent, the message is built from the rest),
 * sends that as one message over the bridge, and records sent / unknown / unsent. A lost lease stops before the send. Only an unsent
 * batch or a released claim is ever offered again. An episode an older stall notice already told the PM about, or claimed with no
 * delivery record (may have been delivered), is left to that notice for good (manual-case-sla-compat.ts legacyStallNotice). tests/manual-case-sla*.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { legacyStallNotice, manualCaseSlaMode } from "./manual-case-sla-compat.js";
import { slaCases, slaEpisodeState, slaLastClaimAt, slaObserveKey, type SlaCase, type SlaOutcome } from "./manual-case-sla-write.js";
import { trainSignal, type TrainSignal } from "./manual-merge-queue.js";
import type { ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";

export const SLA_BATCH_WINDOW_MS = 30 * 60_000;
/** One message stays readable; the rest of a larger backlog goes into the PM's next window. */
const SLA_BATCH_MAX = 30;
/** A claim this old with no outcome and no send out in this process was cut off (crash / lost lease): recorded unknown once. */
const DANGLING_AFTER_MS = 5 * 60_000;

export interface SlaSendResult { state: SlaOutcome; receipt?: string; why?: string }
export interface ManualCaseSlaDeps {
  /** `scheduler-manual-case-sla <args>` through the leased writer */
  write: (args: string[]) => Promise<Record<string, unknown>>;
  now?: () => number;
  /** one message to one PM; never throws for an ordinary failure (a throw is taken as unknown) */
  send?: (project: string, pm: string, text: string, batchId: string) => Promise<SlaSendResult>;
  policy?: ExplicitPolicyPort;
  train?: (project: string, now: number) => TrainSignal;
  yieldNow?: () => boolean;
}
export interface ManualCaseSlaOutcome {
  project: string; pm?: string; mode: "on" | "observe" | "off";
  action: "none" | "window_wait" | "would_notify" | "observed_before" | "raced" | "released" | "legacy_covered" | SlaOutcome | "settled_unknown" | "error";
  batchId?: string; episodes?: [string, number][]; why: string;
}

/** The existing bridge path of every scheduler → PM notice (pm-notify.ts), kept apart only to learn whether the frame left. */
const bridgeSendPm: NonNullable<ManualCaseSlaDeps["send"]> = async (_project, pm, text) => {
  const r = await bridgeSend({ type: "route_to_agent", targetName: pm, text, fromName: "scheduler", oneShot: true }, { timeoutMs: 30_000 });
  if (r.ok) return { state: "sent", receipt: typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? null) };
  return { state: r.sent ? "unknown" : "unsent", why: r.error };
};

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";
const hours = (min: number) => (min >= 120 ? `${(min / 60).toFixed(1)} 小时` : `${min} 分钟`);

/** The message, from the claim snapshots only. The batch id leads so a usage row's trigger summary can be linked to it. */
export function slaBatchText(project: string, pm: string, batchId: string, cases: readonly SlaCase[]): string {
  const lines = cases.map((c, i) => `${i + 1}. ${c.taskId}（${c.title}）段#${c.entrySeq}｜阶段 ${c.stage}｜原因：${c.reason}` +
    `｜${c.ageMin === null ? "" : `进入人工 ${hours(c.ageMin)}，`}逾期 ${hours(c.overdueMin)}（期限 ${iso(c.dueAt)}）｜责任人 ${c.responsible}（${c.role}）` +
    `｜下一步：${c.next}${c.candidate ? "｜可恢复候选未执行：只读事实看似可恢复，自动恢复没有执行（机制未开或未通过），本提醒不代 PM 开开关" : ""}`);
  return [`[人工卡逾期 ${batchId}] 项目 ${project} · 给 ${pm}：${cases.length} 段人工处置已过响应期限，合并成这一条（每段只提醒这一次，不用逐卡回复）`,
    ...lines, "责任人是 owner / 执行者的段也由你汇总追踪；本提醒不改流程、阶段与恢复权限。",
    `查询：ledger manual-queue --project ${project}（责任 / 期限 / 解除条件 / 提醒记录）`].join("\n");
}

type Tracked = SlaCase & { state: ReturnType<typeof slaEpisodeState>; legacy: ReturnType<typeof legacyStallNotice> };
/** Batch ids whose send is still out in this process (one lease holder runs the tick): never judged dangling. */
const IN_FLIGHT = new Set<string>();
const batchIdOf = (project: string, pm: string, now: number, cases: readonly SlaCase[]) =>
  `sla-${createHash("sha256").update(JSON.stringify([project, pm, now, cases.map((c) => [c.taskId, c.entrySeq])])).digest("hex").slice(0, 12)}`;
const keysOf = (cases: readonly SlaCase[]): [string, number][] => cases.map((c) => [c.taskId, c.entrySeq]);
const settleArgs = (lead: string, phase: SlaOutcome | "confirm", pm: string, batchId: string, episodes: [string, number][]) =>
  [lead, "--phase", phase, "--pm", pm, "--batch", batchId, "--episodes", JSON.stringify(episodes)];

class Round {
  readonly out: ManualCaseSlaOutcome[] = [];
  constructor(readonly db: Database, readonly d: ManualCaseSlaDeps, readonly project: string, readonly mode: "on" | "observe", readonly now: number) {}

  /** A card's refusal (raced, held by the central mapping) is that card's: null. A lost lease or a broken writer stops the round. */
  private async card(args: string[]): Promise<Record<string, unknown> | null> {
    try { return await this.d.write(args); } catch (e) {
      if (e instanceof LedgerError) return null;
      throw e;
    }
  }

  /** Claims left without an outcome by an earlier process: recorded unknown once, never sent again. */
  async settleDangling(cases: readonly Tracked[]): Promise<void> {
    const cut = new Map<string, Tracked[]>();
    for (const c of cases) {
      const claim = c.state.claim;
      if (c.state.state !== "claimed" || !claim || IN_FLIGHT.has(claim.batchId) || this.now - claim.ts < DANGLING_AFTER_MS) continue;
      cut.set(claim.batchId, [...(cut.get(claim.batchId) ?? []), c]);
    }
    for (const [batchId, list] of cut) {
      const pm = list[0].state.claim!.pm, r = await this.card([...settleArgs(list[0].taskId, "unknown", pm, batchId, keysOf(list)),
        "--summary", "认领后没有发送结果记录（进程中断或失租约）：可能已送达，不重发"]);
      if (r) this.out.push({ project: this.project, pm, mode: this.mode, action: "settled_unknown", batchId, episodes: keysOf(list), why: "认领后无结果记录，记为结果不明" });
    }
  }

  async observe(pm: string, batchId: string, cases: readonly SlaCase[]): Promise<void> {
    const noted: [string, number][] = [];
    for (const c of cases) {
      const r = await this.card([c.taskId, "--phase", "observe", "--entry-seq", String(c.entrySeq), "--pm", pm, "--batch", batchId]);
      if (r?.recorded === true) noted.push([c.taskId, c.entrySeq]);
    }
    if (noted.length) this.out.push({ project: this.project, pm, mode: "observe", action: "would_notify", batchId, episodes: noted, why: `observe：会把 ${noted.length} 段合成一条给 ${pm}，没有认领、没有发送` });
  }

  async notify(pm: string, batchId: string, cases: readonly SlaCase[]): Promise<void> {
    const claimed: SlaCase[] = [];
    for (const c of cases) {
      const r = await this.card([c.taskId, "--phase", "claim", "--entry-seq", String(c.entrySeq), "--pm", pm, "--batch", batchId]);
      if (r?.recorded === true && r.snapshot) claimed.push(r.snapshot as SlaCase); // the message quotes the claim's snapshot, not this pass's earlier read
    }
    const base = { project: this.project, pm, mode: "on" as const, batchId };
    if (!claimed.length) return void this.out.push({ ...base, action: "raced", why: "认领时各段都已变化或已被认领，本轮不发" });
    IN_FLIGHT.add(batchId);
    try {
      // The send boundary: the writer re-reads every claimed episode in one transaction; nothing is awaited between its answer and the send.
      let kept: SlaCase[];
      try {
        const r = await this.d.write(settleArgs(claimed[0].taskId, "confirm", pm, batchId, keysOf(claimed)));
        const keep = new Set((r.keep as [string, number][]).map((k) => JSON.stringify(k)));
        kept = claimed.filter((c) => keep.has(JSON.stringify([c.taskId, c.entrySeq])));
        const gone = (r.released ?? []) as { taskId: string; entrySeq: number; why: string }[];
        if (gone.length) {
          console.log(`[manual-case-sla] ${this.project} batch=${batchId} pm=${pm} released=${gone.map((g) => `${g.taskId}#${g.entrySeq}`).join(",")}`);
          this.out.push({ ...base, action: "released", episodes: gone.map((g) => [g.taskId, g.entrySeq]), why: `发送前重核退出、未发送：${[...new Set(gone.map((g) => g.why))].join("；")}` });
        }
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e; // lease lost: no send; the claims read unknown to the next holder
        // not confirmed = not sent, for certain: say so, so these episodes stay owed instead of ageing into unknown
        await this.d.write([...settleArgs(claimed[0].taskId, "unsent", pm, batchId, keysOf(claimed)), "--summary", `发送前重核没有完成，未发送：${(e as Error).message}`]);
        return void this.out.push({ ...base, action: "unsent", episodes: keysOf(claimed), why: `发送前重核没有完成，未发送：${(e as Error).message}` });
      }
      if (!kept.length) return;
      claimed.splice(0, claimed.length, ...kept);
      const text = slaBatchText(this.project, pm, batchId, claimed), episodes = keysOf(claimed);
      let sent: SlaSendResult;
      try { sent = await (this.d.send ?? bridgeSendPm)(this.project, pm, text, batchId); } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        sent = { state: "unknown", why: (e as Error).message }; // a send that threw may have left this process
      }
      await this.d.write([...settleArgs(claimed[0].taskId, sent.state, pm, batchId, episodes), ...(sent.receipt ? ["--receipt", sent.receipt] : []),
        "--summary", `${claimed.length} 段：${episodes.map(([t, s]) => `${t}#${s}`).join("、")}${sent.why ? `；${sent.why}` : ""}`]);
      console.log(`[manual-case-sla] ${this.project} batch=${batchId} pm=${pm} episodes=${claimed.length} state=${sent.state}${sent.why ? ` why=${sent.why}` : ""}`);
      this.out.push({ ...base, action: sent.state, episodes, why: sent.why ?? `${claimed.length} 段合成一条` });
    } finally { IN_FLIGHT.delete(batchId); }
  }
}

async function projectRound(db: Database, project: string, d: ManualCaseSlaDeps, mode: "on" | "observe", now: number): Promise<ManualCaseSlaOutcome[]> {
  const round = new Round(db, d, project, mode, now);
  const train = (d.train ?? ((p, at) => trainSignal(defaultTrainStore(), p, at)))(project, now);
  const cases: Tracked[] = slaCases(db, project, now, train).map((c) => ({ ...c, state: slaEpisodeState(db, project, listEvents(db, { project, target: c.taskId }), c.entrySeq),
    legacy: legacyStallNotice(db, project, c.taskId, c.entrySeq) }));
  if (mode === "on") await round.settleDangling(cases);
  const byPm = new Map<string, Tracked[]>(), older: Tracked[] = [];
  for (const c of cases) {
    const open = c.state.state === "none" || c.state.state === "unsent";
    if (open && c.legacy) older.push(c); // told per card by an older notice, or claimed by it with the delivery unknown: not batched
    if (!open || c.legacy || (mode === "observe" && getEventByDedup(db, slaObserveKey(project, c.taskId, c.entrySeq)))) continue;
    byPm.set(c.pm, [...(byPm.get(c.pm) ?? []), c]);
  }
  if (older.length) {
    const how = older.map((c) => `${c.legacy!.state === "told" ? "已送达" : "已认领、投递结果不明（可能已送达，不接管重发）"}：${c.legacy!.by}`);
    round.out.push({ project, mode, action: "legacy_covered", episodes: keysOf(older), why: `旧的逐卡停滞提醒${[...new Set(how)].join("；")}，同段不合批提醒` });
  }
  for (const [pm, list] of byPm) {
    const pending = list.sort((a, b) => a.dueAt - b.dueAt || a.taskId.localeCompare(b.taskId)).slice(0, SLA_BATCH_MAX);
    const opensAt = Math.max(pending[0].dueAt, (mode === "on" ? slaLastClaimAt(db, project, pm) : null) ?? 0) + SLA_BATCH_WINDOW_MS;
    if (now < opensAt) { round.out.push({ project, pm, mode, action: "window_wait", episodes: keysOf(pending), why: `合批窗口到 ${iso(opensAt)}` }); continue; }
    if (d.yieldNow?.()) break; // asked only when a batch is about to be written: a round with nothing due costs the pace no check
    const batchId = batchIdOf(project, pm, now, pending);
    if (mode === "observe") await round.observe(pm, batchId, pending); else await round.notify(pm, batchId, pending);
  }
  return round.out;
}

/** One pass over the projects; a project's failure is logged and the others still run, a lost lease stops everything. */
export async function manualCaseSlaTick(db: Database, projects: readonly string[], d: ManualCaseSlaDeps): Promise<ManualCaseSlaOutcome[]> {
  const out: ManualCaseSlaOutcome[] = [];
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_workflows'").get()) return out;
  for (const project of projects) {
    const m = manualCaseSlaMode(project, d.policy);
    if (m.mode !== "on" && m.mode !== "observe") { // off reads nothing; an unreadable policy also does nothing, but says so
      if (m.mode === "error") console.error(`⚠️ [scheduler] ${project} 人工卡逾期提醒停手：${m.why}`);
      out.push({ project, mode: "off", action: m.mode === "error" ? "error" : "none", why: m.why });
      continue;
    }
    try { out.push(...await projectRound(db, project, d, m.mode, d.now?.() ?? Date.now())); } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      console.error(`⚠️ [scheduler] ${project} 人工卡逾期提醒这轮没跑完（已认领未记结果的批次按结果不明，不重发）：${(e as Error).message}`);
      out.push({ project, mode: m.mode, action: "error", why: (e as Error).message });
    }
  }
  return out;
}
