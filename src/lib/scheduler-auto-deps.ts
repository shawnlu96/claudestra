import { localEnsure, localCreateGuard } from "./scheduler-local-runtime-start.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "./scheduler-local-author.js";
import { rebuildRetiredAuthor, type AuthorRebuildDeps } from "./scheduler-author-rebuild.js";
/**
 * Production wiring of the auto tick: ledger writes through the scheduler-identity CLI, adapters chosen from the
 * registry, the author taken from the card (or created locally when unassigned), and the per-card
 * cross-family reviewer created through `manager create` in its own detached worktree of the author's repository. Anything the engine
 * cannot prove (no session id yet, create timed out) is "unknown" and stops for PM rather than being created twice.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolveBunPath } from "./bun-path.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { boundRef, type AutoTickDeps } from "./scheduler-auto-tick.js";
import { acpPort, messagePort, type RegistryRow, type StillActive } from "./scheduler-auto-ports.js";
import { runtimeFamily } from "./scheduler-auto-review.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { peerPrHeadMissing, peerPrRepoDir } from "./peer-pr-hold.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
import { openCreateReviewWorktree, retryCleanCreate } from "./scheduler-create-retry.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { git as realGit, gitDirtySync, pinReviewWorktree, type Git } from "./scheduler-review-worktree.js";
import { reviewCheckoutDir, reviewerCheckout } from "./scheduler-review-checkout.js";
import { refusalEpochLapse } from "./scheduler-review-swap.js";
import { reviewMaterialCheck } from "./scheduler-model-wiring.js";
import { boundedGit, lendProjectDir, prepareReviewHead, type ReviewHeadEnv } from "./scheduler-review-head.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { SessionRole } from "./scheduler-sessions.js";
import { ledgerResult } from "./scheduler-work-order.js";
import { createAcpWorker } from "./worker-acp.js";
import { createChannelWorker, createTmuxFallbackWorker } from "./worker-message.js";
import type { AdapterDeps } from "./worker-ports.js";
import { selectWorkerRoute, type EnsureResult, type SessionRef, type WorkerSession, type WorkOrder } from "./worker-session.js";
import { ghPrState } from "./scheduler-merge-handoff-tick.js";

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
interface Env extends LocalAuthorEnv, ReviewHeadEnv { alive: StillActive; rebuild?: AuthorRebuildDeps }
const checkoutOf = (env: Env, taskId: string): string => reviewCheckoutDir(env.worktreeRoot, taskId);

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
    "--project", task.project, "--task", `${task.id} 审查`, "--card", task.id, "--card-role", "reviewer", ...runtime));
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

async function ensure(env: Env, task: LedgerTask, role: SessionRole, family: AuthorFamily): Promise<EnsureResult> {
  const { registryRow } = env;
  if (role === "author") {
    if (!task.agent) return retryCleanCreate(env, task, role, (create) => ensureLocalAuthor({ ...env, create }, task)); // 建失败且现场已清：退避重试
    const row = registryRow(task.agent), gone = `执行者 ${task.agent} 不在本机 registry`;
    if (row) return refOf(task, role, row, family); // AREB1: an author LIFE1 formally retired is rebuilt under authorRebuild, else the old manual
    return retryCleanCreate(env, task, role, (create) => rebuildRetiredAuthor({ ...env, create }, task, family, gone, { readConfig: env.readConfig, ...env.rebuild }));
  }
  const existing = registryRow(reviewerName(task.id));
  return existing ? refOf(task, role, existing, family) : retryCleanCreate(env, task, role, (create) => createReviewer({ ...env, create }, task, family));
}

/**
 * Only a reviewer living in its own checkout gets orders; one created elsewhere (e.g. in the author's tree) stops for PM. Which
 * checkout is its own comes from the ledger binding (RVWT1, scheduler-review-checkout.ts), the same rule createReplacement used.
 */
const ownCheckout = (env: Env, task: LedgerTask, ref: SessionRef) =>
  reviewerCheckout(env.db, getTask(env.db, task.id) ?? task, ref, env.worktreeRoot, env.registryRow(ref.agent)?.cwd);

