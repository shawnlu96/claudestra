/**
 * REBOR2 read-only preparation: any canonical ended write lease may be adopted as terminal fact by a real PM.
 * Nothing here writes; the old lease, the old order's terminal status and its reason/time are only quoted.
 * Same-peer recovery leaves the old provider journal to the provider-side claim check; a different peer is accepted
 * only when the borrower ledger itself proves the old side never started or fully delivered. tests/lend-reborrow2-facts.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { mustTask } from "./ledger-checks.js";
import { getWriteLease } from "./ledger-lend-lease.js";
import { listLendOrders, type LendOrder } from "./ledger-lend.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { getLendPeer, peerCapacity } from "./ledger-lend-peers.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { listSteps } from "./ledger-steps.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { roleOf, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { isRealPmRole } from "./ledger-team-config.js";
import { lendBranch } from "./lend-git.js";
import type { BorrowEntry, LendFamily } from "./lend-config.js";
import { cooldownPeerSlots } from "./lend-peer-cooldown.js";
import { HELLO_FRESH_MS } from "./lend-wire-v2.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { reviewsAfterSwap } from "./scheduler-review-swap.js";
import { classifyModelOutcome } from "./scheduler-model-outcome.js";

const sha40 = /^[0-9a-f]{40}$/;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string): never => { throw new LedgerError("conflict", `终态接续：${message}`); };
const forbidden = (message: string): never => { throw new LedgerError("forbidden", `终态接续：${message}`); };

/**
 * How the borrower ledger proves the old provider side stopped. Only `never_claimed`, `not_started` and `delivered`
 * leave nothing unsubmitted on the old peer; `stopped` / `cancelled` need the same provider's own journal at claim.
 */
export type OldSideEnd = "never_claimed" | "not_started" | "delivered" | "stopped" | "cancelled";
const CROSS_PEER_ENDS: readonly OldSideEnd[] = ["never_claimed", "not_started", "delivered"];

export interface Reborrow2Target { peer: string; fp: string; repo: string; family: LendFamily }

const lendOf = (e: LedgerEvent) => e.data.lend as { op?: string; orderId?: string; peer?: string; reason?: string; gen?: number } | undefined;

/** Complete rows and all material events: any report, checkpoint or order update after preparation must fail the CAS. */
function readFacts(db: Database, taskId: string) {
  const task = mustTask(db, taskId);
  const events = listEvents(db, { project: task.project, target: taskId });
  const orders = listLendOrders(db, taskId).sort((a, b) => a.orderId.localeCompare(b.orderId));
  const intents = db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY id").all(taskId) as { status: string }[];
  const lease = getWriteLease(db, taskId), steps = listSteps(db, taskId), workflow = getWorkflow(db, taskId);
  return { task, events, orders, intents, lease, steps, workflow, authorFamily: remoteHeadFamily(db, task) };
}
type Raw = ReturnType<typeof readFacts>;

function oldSideEnd(prev: LendOrder, events: readonly LedgerEvent[]): OldSideEnd {
  const released = events.filter((e) => e.kind === "note" && lendOf(e)?.op === "release" && lendOf(e)?.orderId === prev.orderId);
  if (released.length > 1) conflict("原单有多条提供方报停记录");
  const r = released[0] ? lendOf(released[0])! : null;
  if (r && (r.peer !== prev.peer || r.gen !== prev.leaseGen)) conflict("提供方报停记录的 peer / 代数与原单不符");
  if (prev.leaseGen === 0 && !prev.worker && !r && prev.status !== "done") return "never_claimed";
  if (prev.status === "done") {
    if (!prev.receipt || prev.eventSeq === null || r) conflict("原单 done 却缺回执 / 入账事件");
    return "delivered";
  }
  if (r?.reason === "not_started") {
    if (prev.status !== "released" && prev.status !== "cancelled") conflict("原单报未启动但终态不符");
    return "not_started";
  }
  if (r?.reason === "stopped") return "stopped";
  if (prev.status === "released") conflict("原单 released 却没有提供方报停记录");
  return "cancelled";
}

