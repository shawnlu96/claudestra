/** Read-only recovery preparation. These checks do not authorize an offer or restore a lease by themselves. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { mustTask } from "./ledger-checks.js";
import { getWriteLease } from "./ledger-lend-lease.js";
import { listLendOrders } from "./ledger-lend.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { getLendPeer, peerCapacity } from "./ledger-lend-peers.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { listSteps } from "./ledger-steps.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { roleOf } from "./ledger-stages.js";
import { isRealPmRole } from "./ledger-team-config.js";
import { lendBranch } from "./lend-git.js";
import type { BorrowEntry } from "./lend-config.js";
import { cooldownPeerSlots } from "./lend-peer-cooldown.js";
import { HELLO_FRESH_MS } from "./lend-wire-v2.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";

const sha40 = /^[0-9a-f]{40}$/;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string): never => { throw new LedgerError("conflict", `接回写租约：${message}`); };

/** Include complete rows and all material events: a report/checkpoint update must invalidate a prepared request too. */
function readFacts(db: Database, taskId: string) {
  const task = mustTask(db, taskId);
  return {
    task, lease: getWriteLease(db, taskId), orders: listLendOrders(db, taskId).sort((a, b) => a.orderId.localeCompare(b.orderId)),
    events: listEvents(db, { project: task.project, target: taskId }), workflow: getWorkflow(db, taskId), steps: listSteps(db, taskId),
    intents: db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY id").all(taskId) as { status: string }[],
    authorFamily: remoteHeadFamily(db, task),
  };
}

export type ReborrowFacts = ReturnType<typeof captureReborrowFacts>;

/** Capture before external I/O. A PM reclaim must name this exact ended projection, not just share a peer name. */
export function captureReborrowFacts(db: Database, taskId: string, peer: string, repo: string) {
  const facts = readFacts(db, taskId);
  const { task, lease, orders, events, workflow, steps, intents } = facts;
  if (task.stage !== "build" && task.stage !== "fix") conflict("卡不在 build / fix");
  if (!lease || lease.state !== "ended" || !lease.reason?.startsWith("PM 收回：")) conflict("没有 PM 收回的已结束写租约");
  const ended = lease!;
  if (ended.project !== task.project || ended.peer !== peer || ended.repo !== repo) conflict("peer / 仓库与原租约不符");
  if (task.branch !== ended.branch || lendBranch(task.id, ended.fp) !== ended.branch) conflict("卡分支或实例指纹与原租约不符");
  if ((task.headSHA !== null && !sha40.test(task.headSHA)) || (task.stage === "fix" && !task.headSHA)) conflict("卡上没有可核对的原 head");
  if (orders.some((o) => LEND_LIVE.includes(o.status))) conflict("仍有活单或未知结果");
  if (steps.some((s) => s.state === "assigned") || intents.some((i) => ["pending", "submitted", "unknown"].includes(i.status))) {
    conflict("仍有未结束的本机步骤或调度意图");
  }
  const reclaim = events.findLast((e) => e.kind === "note" && (e.data.lend as { op?: string } | undefined)?.op === "reclaim");
  const meta = getMeta(db, task.project);
  const reclaimedByPm = reclaim && isRealPmRole(roleOf(reclaim.actor, task, meta.pms), reclaim.actor, meta.team);
  const link = reclaim?.data.lend as { peer?: string; orderId?: string; cancelled?: string } | undefined;
  if (!reclaim || link?.peer !== peer || reclaim.ts !== ended.updatedAt || !reclaimedByPm) conflict("缺少匹配的 PM 收回事件");
  const writers = orders.filter((o) => o.step === "write" || o.step === "fix").sort((a, b) => b.createdAt - a.createdAt);
  const previous = link?.cancelled ? writers.find((o) => o.orderId === link.cancelled) : writers[0];
  if (!previous || previous.peer !== peer || previous.repo !== repo || previous.branch !== ended.branch || previous.createdAt > reclaim!.ts ||
    previous.specRev !== task.specRev || (previous.status !== "done" && previous.status !== "cancelled" && previous.status !== "released")) {
    conflict("原订单与租约 / 收回事实不符");
  }
  if (link?.cancelled && (link.orderId !== previous!.orderId || previous!.status !== "cancelled")) conflict("收回事件没有绑定原撤单");
  if (writers.some((o) => o.createdAt > reclaim!.ts)) conflict("收回后已经签发过写单");
  const family = facts.authorFamily ?? (workflow?.specRev === task.specRev ? workflow.authorFamily : previous!.family);
  if (family !== previous!.family) conflict("作者家族与原写单不符");
  return { task, lease: ended, previous: previous!, reclaim: reclaim!, family, fingerprint: digest(facts) };
}

/** The caller must hold BEGIN IMMEDIATE through the canonical offer and evidence append; this function never writes. */
export function assertReborrowCas(db: Database, prepared: ReborrowFacts): void {
  if (!db.inTransaction) throw new LedgerError("invalid", "恢复 CAS 必须在 canonical writer 的写事务内执行");
  const fresh = captureReborrowFacts(db, prepared.task.id, prepared.lease.peer, prepared.lease.repo);
  if (fresh.fingerprint !== prepared.fingerprint || digest(fresh) !== digest(prepared)) conflict("读取来源期间任务、材料、订单或租约发生变化");
}

/** Run again under the offer lock, with freshly read contact/borrow facts from the official CLI. */
export function assertReborrowAuthority(db: Database, facts: ReborrowFacts, actor: string, borrow: BorrowEntry | null,
  pinnedFp: string | null, now: number, replay = false): void {
  const task = mustTask(db, facts.task.id), { peer, repo, fp } = facts.lease;
  const meta = getMeta(db, task.project);
  if (!isRealPmRole(roleOf(actor, task, meta.pms), actor, meta.team)) throw new LedgerError("forbidden", "接回写租约只给真实 PM / master / owner");
  if (!borrow || borrow.peer !== peer || !borrow.projects.includes(task.project) || !borrow.roles.includes("write") || borrow.priority === "off") {
    throw new LedgerError("forbidden", "borrow 未授权本项目的写角色");
  }
  const hello = getLendPeer(db, peer);
  const protocol = hello && (facts.family === "claude" ? hello.proto === 3 : hello.proto === 2 || hello.proto === 3);
  if (!pinnedFp || pinnedFp !== fp || (borrow.fp && borrow.fp !== fp) || hello?.fp !== fp || !hello ||
    !protocol || hello.helloAt > now || now - hello.helloAt > HELLO_FRESH_MS) {
    throw new LedgerError("forbidden", "当前认证 peer 身份失读、漂移或 hello 过期");
  }
  if (!hello.grant?.roles.includes("write") || !hello.grant.repos.includes(repo) || hello.grant.until <= now) throw new LedgerError("forbidden", "peer 未授权写角色或本仓库");
  if (replay) return; // Returning the existing order consumes no extra capacity, including when it occupies the last slot.
  const cap = peerCapacity(db, peer, borrow.maxOpen, now, { exceptTask: task.id, enforce: true });
  if (cap.why || !(cooldownPeerSlots(db, peer, cap.slots, now)[facts.family] > 0)) throw new LedgerError("forbidden", `peer 无可用授权或容量：${cap.why ?? facts.family}`);
}
