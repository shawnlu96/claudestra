/**
 * agent-list-recovery-LENDBACK1 · a lent write order (fix included) that ends with nothing started comes back to this machine in
 * one go, instead of waiting on a pin, a tried peer and a stale registry row. Switch: recovery key `lendReturnLocal` (default on;
 * `ledger scheduler-recovery <project> off --key lendReturnLocal --reason ...` puts all of it back word for word).
 * - Send-back (ledger-lend.ts sendBack — reached only by not_started and the unclaimed timeout, never by a release with work):
 *   a placement pinned on that peer is dropped, and a restored local agent comes back only when it is bound to this card's author
 *   session in the card's author family; otherwise tasks.agent is cleared. observe = unchanged, one sample per order.
 * - Placement (scheduler-agent-pool.ts): a pin whose peer is already tried this round says so in the wait reason.
 * - Local author create (scheduler-local-author.ts): the planner's family is kept when it is fixed by the delivered head (the
 *   snapshot's own remoteHeadFamily); a stale same-name registry row (stopped, not bound here, other family or never started) gets
 *   the next rebuildAgentName instead of an unknown; its own clean, off-branch checkout gets a path with the same -rN suffix.
 * tests/lend-return-local.test.ts, tests/scheduler-local-author.test.ts, tests/scheduler-create-retry-worktree.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { WriteLease } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";
import { leaseRestore, type LeaseRestore } from "./lend-send-back-restore.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { RegistryAgent } from "./registry.js";
import { absent, rebuildAgentName } from "./scheduler-author-rebuild-proof.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { Git } from "./scheduler-review-worktree.js";

export const LEND_RETURN_LOCAL_KEY = "lendReturnLocal" as const;

/** Read-only mode (placement and launch): no default-on note, an unknown answer is off. */
export function lendReturnLocalMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    const mode = policy(project, LEND_RETURN_LOCAL_KEY).mode;
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch { return "off"; }
}

type Order = { orderId: string; taskId: string; project: string; peer: string };
const family = (runtime: string | undefined): AuthorFamily => runtime === "codex" ? "codex" : "claude";

/** The family the card's author must be in: a peer-delivered head's (as the planner snapshot sets it), else the workflow's. */
function cardAuthorFamily(db: Database, task: Pick<LedgerTask, "id" | "project" | "headSHA">): AuthorFamily | null {
  return remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)?.authorFamily ?? null;
}

/** Local author bindings of this card for `agent` (any state): the families its sessions ran in. */
function boundFamilies(db: Database, taskId: string, agent: string): AuthorFamily[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()) return [];
  return (db.query("SELECT family FROM scheduler_sessions WHERE taskId = ? AND role = 'author' AND agent = ? AND transport != 'peer'")
    .all(taskId, agent) as { family: AuthorFamily }[]).map((r) => r.family);
}

/** What the new rule would restore: the pin on `peer` dropped; a local agent kept only when bound here in the card's family. */
function returnRestore(db: Database, task: LedgerTask, lease: WriteLease | null, peer: string): LeaseRestore | null {
  const r = leaseRestore(task, lease, peer);
  const agent = r?.restored?.assigneeKind === "agent" ? r.restored.assignee : null;
  if (!r || !agent) return r;
  const want = cardAuthorFamily(db, task);
  if (!want || boundFamilies(db, task.id, agent).includes(want)) return r;
  const { agent: _dropped, ...rest } = r.patch;
  return { ...r, patch: { ...rest, assigneeKind: null, assignee: null }, restored: { assigneeKind: null, assignee: null } };
}

/**
 * sendBack's restore. `unpin` is the old rule's answer (grant gone / runtime cooled); off keeps exactly that. The caller applies
 * the patch in its own transaction, as it did with leaseRestore.
 */
export function lendReturnLocal(db: Database, o: Order, task: LedgerTask, lease: WriteLease | null, unpin: boolean, now: number,
  policy: RecoveryPolicyPort = recoveryPolicy): LeaseRestore | null {
  const legacy = leaseRestore(task, lease, unpin ? o.peer : undefined);
  const a = { project: o.project, mechanism: LEND_RETURN_LOCAL_KEY } as const;
  const kind = decideRecovery(noteDefaultOn(db, a, policy(o.project, LEND_RETURN_LOCAL_KEY), now)).kind;
  if (kind === "skip") return legacy;
  const next = returnRestore(db, task, lease, o.peer);
  if (kind === "act") return next;
  if (JSON.stringify(next) !== JSON.stringify(legacy)) {
    try {
      recordObserved(db, { project: o.project, mechanism: LEND_RETURN_LOCAL_KEY, target: o.taskId, actionKey: `send-back:${o.orderId}`,
        action: `退回本机：解钉 ${next?.unpinned ?? "（无）"}，执行者 ${next?.restored?.assignee ?? "清空"}`,
        data: { lend: { orderId: o.orderId, peer: o.peer }, unpinned: next?.unpinned ?? null, restored: next?.restored ?? null } }, now);
    } catch (e) { console.error(`[lend] ${LEND_RETURN_LOCAL_KEY} 观察样本没记上（${(e as Error).message}）`); }
  }
  return legacy;
}

