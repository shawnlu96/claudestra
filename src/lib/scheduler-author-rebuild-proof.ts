/**
 * AREB1's one set of predicates, shared by the scheduler before any effect, the local-author launch guard and the ledger writer's
 * transaction (scheduler-local-author*.ts call these; none copies them):
 * - authorRetireProof: the card's author is gone because LIFE1 formally retired it. Read only from the lifecycle's history reader
 *   (agent-lifecycle-store workerRetireHistory / activeWorkers / pendingCleanups), the card's events and its session binding.
 *   Absence from the registry is never taken as proof.
 * - rebuildAgentName: the next-generation author name, the same on both ends, never the replaced one.
 * - rebuildAllowed: proof + the card still names the replaced author + the workflow's own author family.
 * - rebuildBranchHeld / rebuildCheckoutDrift: the retired author's branch is checked out again only when provably free and exactly the base.
 */
import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { activeWorkers, pendingCleanups, workerRetireHistory } from "./agent-lifecycle-store.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import type { Git } from "./scheduler-review-worktree.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

export type RetireProof = { kind: "retired"; agent: string; sessionId: string; retireSeq: number; registerSeq: number } | { kind: "none"; why: string };

function proof(db: Database, taskId: string, agent: string): RetireProof {
  const history = workerRetireHistory(db, taskId).filter((h) => h.agent === agent);
  const retire = history.filter((h) => h.op === "worker_retire" && !h.retry).at(-1);
  if (!retire) return { kind: "none", why: `本卡没有 ${agent} 的收回记录` };
  if (retire.role !== "author") return { kind: "none", why: `${agent} 的收回记录角色是 ${String(retire.role)}` };
  if (retire.actor !== "scheduler" || !retire.sessionId) return { kind: "none", why: `${agent} 的收回记录不是调度服务正式写的` };
  const reg = history.filter((h) => h.op === "worker_register" && h.seq < retire.seq).at(-1);
  if (!reg || reg.sessionId !== retire.sessionId || reg.role !== "author") return { kind: "none", why: `${agent} 的收回记录与本卡作者登记的会话对不上` };
  if (history.some((h) => h.op === "worker_register" && h.seq > retire.seq)) return { kind: "none", why: `${agent} 收回后又登记过` };
  if (activeWorkers(db).some((w) => w.agent === agent || (w.taskId === taskId && w.role === "author"))) return { kind: "none", why: `${agent} 或本卡另一作者仍在登记中` };
  if (pendingCleanups(db).some((c) => c.agent === agent)) return { kind: "none", why: `${agent} 还有没补清的现场` };
  const bound = getSchedulerSession(db, taskId, "author");
  if (bound && bound.state !== "retired" && (bound.transport === "peer" || bound.agent !== agent)) return { kind: "none", why: `本卡作者绑定 ${bound.agent} 不是本机被收回的 ${agent}` };
  if (listEvents(db, { target: taskId, afterSeq: retire.seq }).some((e) => e.kind === "deliver")) return { kind: "none", why: `${agent} 收回后卡上又有交付` };
  return { kind: "retired", agent, sessionId: retire.sessionId, retireSeq: retire.seq, registerSeq: reg.seq };
}

export function authorRetireProof(db: Database, task: Pick<LedgerTask, "id" | "agent">): RetireProof {
  if (!task.agent) return { kind: "none", why: "卡上没有执行者" };
  try { return proof(db, task.id, task.agent); }
  catch (e) { return { kind: "none", why: `读不了收回记录：${String((e as Error).message ?? e).slice(0, 200)}` }; }
}

const MAX_NAME = 48; // manager create's limit on the name without its agent- prefix
/**
 * The card author's registry name, shared by the plan and the ledger writer: no replaces = start_node's default; a rebuild = the
 * untruncated default with the next generation (-r<N+1> after <default>-rN, else -r2). null = no legal fresh name (too long, overflow).
 */
