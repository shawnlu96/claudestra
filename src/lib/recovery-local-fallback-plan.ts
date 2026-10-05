/**
 * Local takeover eligibility (dispatch-recovery-FB2P): may this machine's Codex take over a write / fix that cannot go out?
 * Only two triggers count — this window's outbound-gate block (scheduler-dispatch-block.ts, state blocked) and "no peer it may
 * safely go to" (the planner's own peer_unavailable). Safety holds, owner freezes, private / local-only bans, any delivery that is
 * not proven undelivered or formally ended, another card's file lock on this card's globs (the planner shows that wait as
 * peer_unavailable too, yet a local author is held by the same lock), a missing grant / slot / quota proof or a family switch all block. Pure and read-only:
 * no session, SQL write, order change or model call happens here; FB2 runs the steps and CAS (staleBasis with fresh facts and the policy port first, in its transaction).
 * FB2 call site: the auto tick's build / fix card whose decision is a wait (scheduler-auto-tick / scheduler-autostart-deps), via
 * readLocalFallbackFacts → planLocalFallback. tests/recovery-local-fallback-plan*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import { listLendOrders, type LendOrder } from "./ledger-lend.js";
import { getWriteLease, type WriteLease } from "./ledger-lend-lease.js";
import { resourceKey, resourcesOverlap, type AuthorFamily } from "./ledger-scheduler.js";
import { getMeta } from "./ledger-store.js";
import { planGapPolicy, specHolds, type RecoveryPolicy } from "./recovery-plan-gap.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { explainWithBlock, gateBlock } from "./scheduler-dispatch-block.js";
import { localFamilyRefusal } from "./scheduler-local-families-placement.js";
import { codexQuotaWait } from "./scheduler-local-runtime-quota.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot, type WorkerRef } from "./scheduler-plan.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { openRefusal } from "./scheduler-review-swap.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import type { LedgerTask } from "./ledger-stages.js";

/** CFG's recoveryPolicy(project, mechanism) narrowed to this mechanism; a function over every RecoveryKey is assignable. */
export type LocalFallbackPolicyPort = (project: string, mechanism: "localFallback") => RecoveryPolicy;

/** No port observes, a throwing / garbage port is off with a diagnosis: the plan-gap validator, asked for localFallback. */
export function localFallbackPolicy(port: LocalFallbackPolicyPort | undefined, project: string): RecoveryPolicy & { diag: string | null } {
  return planGapPolicy(port && ((p) => port(p, "localFallback")), project);
}

/** A proof is positive or it is a reason; nothing here reads "unknown" as fine. */
export type Proof = { ok: true } | { ok: false; why: string };

const WEEKLY = ["weekly", "weekly_scoped"];

/**
 * Codex weekly quota as a positive proof: every weekly window observed now (finite usage, reset not passed or due) and under the
 * project's line. codexQuotaWait lets an unreadable / unknown snapshot or an unknown / just-reset weekly window through
 * (scheduling never stalls on it); a takeover needs the opposite, so none of those is proof here — "known" alone only means some
 * window (maybe the 5h one) has a number.
 */
export async function localCodexQuotaProof(read: () => Promise<InventoryQuota> = async () => (await readInventoryQuota()).codex, now = Date.now(),
  at: { project?: string; ledgerPath?: string } = {}): Promise<Proof> {
  let q: InventoryQuota;
  try { q = await read(); } catch (e) { return { ok: false, why: `Codex 额度读不到：${(e as Error).message}`.slice(0, 300) }; }
  if (q.status !== "known") return { ok: false, why: `Codex 额度未知（${q.reason ?? "无快照"}），不算额度证明` };
  const weekly = q.windows.filter((w) => WEEKLY.includes(w.kind));
  if (!weekly.length) return { ok: false, why: "Codex 没有周额度窗口观测，不算额度证明" };
  const unsure = weekly.find((w) => w.resetPassed || w.usedPct === null || !Number.isFinite(w.usedPct) || (w.resetsAtMs !== null && w.resetsAtMs <= now));
  if (unsure) return { ok: false, why: `Codex 周额度 ${unsure.id} 用量未知或应已重置未确认，不算额度证明` };
  const over = await codexQuotaWait(async () => q, now, at);
  return over ? { ok: false, why: over.reason } : { ok: true };
}