/** placeAgentPool's wait note for a pin already tried this round; null = the old `固定 X` text. */
export function pinTriedNote(project: string | undefined, pin: string, tried: readonly string[],
  policy: RecoveryPolicyPort = recoveryPolicy): string | null {
  if (!project || !tried.includes(pin)) return null;
  return lendReturnLocalMode(project, policy) === "on" ? `钉位 ${pin} 本轮已试过` : null;
}

/**
 * The family the planner asked for in this ensure (the claim receipt `claimed; ensure author <family>`), when the planner took
 * it from the delivered head (remoteHeadFamily, the snapshot's own source). null = no fixed family: launch picks as before.
 */
export function plannedAuthorFamily(db: Database, task: Pick<LedgerTask, "id" | "project" | "headSHA">, intent: Pick<SchedulerIntent, "receipt">): AuthorFamily | null {
  const asked = /^claimed; ensure author (claude|codex)(?:;|$)/.exec(intent.receipt ?? "")?.[1] as AuthorFamily | undefined;
  return asked && remoteHeadFamily(db, task) === asked ? asked : null;
}

/**
 * A same-name registry row that must not hold the name: stopped, bound to none of this card's sessions, and in another family
 * than the author being created or never started (no session id). Anything else keeps today's "已存在但未绑定" wait.
 */
export function staleAuthorRow(db: Database, taskId: string, row: RegistryAgent | undefined, want: AuthorFamily): boolean {
  if (!row || row.status !== "stopped") return false;
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()
    && db.query("SELECT 1 FROM scheduler_sessions WHERE taskId = ? AND (agent = ? OR sessionId = ?) LIMIT 1").get(taskId, row.name, row.sessionId ?? "")) return false;
  return family(row.runtime) !== want || !row.sessionId;
}

/**
 * The writer's expected author name (scheduler-local-author-write.ts) with no `replaces`: start_node's default, or with the switch
 * on the first name past a chain of stale rows that is `agent` itself — the same walk freshAuthorPlan made. Off = the default.
 */
export function freshAuthorName(db: Database, task: Pick<LedgerTask, "id" | "project">, agent: string, row: (agent: string) => RegistryAgent | undefined,
  want: AuthorFamily): string | null {
  const first = rebuildAgentName(task.id);
  if (lendReturnLocalMode(task.project) !== "on") return first;
  let name = first;
  for (let n = 0; n < 9 && name; n++) {
    if (name === agent) return name;
    if (!staleAuthorRow(db, task.id, row(name), want)) return first;
    name = rebuildAgentName(task.id, name);
  }
  return first;
}

/**
 * The stale executor's checkout at the card's path may be stepped around (never removed): it is that executor's (registry cwd),
 * off the card's branch, clean (ignored files do not count) and has no commit of its own against main. null = keep today's path.
 */
export async function staleTreeAside(git: Git, p: { worktree: string; branch: string; localMerge?: boolean }, owner: RegistryAgent, suffix: string): Promise<string | null> {
  if (owner.cwd !== p.worktree || absent(p.worktree) !== false) return null;
  const aside = `${p.worktree}${suffix}`;
  if (absent(aside) !== true) return null;
  const at = (args: string[]) => git(["-C", p.worktree, ...args]);
  const branch = await at(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code === 0 && branch.out.trim() === p.branch) return null;
  const st = await at(["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (st.code !== 0 || st.out.trim() !== "") return null;
  const own = await at(["rev-list", "--count", `${p.localMerge ? "main" : "origin/main"}..HEAD`]);
  return own.code === 0 && own.out.trim() === "0" ? aside : null;
}

type NamedPlan = { agent: string; agentName: string; worktree: string; branch: string; promptText: string; localMerge?: true };
/**
 * Create's name and path when the plan's name is held by a stale row: the next rebuildAgentName that is free, and the stale
 * executor's own checkout stepped around with the same suffix. null = nothing to change (today's checks follow as before).
 */
export async function freshAuthorPlan<P extends NamedPlan>(db: Database, taskId: string, p: P, want: AuthorFamily,
  row: (agent: string) => RegistryAgent | undefined, git: Git): Promise<P | null> {
  const first = row(p.agent);
  if (!first || !staleAuthorRow(db, taskId, first, want)) return null;
  let from = p.agent;
  for (let n = 0; n < 8; n++) {
    const next = rebuildAgentName(taskId, from);
    if (!next) return null;
    const nextRow = row(next);
    if (!nextRow) {
      const suffix = /-r\d+$/.exec(next)?.[0];
      const aside = suffix ? await staleTreeAside(git, p, first, suffix) : null;
      // the prompt names the checkout path; a stepped-around path is the same text with the suffix
      return { ...p, agent: next, agentName: next.slice("agent-".length),
        ...(aside ? { worktree: aside, promptText: p.promptText.split(p.worktree).join(aside) } : {}) };
    }
    if (!staleAuthorRow(db, taskId, nextRow, want)) return null;
    from = next;
  }
  return null;
}
