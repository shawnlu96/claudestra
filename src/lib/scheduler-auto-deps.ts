import { localEnsure, localCreateGuard } from "./scheduler-local-runtime-start.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "./scheduler-local-author.js";
/**
 * Production wiring of the auto tick: ledger writes through the scheduler-identity CLI, adapters chosen from the
 * registry, the author taken from the card (or created locally when unassigned), and the per-card
 * cross-family reviewer created through `manager create` in its own detached worktree of the author's repository. Anything the engine
 * cannot prove (no session id yet, create timed out) is "unknown" and stops for PM rather than being created twice.
 */
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveBunPath } from "./bun-path.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { boundRef, type AutoTickDeps } from "./scheduler-auto-tick.js";
import { acpPort, messagePort, type RegistryRow, type StillActive } from "./scheduler-auto-ports.js";
import { runtimeFamily } from "./scheduler-auto-review.js";
import { existingAuthorIdentity } from "./scheduler-existing-author.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { peerPrHeadMissing, peerPrRepoDir } from "./peer-pr-hold.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
import { openCreateReviewWorktree, retryCleanCreate } from "./scheduler-create-retry.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { git as realGit, gitDirtySync, pinReviewWorktree, type Git } from "./scheduler-review-worktree.js";
import { boundedGit, lendProjectDir, prepareReviewHead, type ReviewHeadEnv } from "./scheduler-review-head.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession, type SessionRole } from "./scheduler-sessions.js";
import { ledgerResult } from "./scheduler-work-order.js";
import { createAcpWorker } from "./worker-acp.js";
import { createChannelWorker, createTmuxFallbackWorker } from "./worker-message.js";
import type { AdapterDeps } from "./worker-ports.js";
import { selectWorkerRoute, type EnsureResult, type SessionRef, type WorkerSession } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

// Agent creation runs without the scheduler identity (which is limited to ledger commands); ledger writes use the service's.
// Both carry the service's lease, so a create still queued when the service stops or loses it builds nothing.
const plainManager = (lease: SchedulerLease | undefined): Manager => (...args) => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
  env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 180_000 });

export const reviewerName = (taskId: string): string => `agent-rv-${taskId.toLowerCase()}`;

function refOf(task: LedgerTask, role: SessionRole, row: RegistryAgent, family: AuthorFamily): EnsureResult {
  if (runtimeFamily(row.runtime) !== family) return { kind: "manual", reason: `${row.name} 的 runtime（${row.runtime ?? "claude-code"}）不是要求的 ${family} 家族` };
  if (!row.sessionId) return { kind: "unknown", reason: `${row.name} 还没有 session id` };
  const ref: SessionRef = { taskId: task.id, role, agent: row.name, sessionId: row.sessionId, family, transport: row.transport === "acp" ? "acp" : "tmux" };
  return { kind: "ready", ref, created: false };
}

/**
 * active throws SchedulerStopped once the service is stopping or lost its lease. It sits right against each effect: every
 * git subprocess runs through `git` (checked before the spawn and after the exit), and a bridge frame asks `alive` in the
 * same synchronous block as the send.
 */
interface Env extends LocalAuthorEnv, ReviewHeadEnv { alive: StillActive }
const checkoutOf = (env: Env, taskId: string): string => join(env.worktreeRoot, `rv-${taskId.toLowerCase()}`);
const realOr = (p: string): string => { try { return realpathSync.native(p); } catch { return p; /* not there yet: compare as written */ } };