/** Any model safety refusal on this card is out of scope: REBOR2 must never move refused work to another peer or model. */
function assertNoSafetyRefusal(raw: Raw, prev: LendOrder): void {
  const texts = [raw.lease?.reason ?? "", prev.reason ?? ""];
  const safetyEvent = raw.events.some((e) => e.data.cls === "safety" || String(e.data.op ?? "").startsWith("model_safety"));
  if (safetyEvent || texts.some((t) => t && classifyModelOutcome({ failure: { kind: "error", message: t } })?.cls === "safety")) {
    forbidden("本卡有模型安全拒绝记录，不能用终态接续换 peer / 模型续做");
  }
}

function previousOrder(raw: Raw): LendOrder {
  const { task, lease, orders } = raw;
  const ended = lease!;
  const writers = orders.filter((o) => o.step === "write" || o.step === "fix");
  if (writers.some((o) => o.createdAt > ended.updatedAt)) conflict("租约结束后已经签发过写单");
  const prev = writers.filter((o) => o.peer === ended.peer && o.branch === ended.branch).sort((a, b) => b.createdAt - a.createdAt || b.orderId.localeCompare(a.orderId))[0];
  if (!prev || prev.repo !== ended.repo || prev.specRev !== task.specRev || !["done", "cancelled", "released"].includes(prev.status)) {
    conflict("找不到与已结束租约同 peer / 分支 / 仓库 / 规格且已终态的原写单");
  }
  return prev!;
}

/** Same family keeps the old rule; a change needs a formal workflow epoch after the lease ended and a review not of that family. */
function authorFamily(raw: Raw, prev: LendOrder, requested: LendFamily, pms: readonly string[], meta: ReturnType<typeof getMeta>): { original: LendFamily; epochSeq: number | null } {
  const { task, workflow, events, lease } = raw;
  // The workflow may already carry the new epoch, so the original author comes from deliveries / the old order only.
  const original = (raw.authorFamily ?? prev.family) as LendFamily;
  if (original !== prev.family) conflict("现任作者家族与原写单不符");
  if (requested === original) {
    if (workflow?.specRev === task.specRev && workflow.authorFamily !== requested) conflict(`流程已正式改为 ${workflow.authorFamily}，须按新家族接续`);
    return { original, epochSeq: null };
  }
  const epoch = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow");
  if (!workflow || workflow.specRev !== task.specRev || workflow.authorFamily !== requested || !epoch || epoch.data.authorFamily !== requested ||
    epoch.data.specRev !== task.specRev || epoch.data.workflowRev !== workflow.rev || epoch.ts < lease!.updatedAt ||
    !isRealPmRole(roleOf(epoch.actor, task, pms as string[]), epoch.actor, meta.team)) {
    forbidden(`改作者家族 ${original}→${requested} 须先有租约结束后真实 PM 正式设的流程 family epoch`);
  }
  for (const r of reviewsAfterSwap(events)) {
    if (r.data.reviewerFamily !== "claude" && r.data.reviewerFamily !== "codex") forbidden("已有审查的家族认不出，证明不了换作者后仍是跨族审查");
    if (r.data.reviewerFamily === requested) forbidden(`已有审查由 ${requested} 做，不能再由 ${requested} 接写`);
  }
  return { original, epochSeq: epoch!.seq };
}

export type Reborrow2Facts = ReturnType<typeof captureReborrow2Facts>;