/** Work the takeover must leave untouched (worktree commits not on the remote branch, notes); FB2 measures them. */
interface ArtifactRef { kind: "branch" | "worktree" | "session" | "other"; ref: string; note?: string }

export interface LocalFallbackFacts {
  snapshot: PlannerSnapshot;
  /** planScheduler(snapshot): the trigger is the planner's own category, never a second guess. */
  decision: PlannerDecision;
  orders: readonly LendOrder[];
  lease: WriteLease | null;
  /** Card spec text; null = unreadable, so holds cannot be ruled out. */
  specText: string | null;
  /** A free local Codex write slot measured now (the caller's slot count); the grant itself comes from the snapshot's policy. */
  slot: Proof;
  quota: Proof;
  /** Private-repo / project ban on sending this card's code out, if the caller knows one; spec 「本机限定：是」 counts too. */
  outboundBan?: string | null;
  unpushed?: readonly ArtifactRef[];
}

type BlockCode = "policy_off" | "not_auto" | "stage" | "not_candidate" | "safety_hold" | "owner_hold" | "private_ban" | "spec_unreadable" |
  "delivery_unproven" | "result_exists" | "lock_busy" | "no_grant" | "no_slot" | "no_quota" | "family_switch";

/** Everything whose change makes an old plan void (intent / head / spec / branch / session / any new event / orders / lease). */
export interface PlanBasis {
  taskId: string; stage: string; round: number; specRev: number; head: string | null; branch: string | null; lastSeq: number;
  intents: string[]; orders: string[]; lease: string | null; author: string | null; trigger: string;
  /** Digest of the spec text (null = unreadable): an edited spec (manual / local-only / superseded) voids the plan. */
  spec: string | null;
  /** The local write grant as read (agents / localPriority / localAuthorRuntime / localFamilies / mode / maxWorkers). */
  grant: string;
  /** Other cards' file locks overlapping this card's globs (empty when the plan is eligible). */
  locks: string[];
  /** Slot / quota proofs, the outbound ban and the unpushed work the plan was built on. */
  proofs: string;
}

type Trigger = { kind: "gate_refused"; seq: number; material: string; reason: string } | { kind: "peer_unavailable"; reason: string };

interface Step { op: "revalidate" | "end_write_lease" | "bind_local_author" | "dispatch_work" | "independent_review"; params: Record<string, unknown> }

export interface EligiblePlan {
  kind: "eligible";
  key: string;
  basis: PlanBasis;
  role: "write" | "fix";
  trigger: Trigger;
  /** The incumbent author family stays; review must come from the other family, as an independent ticket. */
  exec: { machine: "local"; family: "codex"; authorFamily: AuthorFamily; workflowMode: "auto" };
  review: { family: AuthorFamily; independent: true; crossModelFrom: AuthorFamily };
  preserve: { taskId: string; specRev: number; round: number; head: string | null; branch: string | null; spec: string | null;
    leaseBranch: string | null; author: WorkerRef | null; unpushed: readonly ArtifactRef[] };
  steps: Step[];
}
interface BlockedPlan { kind: "blocked"; key: string; basis: PlanBasis; code: BlockCode; reasons: string[]; diag?: string }
export type Assessment = EligiblePlan | BlockedPlan;
/** observe: what on would do, recorded only; FB2 must not execute it. */
export type LocalFallbackPlan = Assessment | { kind: "observe"; key: string; would: Assessment; diag: string | null };

const LIVE_INTENT = ["pending", "submitted", "unknown"];
const ENDED_ORDER = ["cancelled", "released"];

const windowOf = (s: PlannerSnapshot): number =>
  s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? s.events.find((e) => e.kind === "task")?.seq ?? 0;

const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