async function createReviewer(env: Env, task: LedgerTask, family: AuthorFamily): Promise<EnsureResult> {
  const { db, registryRow } = env;
  const author = boundRef(db, task.id, "author");
  const authorDir = peerPrRepoDir(task) ?? (author && registryRow(author.agent)?.cwd) ?? lendProjectDir(env, task); // no network: a reused checkout is checked for tracked edits before any fetch
  if (!authorDir) return { kind: "manual", reason: "找不到执行者的工作目录，建不了审查 session" };
  const checkout = checkoutOf(env, task.id), reuse = existsSync(checkout);
  const absent = task.headSHA ? await prepareReviewHead(env, task, task.headSHA, reuse ? checkout : authorDir, reuse) : null;
  if (absent) return { kind: "manual", reason: absent };
  const opened = await openCreateReviewWorktree(db, task, authorDir, checkout, env.git);
  if ("held" in opened) return { kind: "unknown", reason: opened.held };
  if ("manual" in opened) return { kind: "manual", reason: opened.manual };
  const dir = opened.dir;
  const name = reviewerName(task.id);
  const runtime = family === "codex" ? ["--runtime", "codex", "--transport", "acp"] : [];
  const r = await whileOwned(env.active, () => env.create("create", name, dir, "--purpose", `${task.id} 跨模型对抗式审查（调度引擎建）`,
    "--project", task.project, "--task", `${task.id} 审查`, ...runtime));
  if (r.code === "lease-lost") throw new SchedulerStopped(`manager create: ${String(r.error)}`); // 服务在停，不是建失败：不交 PM
  if (r.ok !== true) return { kind: "unknown", reason: `建 ${name} 失败或结果不明：${String(r.error ?? "")}`.slice(0, 400) };
  for (let i = 0; i < 30; i++) {
    env.active();
    const row = registryRow(name);
    if (row?.sessionId) {
      const got = refOf(task, "reviewer", row, family);
      return got.kind === "ready" ? { ...got, created: true } : got;
    }
    await Bun.sleep(3000);
  }
  return { kind: "unknown", reason: `${name} 已建，90 秒内没等到 session id` };
}

/**
 * The card's named author is found, never created, so it takes no creation seat: missing, wrong family, proven identity
 * or a proven conflict answer here; null = the row lacks identity fields and the full new-session gate still applies.
 */
async function existingAuthor(env: Env, task: LedgerTask, family: AuthorFamily): Promise<EnsureResult | null> {
  const row = task.agent ? env.registryRow(task.agent) : undefined;
  if (!row || runtimeFamily(row.runtime) !== family) return ensure(env, task, "author", family);
  const bound = getSchedulerSession(env.db, task.id, "author");
  if (bound && bound.state !== "retired" && (bound.agent !== row.name || bound.sessionId !== row.sessionId)) {
    return { kind: "unknown", reason: `本卡已绑定另一个作者 session（${bound.agent}/${bound.sessionId}），不换会话` };
  }
  const id = await existingAuthorIdentity(task, row, family, env.git);
  if (id.kind === "unproven") return null;
  return id.kind === "conflict" ? { kind: "unknown", reason: `既存作者会话身份核对不过，不猜绑定：${id.reason}` } : refOf(task, "author", row, family);
}

async function ensure(env: Env, task: LedgerTask, role: SessionRole, family: AuthorFamily): Promise<EnsureResult> {
  const { registryRow } = env;
  if (role === "author") {
    if (!task.agent) return retryCleanCreate(env, task, role, (create) => ensureLocalAuthor({ ...env, create }, task)); // 建失败且现场已清：退避重试
    const row = registryRow(task.agent);
    return row ? refOf(task, role, row, family) : { kind: "manual", reason: `执行者 ${task.agent} 不在本机 registry` };
  }
  const existing = registryRow(reviewerName(task.id));
  return existing ? refOf(task, role, existing, family) : retryCleanCreate(env, task, role, (create) => createReviewer({ ...env, create }, task, family));
}

/** Only a reviewer living in its own checkout gets orders; one created elsewhere (e.g. in the author's tree) stops for PM. */
async function pinReview(env: Env, task: LedgerTask, ref: SessionRef, head: string | null): Promise<{ dir: string } | { manual: string }> {
  const dir = checkoutOf(env, task.id);
  const cwd = env.registryRow(ref.agent)?.cwd;
  if (!cwd || realOr(cwd) !== realOr(dir)) return { manual: `${ref.agent} 的工作目录 ${cwd ?? "（无）"} 不是它独立的审查 worktree ${dir}` };
  if (!head) return { manual: "派审意图没有 head" };
  const missing = await peerPrHeadMissing(task, head, env.git);
  if (missing) return { manual: missing };
  const absent = await prepareReviewHead(env, task, head, dir, true);
  if (absent) return { manual: absent };
  return pinReviewWorktree(dir, head, env.git);
}

