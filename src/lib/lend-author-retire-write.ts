/** Only this writer changes the proven peer binding; its callers already have the external head sample. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getMeta, getTask, LedgerError } from "./ledger-store.js";
import type { RecoveryPolicyPort, ObservedAction } from "./recovery-policy.js";
import type { appendEvent } from "./ledger-write.js";
import { lendAuthorBasis, lendAuthorFence, proveLendAuthorRetire, type LendAuthorSample } from "./lend-author-retire-proof.js";
import type { LedgerTask } from "./ledger-stages.js";
import { lendAuthorBinding, lendAuthorLease } from "./lend-author-retire-state.js";

export const lendAuthorAction = (f: Pick<LendAuthorSample, "taskId" | "sessionId">) => ({
  mechanism: "lendAuthorRebuild" as const, target: f.taskId, actionKey: `retire:${createHash("sha256").update(f.sessionId).digest("hex")}`,
  action: `退役写租约已结束的 peer 作者绑定，交本机接修复`, data: { sessionId: f.sessionId },
});
export interface LendAuthorWritePorts {
  transaction<T>(db: Database, fn: () => T): T;
  policy: RecoveryPolicyPort;
  manager(db: Database, actor: string, task: LedgerTask): boolean;
  append(db: Database, ctx: WriteCtx, draft: Parameters<typeof appendEvent>[2]): ReturnType<typeof appendEvent>;
  observe(db: Database, action: ObservedAction, now: number): { recorded: boolean; seq: number };
  update(db: Database, ctx: WriteCtx, task: LedgerTask, patch: Record<string, unknown>): number;
}

function forbidden(db: Database, ctx: WriteCtx, task: LedgerTask, ports: LendAuthorWritePorts): boolean {
  return ctx.actor !== "scheduler" && (ctx.actor === getMeta(db, task.project).team?.dispatcher || !ports.manager(db, ctx.actor, task));
}

function blocked(db: Database, ctx: WriteCtx, task: LedgerTask, f: LendAuthorSample, reason: string, ports: LendAuthorWritePorts): void {
  const key = createHash("sha256").update(JSON.stringify([task.id, f.sessionId, f.rev, reason])).digest("hex");
  ports.append(db, { ...ctx, dedupKey: `lend-author-blocked:${key}` }, { project: task.project, target: task.id, kind: "note", text: reason,
    data: { op: "lend_author_blocked", sessionId: f.sessionId, rev: f.rev } });
}

export function retireLendAuthor(db: Database, ctx: WriteCtx, f: LendAuthorSample,
  ports: LendAuthorWritePorts): { ok: boolean; reason?: string; seq?: number } {
  return ports.transaction(db, () => {
    const task = getTask(db, f.taskId);
    if (!task) throw new LedgerError("not_found", "没有本卡");
    if (forbidden(db, ctx, task, ports)) {
      throw new LedgerError("forbidden", "退役 peer 作者要调度服务 / PM / master / owner");
    }
    const mode = ports.policy(task.project, "lendAuthorRebuild").mode;
    if (mode === "off") return { ok: false, reason: "off" };
    const proof = proveLendAuthorRetire(db, f, mode === "observe");
    if (!proof.ok) {
      blocked(db, ctx, task, f, proof.reason, ports);
      return proof;
    }
    if (mode === "observe") {
      const r = ports.observe(db, { project: task.project, ...lendAuthorAction(f) }, ctx.now ?? Date.now());
      return { ok: false, reason: "observe", seq: r.seq };
    }
    const patch: Record<string, unknown> = {}, cleared: string[] = [];
    const lease = lendAuthorLease(db, task.id);
    if (task.assigneeKind === "peer_agent" && lease && task.assignee?.startsWith(`${lease.fp}/`)) {
      Object.assign(patch, { agent: null, assigneeKind: null, assignee: null }); cleared.push("peer_assignee");
    }
    if (task.agent === proof.binding.agent) { Object.assign(patch, { agent: null, assigneeKind: null, assignee: null }); cleared.push("agent"); }
    if (task.extra.placement === `peer:${proof.peer}`) {
      patch.extra = Object.fromEntries(Object.entries(task.extra).filter(([k]) => k !== "placement")); cleared.push("placement");
    }
    const rev = cleared.length ? ports.update(db, ctx, task, patch) : task.rev;
    const e = ports.append(db, { ...ctx, dedupKey: `lend-author-retire:${createHash("sha256").update(JSON.stringify([task.id, f.sessionId])).digest("hex")}` },
      { project: task.project, target: task.id, kind: "note", text: "写租约已结束，退役已核实的 peer 作者绑定，本机接修复", data: { op: "lend_author_retire", sessionId: f.sessionId,
        agent: proof.binding.agent, peer: proof.peer, specRev: task.specRev, head: task.headSHA, rev, cleared } });
    db.query("UPDATE scheduler_sessions SET state='retired', retireIntentId=NULL, updatedAt=? WHERE taskId=? AND role='author' AND sessionId=? AND state!='retired'")
      .run(e.event.ts, task.id, f.sessionId);
    return { ok: true, seq: e.event.seq };
  });
}

/** The lease writer may restore the assignee once; any other revision change makes its earlier sample unusable. */
export function retireAfterLeaseEnd(db: Database, ctx: WriteCtx, before: LedgerTask, restored: boolean,
  beforeBasis: string, ports: LendAuthorWritePorts, sample?: LendAuthorSample): ReturnType<typeof retireLendAuthor> | undefined {
  if (ports.policy(before.project, "lendAuthorRebuild").mode === "off") return { ok: false, reason: "off" };
  const current = getTask(db, before.id), s = lendAuthorBinding(db, before.id);
  if (!current || !s || s.transport !== "peer" || s.state === "retired") return;
  const f = { ...lendAuthorFence(current, s), basis: lendAuthorBasis(db, before.id), heads: [] };
  if (forbidden(db, ctx, current, ports)) {
    blocked(db, ctx, current, f, "身份不符：退役 peer 作者要调度服务 / PM / master / owner", ports);
    return { ok: false, reason: "forbidden" };
  }
  // Bridge expiry sweeps supply no sample: leave both retirement and its proof notes to the scheduler.
  if (!sample) return { ok: false, reason: "no_sample" };
  const fence = sample && sample.basis === beforeBasis && sample.rev === before.rev && sample.specRev === before.specRev && sample.head === before.headSHA
    && current.rev === before.rev + Number(restored) && current.headSHA === before.headSHA && current.specRev === before.specRev;
  return retireLendAuthor(db, ctx, { ...f, ...(!fence ? { rev: -1 } : {}), heads: fence ? sample.heads : [] }, ports);
}