function basisOf(f: LocalFallbackFacts, trigger: string): PlanBasis {
  const s = f.snapshot, t = s.task, r = s.pool?.remote ?? null;
  return { taskId: t.id, stage: t.stage, round: t.round, specRev: t.specRev, head: t.headSHA ?? null, branch: t.branch ?? null,
    lastSeq: s.events.at(-1)?.seq ?? 0, intents: s.intents.map((i) => `${i.id}:${i.status}`),
    orders: f.orders.map((o) => `${o.orderId}:${o.status}:${o.leaseGen}`),
    lease: f.lease ? `${f.lease.peer}:${f.lease.branch}:${f.lease.state}` : null,
    author: s.author ? `${s.author.agent}:${s.author.sessionId}:${s.author.source}` : null, trigger, locks: lockConflicts(s),
    spec: f.specText === null ? null : digest(f.specText),
    grant: digest(r && [r.mode, r.agents ?? null, r.localPriority ?? null, r.localAuthorRuntime ?? null, r.localFamilies ?? null, s.maxWorkers]),
    proofs: digest([f.slot, f.quota, f.outboundBan ?? null, f.unpushed ?? []]) };
}

/**
 * The card's file globs against every lock another card holds, the planner's own resource rule (resourceKey + resourcesOverlap,
 * as scheduler-plan's resourceGate and placement's locksFree). An unparseable or missing glob is a conflict: nothing can be locked.
 */
function lockConflicts(s: PlannerSnapshot): string[] {
  const mine = s.fileGlobs.map(resourceKey);
  if (!mine.length || mine.includes(null)) return [`本卡文件范围无法加锁（${JSON.stringify(s.fileGlobs)}）`];
  return s.heldResources.filter((h) => h.taskId !== s.task.id &&
    mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())))
    .map((h) => `${h.resource}@${h.taskId}`).sort();
}

const keyOf = (b: PlanBasis, extra: unknown): string => createHash("sha256").update(JSON.stringify([b, extra])).digest("hex").slice(0, 24);

/** Which takeover trigger the planner's own decision is, or why it is none (capacity, in flight, dispatchable, PM…). */
function triggerOf(s: PlannerSnapshot, d: PlannerDecision): Trigger | string {
  const { category } = explainWithBlock(s, d);
  if (category === "security_material") {
    const b = gateBlock(s.task, s.events);
    return b?.state === "blocked" ? { kind: "gate_refused", seq: b.seq, material: b.material, reason: b.reason } : "外发闸阻塞不在 blocked 态";
  }
  if (category === "peer_unavailable" && d.kind === "wait") return { kind: "peer_unavailable", reason: d.reason };
  return `调度类别 ${category}，不是外发闸拒收或无可安全投递 peer`;
}

/** Owner / PM holds first: a provider safety refusal, a frozen queue, a superseded or manual-acceptance spec. */
function holdOf(f: LocalFallbackFacts): { code: BlockCode; why: string } | null {
  const s = f.snapshot;
  const refusal = openRefusal(s.events);
  if (refusal) return { code: "safety_hold", why: `模型安全拒绝 / 已批准接续未结（#${refusal.seq}），只由 PM / owner 处置` };
  if (s.queueFrozen) return { code: "owner_hold", why: "项目队列冻结" };
  if (f.specText === null) return { code: "spec_unreadable", why: "规格读不到，无法排除冻结 / 限定" };
  const h = specHolds(f.specText);
  if (h.superseded) return { code: "owner_hold", why: `规格写明已被 ${h.superseded} 替代` };
  if (h.manual) return { code: "owner_hold", why: "规格写明人工验收" };
  if (h.localOnly || f.outboundBan) return { code: "private_ban", why: f.outboundBan ?? "规格本机限定：外派禁令不由接管改道" };
  return null;
}

/**
 * Proof that nothing of this window is out there: every intent of the window settled as cancelled, or a local dispatch never
 * made; every order of this card is cancelled / released (a done one is a result). pending / submitted / unknown intents and
 * pooled / claimed / unknown orders may have arrived, so they block — only a definite non-delivery or formal end counts.
 */