function worker({ db, registryRow, alive }: Env, ref: SessionRef): WorkerSession | { manual: string } {
  const row = registryRow(ref.agent);
  if (!row) return { manual: `${ref.agent} 不在本机 registry` };
  if (row.sessionId !== ref.sessionId) return { manual: `${ref.agent} 的当前 session 已不是台账绑定的那个` };
  const route = selectWorkerRoute({ agent: row.name, runtime: row.runtime, transport: row.transport, acpPending: row.acpPending });
  if (route.kind === "manual") return { manual: route.reason };
  const deps: AdapterDeps = {
    sessions: {
      bound: (taskId, role) => boundRef(db, taskId, role),
      create: async () => ({ ok: false, unknown: false, reason: "建 session 走调度器的 ensure" }),
      archive: async () => ({ ok: false, unknown: false, reason: "本段不自动归档 session" }),
    },
    ledger: { result: (r, probe) => ledgerResult(db, r, probe) },
  };
  if (route.route === "acp") return createAcpWorker({ ...deps, port: acpPort(db, registryRow, alive) });
  const port = messagePort(db, registryRow, undefined, alive);
  if (route.route === "tmux") return createTmuxFallbackWorker({ ...deps, port, reason: route.fallbackReason ?? "tmux 兼容回退" });
  return createChannelWorker({ ...deps, port });
}

const notifyPm = ({ db, alive }: Env, task: LedgerTask, text: string): Promise<void> => notifyProjectPm(db, task.project, text, { fromName: "scheduler", stillActive: alive });

export interface AutoDepsOpts {
  /** Tests only; production reads the canonical registry fresh on every lookup. */
  registryPath?: string;
  worktreeRoot?: string;
  /** The service pass's liveness check (throws SchedulerStopped); default = always active. */
  active?: () => void;
  /** Tests only: the git underneath the liveness guard. */
  git?: Git;
  /** The service's leases handed to every manager / ledger child (scheduler-lease-env.ts); none = those children refuse to act. */
  lease?: SchedulerLease;
  /** Tests only: the network git's deadline (default REVIEW_FETCH_TIMEOUT_MS) and scheduler.json in place of the state dir's. */
  netTimeoutMs?: number;
  readConfig?: () => SchedulerConfig;
  /** Tests only: `manager create` in place of the real child process (still behind localCreateGuard). */ create?: Manager;
}

export function autoTickDeps(db: Database, opts: AutoDepsOpts = {}): AutoTickDeps {
  const { registryPath, worktreeRoot = statePath("worktrees"), active = () => {}, git: baseGit = realGit, lease, create = plainManager(lease), readConfig } = opts;
  const netGit = boundedGit(opts.netTimeoutMs);
  const registryRow: RegistryRow = (agent) => readRegistryAgentsSync(registryPath).find((a) => a.name === agent);
  const alive: StillActive = () => {
    try { active(); return true; } catch { return false; /* any failure of the liveness check means "not provably active": send nothing */ }
  };
  const env: Env = { db, registryRow, worktreeRoot, active, alive, git: (args) => whileOwned(active, () => baseGit(args)),
    net: (args) => whileOwned(active, () => netGit(args)), readConfig,
    create: localCreateGuard(create), ledger: schedulerManagerWith(lease), registryPath };
  return {
    manager: schedulerManagerWith(lease),
    worker: (ref) => worker(env, ref),
    ensure: async (task, role, family) => role === "author" && !task.agent ? ensure(env, task, role, family)
      : (role === "author" ? await existingAuthor(env, task, family) : null)
      ?? localEnsure(family, role === "author" || !!registryRow(reviewerName(task.id)), () => ensure(env, task, role, family),
      { registryPath, ledgerPath: db.filename, project: task.project, taskId: task.id }),
    pinReview: (task, ref, head) => pinReview(env, task, ref, head),
    reviewDirty: async (_task, ref) => { const cwd = registryRow(ref.agent)?.cwd; return cwd ? gitDirtySync(cwd) : null; },
    notifyPm: (task, text) => notifyPm(env, task, text),
    now: () => Date.now(),
    borrow: readEffectiveBorrow,
  };
}