export function rebuildAgentName(taskId: string, replaces?: string): string | null {
  const bare = `task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  if (replaces === undefined) return `agent-${bare.slice(0, MAX_NAME)}`;
  const gen = replaces.startsWith(`agent-${bare}-r`) ? replaces.slice(`agent-${bare}-r`.length) : "";
  const n = /^[1-9]\d{0,15}$/.test(gen) ? Number(gen) : 1;
  const name = `${bare}-r${n + 1}`;
  return Number.isSafeInteger(n + 1) && name.length <= MAX_NAME && `agent-${name}` !== replaces ? `agent-${name}` : null;
}

/** Before create and inside the writer's transaction: the same formal retire, the card still names it, the workflow's family. */
export function rebuildAllowed(db: Database, task: Pick<LedgerTask, "id" | "agent">, replaces: string, family: string): string | null {
  const p = authorRetireProof(db, task);
  if (p.kind !== "retired") return p.why;
  if (p.agent !== replaces) return `卡上执行者已不是 ${replaces}`;
  if (!rebuildAgentName(task.id, replaces)) return `${replaces} 之后形成不了合法的新作者名`;
  const wf = getWorkflow(db, task.id);
  return wf?.authorFamily === family ? null : `作者家族 ${family} 不是流程的 ${wf?.authorFamily ?? "（无）"}`;
}

/** true = provably nothing there (a dangling symlink is something); a string = could not tell. */
const absent = (path: string): boolean | string => {
  try { lstatSync(path); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? true : `读不了 ${path}：${(e as Error).message}`; }
};

/**
 * The retired author's branch is still in the repo. It may be checked out again (worktree add without -b) only when its full OID is
 * the card's base, a parsed worktree list shows no holder, the target path provably does not exist and the old author owes no
 * cleanup. null = reusable; a reason = keep everything as is. Read only: never resets, prunes, forces or deletes.
 */
export async function rebuildBranchHeld(db: Database, git: Git, p: { branch: string; base: string; worktree: string }, replaces: string): Promise<string | null> {
  const ref = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}^{commit}`]), base = await git(["rev-parse", "--verify", `${p.base}^{commit}`]);
  if (ref.code !== 0 || base.code !== 0 || !/^[0-9a-f]{40,64}$/.test(ref.out.trim()) || ref.out.trim() !== base.out.trim()) return `分支 ${p.branch} 不在本卡起点 ${p.base}，保留并等待核对`;
  const list = await git(["worktree", "list", "--porcelain"]);
  const lines = list.out.split("\n");
  if (list.code !== 0 || !lines.some((l) => l.startsWith("worktree "))) return "读不了 worktree 列表，保留并等待核对";
  if (lines.includes(`branch refs/heads/${p.branch}`)) return `分支 ${p.branch} 仍被 worktree 占用，保留并等待核对`;
  const gone = absent(p.worktree);
  if (gone !== true) return gone || `目标目录 ${p.worktree} 已存在，保留并等待核对`;
  if (pendingCleanups(db).some((c) => c.agent === replaces)) return `旧作者 ${replaces} 还有待补清的现场，等清完再建`;
  return null;
}

/** After `worktree add <path> <branch>`: the checkout must still sit on that branch at exactly the base. */
export async function rebuildCheckoutDrift(git: Git, p: { branch: string; base: string; worktree: string }): Promise<string | null> {
  const [head, branch, base] = [await git(["-C", p.worktree, "rev-parse", "HEAD"]), await git(["-C", p.worktree, "symbolic-ref", "-q", "HEAD"]),
    await git(["rev-parse", "--verify", `${p.base}^{commit}`])];
  return head.code === 0 && branch.code === 0 && base.code === 0 && head.out.trim() === base.out.trim() && branch.out.trim() === `refs/heads/${p.branch}`
    ? null : `重建作者的 checkout ${p.worktree} 不在 ${p.branch}@${p.base}，保留现场等待核对`;
}

/**
 * The checkout step of a rebuild (scheduler-local-author.ts checkout): an existing branch is re-checked right before the add and the
 * result after it. Returns null when the caller may add (existing = reuse the branch without -b), or a reason to keep everything.
 */
export async function rebuildBranchGate(db: Database, git: Git, p: { branch: string; base: string; worktree: string }, replaces: string | undefined,
  existing: boolean): Promise<string | null> {
  if (!existing) return null;
  return replaces ? rebuildBranchHeld(db, git, p, replaces) : `分支 ${p.branch} 已存在，保留并等待核对`;
}