function deliveryGap(f: LocalFallbackFacts, since: number): { code: BlockCode; why: string } | null {
  const s = f.snapshot, t = s.task;
  const live = s.intents.filter((i) => i.causalSeq >= since && LIVE_INTENT.includes(i.status));
  if (live.length) return { code: "delivery_unproven", why: `意图 ${live.map((i) => `${i.id}（${i.status}）`).join("、")} 投递未确定` };
  const sent = s.intents.find((i) => i.causalSeq >= since && i.action === "dispatch" && i.status === "done" && !isPoolIntent(i));
  if (sent) return { code: "delivery_unproven", why: `意图 ${sent.id} 已投递给 ${sent.recipient}` };
  if (s.strayPoolOrders?.length) return { code: "delivery_unproven", why: `出借单 ${s.strayPoolOrders.join("、")} 没有意图对应` };
  const step = t.stage === "fix" ? "fix" : "write";
  const done = f.orders.find((o) => o.status === "done" && o.step === step && o.round === t.round && o.specRev === t.specRev);
  if (done) return { code: "result_exists", why: `出借单 ${done.orderId} 已有结果` };
  const open = f.orders.filter((o) => !ENDED_ORDER.includes(o.status) && o.status !== "done");
  if (open.length) return { code: "delivery_unproven", why: `出借单 ${open.map((o) => `${o.orderId}（${o.status}）`).join("、")} 未正式终止 / 释放` };
  return null;
}

/**
 * The project policy must already seat a local Codex writer; this never suggests adding one or switching model. localPriority
 * off is "this machine writes no code" (placement's tiers, recovery-plan-gap's localRoom), whatever pool shape; a legacy pool
 * with maxActiveWorkers 0 has no local worker at all.
 */
function grantGap(remote: RemotePolicy | null | undefined, maxWorkers: number): string | null {
  if (!remote) return "项目没有本机写位策略";
  if (remote.localPriority === "off") return "localPriority=off：本机不写代码";
  if (!remote.agents && maxWorkers <= 0) return "maxActiveWorkers=0：本机没有写作者";
  if (remote.agents) return localFamilyRefusal({ remote }, "write", "codex") ? "项目没给本机 Codex 写位" : null;
  return remote.localAuthorRuntime === "codex" && !localFamilyRefusal({ remote }, "write", "codex") ? null : "本机写作者不是 Codex";
}

/** Pure: same facts → same plan (and key); the caller passes the policy it read (localFallbackPolicy). */
export function assessLocalFallback(f: LocalFallbackFacts): Assessment {
  const s = f.snapshot, t = s.task;
  const trig = t.stage === "build" || t.stage === "fix" ? triggerOf(s, f.decision) : "不在开工 / 修复阶段";
  const basis = basisOf(f, typeof trig === "string" ? "-" : trig.kind === "gate_refused" ? `gate:${trig.seq}:${trig.material}` : "peer");
  const proofs = { slot: f.slot.ok, quota: f.quota.ok, ban: f.outboundBan ?? null, unpushed: f.unpushed ?? [] };
  const block = (code: BlockCode, ...reasons: string[]): BlockedPlan => ({ kind: "blocked", key: keyOf(basis, [code, proofs]), basis, code, reasons });
  if (!s.workflow || s.workflow.mode !== "auto") return block("not_auto", "不是 auto 卡：接管不改流程模式");
  if (t.stage !== "build" && t.stage !== "fix") return block("stage", `阶段 ${t.stage} 不是开工 / 修复`);
  const hold = holdOf(f);
  if (hold) return block(hold.code, hold.why);
  if (typeof trig === "string") return block("not_candidate", trig);
  // A lock wait is classified peer_unavailable by the placement view; moving the card to this machine does not free the lock.
  if (basis.locks.length) return block("lock_busy", `文件锁被别的卡占着：${basis.locks.join("、")}，本机接管同样受限`);
  const gap = deliveryGap(f, windowOf(s));
  if (gap) return block(gap.code, gap.why);
  const author = s.workflow.authorFamily;
  if (author !== "codex") return block("family_switch", `现任作者家族 ${author}，本机 Codex 接管会换模型`);
  const grant = grantGap(s.pool?.remote, s.maxWorkers);
  if (grant) return block("no_grant", grant);
  const missing = [...(f.slot.ok ? [] : [f.slot.why]), ...(f.quota.ok ? [] : [f.quota.why])];
  if (missing.length) return block(f.slot.ok ? "no_quota" : "no_slot", ...missing);
  const role = t.stage === "fix" ? "fix" : "write", lease = f.lease?.state === "held" ? f.lease : null;
  const steps: Step[] = [
    { op: "revalidate", params: { key: keyOf(basis, proofs), lastSeq: basis.lastSeq, taskRev: t.rev } },
    ...(lease ? [{ op: "end_write_lease" as const, params: { taskId: t.id, peer: lease.peer, branch: lease.branch, formal: "reclaimLend" } }] : []),
    { op: "bind_local_author", params: { taskId: t.id, family: "codex", transport: "local" } },
    { op: "dispatch_work", params: { taskId: t.id, role, specRev: t.specRev, round: t.round, head: t.headSHA ?? null, branch: t.branch ?? null } },
    { op: "independent_review", params: { family: "claude", notFamily: author } },
  ];
  return { kind: "eligible", key: keyOf(basis, proofs), basis, role, trigger: trig,
    exec: { machine: "local", family: "codex", authorFamily: author, workflowMode: "auto" },
    review: { family: "claude", independent: true, crossModelFrom: author },
    preserve: { taskId: t.id, specRev: t.specRev, round: t.round, head: t.headSHA ?? null, branch: t.branch ?? null, spec: t.spec ?? null,
      leaseBranch: f.lease?.branch ?? null, author: s.author, unpushed: f.unpushed ?? [] },
    steps };
}