/** Capture before external I/O. The target peer may differ from the original; its branch is always its own lend branch. */
export function captureReborrow2Facts(db: Database, taskId: string, target: Reborrow2Target) {
  const raw = readFacts(db, taskId);
  const { task, lease, orders, steps, intents } = raw;
  if (task.stage !== "build" && task.stage !== "fix") conflict("卡不在 build / fix");
  if (!lease || lease.state !== "ended" || !lease.reason?.trim()) conflict("没有带结束原因的已结束写租约");
  const ended = lease!;
  if (ended.project !== task.project || ended.repo !== target.repo) conflict("仓库与原租约不符");
  // A card that never received a delivery has no branch yet; any recorded branch must be the original lease branch.
  if (task.branch !== null ? task.branch !== ended.branch : task.headSHA !== null) conflict("卡分支与原租约不符");
  if ((task.headSHA !== null && !sha40.test(task.headSHA)) || (task.stage === "fix" && !task.headSHA)) conflict("卡上没有可核对的原 head");
  if (orders.some((o) => LEND_LIVE.includes(o.status))) conflict("仍有活单或未知结果");
  if (steps.some((s) => s.state === "assigned") || intents.some((i) => ["pending", "submitted", "unknown"].includes(i.status))) conflict("仍有未结束的本机步骤或调度意图");
  const samePeer = target.peer === ended.peer;
  if (samePeer && target.fp !== ended.fp) forbidden("同 peer 实例指纹已变（错实例），不能当原出借方续做");
  const branch = lendBranch(task.id, target.fp);
  if (!branch || (samePeer && branch !== ended.branch) || (!samePeer && branch === ended.branch)) conflict("新出借分支与原分支关系不明确");
  const previous = previousOrder(raw);
  if (lendBranch(task.id, ended.fp) !== ended.branch) conflict("原租约实例指纹与分支不符");
  assertNoSafetyRefusal(raw, previous);
  const end = oldSideEnd(previous, raw.events);
  if (!samePeer && !CROSS_PEER_ENDS.includes(end)) forbidden(`原单结束方式 ${end} 只有原提供方 journal 能证明已停且检查点保全，不能换 peer`);
  const meta = getMeta(db, task.project);
  const family = authorFamily(raw, previous, target.family, meta.pms, meta);
  return { task, lease: ended, previous, end, target: { ...target, branch: branch! }, samePeer, family: target.family,
    originalFamily: family.original, epochSeq: family.epochSeq, fingerprint: digest(raw) };
}

/** Must run inside the canonical writer's BEGIN IMMEDIATE; it only reads and compares. */
export function assertReborrow2Cas(db: Database, prepared: Reborrow2Facts): void {
  if (!db.inTransaction) throw new LedgerError("invalid", "终态接续 CAS 必须在 canonical writer 的写事务内执行");
  const fresh = captureReborrow2Facts(db, prepared.task.id, { peer: prepared.target.peer, fp: prepared.target.fp, repo: prepared.target.repo, family: prepared.family });
  if (fresh.fingerprint !== prepared.fingerprint || digest(fresh) !== digest(prepared)) conflict("读取来源期间任务、材料、订单或租约发生变化");
}

/** Real PM, current borrow entry, the target peer's pinned instance, fresh hello, grant and capacity — re-read under the offer lock. */
export function assertReborrow2Authority(db: Database, facts: Reborrow2Facts, actor: string, borrow: BorrowEntry | null,
  pinnedFp: string | null, now: number, replay = false): void {
  const task: LedgerTask = mustTask(db, facts.task.id), { peer, repo, fp } = facts.target;
  const meta = getMeta(db, task.project);
  if (!isRealPmRole(roleOf(actor, task, meta.pms), actor, meta.team)) forbidden("只给真实 PM / master / owner");
  if (!borrow || borrow.peer !== peer || !borrow.projects.includes(task.project) || !borrow.roles.includes("write") || borrow.priority === "off") {
    forbidden("borrow 未授权本项目的写角色");
  }
  const hello = getLendPeer(db, peer);
  const protocol = !!hello && (facts.family === "claude" ? hello.proto === 3 : hello.proto === 2 || hello.proto === 3);
  if (!pinnedFp || pinnedFp !== fp || (borrow!.fp && borrow!.fp !== fp) || !hello || hello.fp !== fp || !protocol ||
    hello.helloAt > now || now - hello.helloAt > HELLO_FRESH_MS) forbidden("当前认证 peer 实例身份失读、漂移或 hello 过期");
  if (!hello!.grant?.roles.includes("write") || !hello!.grant.repos.includes(repo) || hello!.grant.until <= now) forbidden("peer 未授权写角色或本仓库");
  if (replay) return; // Returning the existing successor consumes no extra capacity.
  const cap = peerCapacity(db, peer, borrow!.maxOpen, now, { exceptTask: task.id, enforce: true });
  if (cap.why || !(cooldownPeerSlots(db, peer, cap.slots, now)[facts.family] > 0)) forbidden(`peer 无可用授权或容量：${cap.why ?? facts.family}`);
}