async function pinReview(env: Env, task: LedgerTask, ref: SessionRef, head: string | null): Promise<{ dir: string } | { manual: string }> {
  const first = ownCheckout(env, task, ref);
  if ("manual" in first) return first;
  const dir = first.dir;
  if (!head) return { manual: "派审意图没有 head" };
  const missing = await peerPrHeadMissing(task, head, env.git);
  if (missing) return { manual: missing };
  const absent = await prepareReviewHead(env, task, head, dir, true);
  if (absent) return { manual: absent };
  const pinned = await pinReviewWorktree(dir, head, env.git);
  const now = ownCheckout(env, task, ref); // binding, replacement source or registry cwd may have moved while git ran: no order then
  if ("manual" in pinned || ("dir" in now && now.dir === dir)) return pinned;
  return { manual: `审查绑定、替代来源或审查目录在固定 head 期间变了，不派审：${"manual" in now ? now.manual : now.dir}` };
}

/**
 * Why this review order may no longer go to `ref`: the card's head / spec / round moved off it, a refusal epoch's authorization
 * lapsed (approval revoked, materials changed — the tick's own refusalLapse rule), or pinReview's checkout rule now refuses.
 */
function reviewOrderStale(env: Env, ref: SessionRef, order: WorkOrder): string | null {
  const task = getTask(env.db, ref.taskId);
  if (!task) return `${ref.taskId} 已不在台账`;
  if (task.headSHA !== order.head || task.specRev !== order.specRev || task.round !== order.round) return "卡的 head/规格/轮次已不是这张审查单的";
  const lapse = refusalEpochLapse(env.db, task, { check: reviewMaterialCheck(env.db) });
  if (lapse) return `豁免审查接续已失效：${lapse}`;
  const now = ownCheckout(env, task, ref);
  return "manual" in now ? now.manual : null;
}

/**
 * The last check before a review order leaves (same rule as pinReview): once at submit and again inside the bridge's stillActive,
 * in the same synchronous block as the frame, so a cwd / binding / card move during the ws handshake sends nothing.
 */
const sendsFromOwnCheckout = (env: Env, ref: SessionRef, w: WorkerSession): WorkerSession => ({ ...w, submit: async (r, id, order) => {
  if (order.step !== "review") return w.submit(r, id, order);
  let stale = reviewOrderStale(env, ref, order);
  const own = stale ? null : channelWorker({ ...env, alive: () => !(stale = reviewOrderStale(env, ref, order)) && env.alive() }, ref);
  if (own && !("manual" in own)) {
    const got = await own.submit(r, id, order);
    return stale && got.status === "rejected" ? { ...got, reason: `发帧前复核审查目录：${stale}` } : got;
  }
  return { status: "rejected", route: w.route, reason: `发送前复核审查目录：${stale ?? own?.manual}` };
} });

function worker(env: Env, ref: SessionRef): WorkerSession | { manual: string } {
  const w = channelWorker(env, ref);
  return ref.role === "reviewer" && !("manual" in w) ? sendsFromOwnCheckout(env, ref, w) : w;
}

function channelWorker({ db, registryRow, alive }: Env, ref: SessionRef): WorkerSession | { manual: string } {
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
  /** Tests only: the author rebuild's policy / swap reading (scheduler-author-rebuild.ts). */ rebuild?: AuthorRebuildDeps;
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
    create: localCreateGuard(create), ledger: schedulerManagerWith(lease), registryPath, rebuild: opts.rebuild };
  return {
    manager: schedulerManagerWith(lease),
    worker: (ref) => worker(env, ref),
    ensure: (task, role, family) => role === "author" && !task.agent ? ensure(env, task, role, family)
      : localEnsure(family, role === "author" || !!registryRow(reviewerName(task.id)), () => ensure(env, task, role, family),
      { registryPath, ledgerPath: db.filename, project: task.project, taskId: task.id }),
    pinReview: (task, ref, head) => pinReview(env, task, ref, head),
    reviewDirty: async (_task, ref) => { const cwd = registryRow(ref.agent)?.cwd; return cwd ? gitDirtySync(cwd) : null; },
    notifyPm: (task, text) => notifyPm(env, task, text),
    now: () => Date.now(),
    borrow: readEffectiveBorrow,
    prState: ghPrState(),
  };
}