/** Policy wrapper: off blocks with the diagnosis, observe wraps what on would do, on is the assessment itself. */
export function planLocalFallback(f: LocalFallbackFacts, port: LocalFallbackPolicyPort | undefined): LocalFallbackPlan {
  const policy = localFallbackPolicy(port, f.snapshot.task.project);
  const a = assessLocalFallback(f);
  if (policy.mode === "off") {
    return { kind: "blocked", key: keyOf(a.basis, "off"), basis: a.basis, code: "policy_off", reasons: ["本机接管策略 off"], ...(policy.diag ? { diag: policy.diag } : {}) };
  }
  return policy.mode === "observe" ? { kind: "observe", key: a.key, would: a, diag: policy.diag } : a;
}

export type StaleReason = keyof PlanBasis | "policy" | "eligibility";

/**
 * Why an old plan no longer stands, on facts FB2 re-reads inside its CAS transaction (snapshot, orders, lease, spec, and fresh
 * slot / quota proofs) and the policy port re-asked there: changed basis fields, the policy no longer on, or the fresh assessment
 * no longer eligible. Empty = every check passed again — never compare bases alone: a matching basis is not a re-assessment.
 */
export function staleBasis(old: PlanBasis, fresh: LocalFallbackFacts, port: LocalFallbackPolicyPort | undefined): StaleReason[] {
  const now = planLocalFallback(fresh, port);
  const basis = now.kind === "observe" ? now.would.basis : now.basis;
  const changed: StaleReason[] = (Object.keys(old) as (keyof PlanBasis)[]).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(basis[k]));
  if (now.kind === "observe" || (now.kind === "blocked" && now.code === "policy_off")) changed.push("policy");
  else if (now.kind !== "eligible") changed.push("eligibility");
  return changed;
}

/** The existing fact readers, composed: auto snapshot + planner decision + lend orders + write lease + spec text. */
export function readLocalFallbackFacts(db: Database, task: LedgerTask, opts: SnapshotOpts,
  proofs: Pick<LocalFallbackFacts, "slot" | "quota" | "outboundBan" | "unpushed">): LocalFallbackFacts {
  const snapshot = autoSnapshot(db, task, opts);
  const specText = readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir));
  return { snapshot, decision: planScheduler(snapshot), orders: listLendOrders(db, task.id), lease: getWriteLease(db, task.id), specText, ...proofs };
}
