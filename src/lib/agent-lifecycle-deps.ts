/**
 * Production wiring of the worker lifecycle: gather facts (registry + windows, ACP activity / session file mtime, ledger cards and
 * registrations, system memory), plan (agent-lifecycle.ts), and in "on" mode carry it out (agent-lifecycle-run.ts) through plain
 * manager children holding the pass's leases. observe only logs the plan when it changes; off does nothing.
 * `lifecycleSnapshot` is the same read-only plan for doctor's one-line summary.
 */
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "./agent-lifecycle-config.js";
import { cardWorkerIndex, pendingCleanups, registerFailures } from "./agent-lifecycle-store.js";
import { planLifecycle, lifecycleLine, type Action, type AgentFacts, type CardFacts, type Plan } from "./agent-lifecycle.js";
import { runLifecycle, type LifecycleDeps } from "./agent-lifecycle-run.js";
import { readActivity } from "./agent-supervisor-activity.js";
import { agentWindowsOrNull } from "./agent-windows.js";
import { resolveBunPath } from "./bun-path.js";
import { hasAsksTable } from "./ledger-asks.js";
import { pmsByProject } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { isMasterName, normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { LEND_JOURNAL_PATH } from "./lend-journal.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { readLiveAgents } from "./scheduler-retire.js";
import { nodeTmpCleaner } from "./scheduler-retire-tmp.js";
import { git } from "./scheduler-review-worktree.js";
import { sessionJsonlPath } from "./session-source.js";
import { readJsonLenient } from "./state-file.js";
import { readMemory } from "./sys-memory.js";

export function ledgerFacts(db: Database): { cards: CardFacts[]; pms: Set<string> } {
  const last = (kind: string) => new Map((db.query("SELECT target, MAX(ts) AS ts FROM events WHERE kind = ? AND target != '' GROUP BY target").all(kind) as
    { target: string; ts: number }[]).map((r) => [r.target, r.ts]));
  const stageAt = last("stage"), reviewAt = last("review");
  const rows = db.query("SELECT id, project, stage, agent, extra FROM tasks").all() as { id: string; project: string; stage: string; agent: string | null; extra: string | null }[];
  const cards = rows.map((r) => {
    let extra: Record<string, unknown> = {}, extraError: string | undefined;
    // unparsable: whether the card is frozen is unknown, so the planner skips (and reports) it instead of reading "not frozen"
    try { extra = r.extra ? JSON.parse(r.extra) : {}; } catch (e) { extraError = (e as Error).message; }
    return { id: r.id, project: r.project, stage: r.stage, agent: r.agent, frozen: extra?.frozen === true, ...(extraError ? { extraError } : {}),
      stageAt: stageAt.get(r.id) ?? null, reviewAt: reviewAt.get(r.id) ?? null };
  });
  return { cards, pms: new Set([...pmsByProject(db).values()].flat()) };
}

/** Idle from the ACP host's turn record when it matches the session, else the session file's last write. */
async function activity(a: RegistryAgent, now: number): Promise<{ idleMs: number | null; turnActive: boolean }> {
  const rec = readActivity(a.name);
  if (rec && a.sessionId && rec.sessionId === a.sessionId) return { idleMs: now - Math.max(rec.updateAt, rec.turnAt), turnActive: rec.busy };
  const path = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  const mtime = path ? await stat(path).then((s) => s.mtimeMs, () => null) : null; // no file yet / archived: idle unknown
  return { idleMs: mtime === null ? null : now - mtime, turnActive: false };
}

async function agentFacts(now: number): Promise<AgentFacts[]> {
  // tmux unreadable: fall back to the registry status; the stop itself (manager kill / remove) re-checks the window
  const windows = await agentWindowsOrNull(), open = new Set(windows?.map((w) => w.name) ?? []);
  const raw = await readJsonLenient<{ agents?: Record<string, { pending?: unknown }> } | null>(REGISTRY_PATH, null, { who: "registry", writersGuarded: false });
  return Promise.all(normalizeRegistryAgents(raw).map(async (a) => ({
    name: a.name, kind: a.kind, role: a.role, status: a.status, cwd: a.cwd, sessionId: a.sessionId, pending: !!raw?.agents?.[a.name]?.pending,
    running: open.has(a.name) || ((a.transport === "acp" || !windows) && a.status === "active"), ...(await activity(a, now)),
  })));
}

/**
 * Agents the lend journal records as order workers: the lend service retires those (lend-work-retention.ts). Read through a
 * read-only connection (no WAL switch, no migration: observe / doctor must not write); no journal or no table = no lend workers;
 * any read error throws, so the pass plans nothing rather than treating every lend worker as unprotected.
 */
export function lendAgents(path = LEND_JOURNAL_PATH): Set<string> {
  if (!existsSync(path)) return new Set();
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return new Set();
    const rows = db.query("SELECT DISTINCT agent FROM lend_orders WHERE agent IS NOT NULL").all() as { agent: string }[];
    return new Set(rows.map((r) => r.agent));
  } finally { db.close(); }
}

/** ASKPM2: an agent's open, unexpired asks on a card, by asker; a read error throws (the pass plans nothing, as with lendAgents) */
export const askingAgents = (db: Database, now: number): Map<string, { id: string; taskId: string }[]> => !hasAsksTable(db) ? new Map()
  : (db.query("SELECT id, taskId, fromAgent FROM asks WHERE state = 'open' AND expiresAt > ? AND taskId IS NOT NULL AND fromAgent IS NOT NULL ORDER BY createdAt, id")
    .all(now) as { id: string; taskId: string; fromAgent: string }[]).reduce((m, r) => m.set(r.fromAgent, [...m.get(r.fromAgent) ?? [], { id: r.id, taskId: r.taskId }]), new Map());

export async function lifecycleSnapshot(db: Database, policy: LifecyclePolicy = DEFAULT_LIFECYCLE, now = Date.now()): Promise<Plan> {
  const [agents, memory] = await Promise.all([agentFacts(now), readMemory()]);
  const master = new Set(agents.filter((a) => isMasterName(a.name)).map((a) => a.name));
  return planLifecycle({ now, policy, agents, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: lendAgents(), master,
    swapPct: memory.swapPct, pending: pendingCleanups(db), registerFailed: registerFailures(db), asking: askingAgents(db, now) });
}

async function du(paths: string[]): Promise<number | null> {
  const there = paths.filter((p) => existsSync(p));
  if (!there.length) return 0;
  const p = Bun.spawn(["du", "-sk", ...there], { stdout: "pipe", stderr: "ignore", timeout: 120_000 }); // not runBounded: see sys-memory.ts
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0 && !out) return null;
  return out.split("\n").reduce((n, l) => n + (Number(l.split("\t")[0]) || 0), 0) * 1024;
}

/** LIFE4 PM notices: scheduler-retire-deps.ts's channel and liveness rule; the card's project, else the first configured one. */
export const lifecycleNotifier = (db: Database, config: SchedulerConfig, active: () => void, send = notifyProjectPm) => (a: Action, text: string): Promise<void> =>
  whileOwned(active, () => send(db, (db.query("SELECT project FROM tasks WHERE id = ?").get(a.taskId) as { project: string } | null)?.project
    ?? Object.keys(config.projects)[0] ?? "", text, { fromName: "scheduler", stillActive: () => { try { active(); return true; } catch { return false; } } }));

let lastObserved = "";

/** The pass's lifecycle step (scheduler-pass.ts): failures are reported like other steps, never thrown past the pass. */
export async function lifecycleStep(db: Database, config: SchedulerConfig, ledger: LifecycleDeps["manager"], active: () => void,
  lease: SchedulerLease | undefined): Promise<{ taskId: string; error: string }[]> {
  const policy = config.lifecycle;
  if (!policy || policy.mode === "off") return [];
  let plan: Plan;
  try { plan = await whileOwned(active, () => lifecycleSnapshot(db, policy)); }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return [{ taskId: "lifecycle", error: (e as Error).message }];
  }
  const report = JSON.stringify({ a: plan.actions.map((x) => [x.agent, x.rule]), m: plan.memory.map((x) => x.agent), c: plan.cleanups.map((x) => x.agent), f: plan.frozen, k: plan.kept });
  if (report !== lastObserved) {
    lastObserved = report;
    console.log(`[lifecycle] ${lifecycleLine(plan, policy.mode)}；应收 ${plan.actions.map((x) => `${x.agent}(${x.rule}：${x.reason})`).join("、") || "无"}` +
      `${plan.cleanups.length ? `；待补清 ${plan.cleanups.map((x) => `${x.agent}（${x.entries?.map((e) => e.checkout).join(" ")}）`).join("、")}` : ""}` +
      `${plan.memory.length ? `；内存候选 ${plan.memory.map((x) => x.agent).join("、")}` : ""}${plan.frozen.length ? `；冻结卡不收 ${plan.frozen.map((x) => `${x.agent}@${x.taskId}`).join("、")}` : ""}` +
      `${plan.kept.length ? `；保留不收 ${plan.kept.map((x) => `${x.agent}（${x.reason}）`).join("、")}` : ""}`);
  }
  if (policy.mode !== "on") return [];
  const manager: LifecycleDeps["manager"] = async (...args) => {
    const r = await whileOwned(active, () => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
      env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 180_000 }));
    if (r.code === "lease-lost") throw new SchedulerStopped(`manager ${args[0]}: ${String(r.error)}`);
    return r;
  };
  const tmp = nodeTmpCleaner();
  const result = await runLifecycle(plan, policy, { notifyPm: lifecycleNotifier(db, config, active),
    manager, worktreeRoot: statePath("worktrees"), exists: existsSync, git: (args) => whileOwned(active, () => git(args)),
    tmp: { root: tmp.root, rm: (p) => whileOwned(active, () => tmp.rm(p)) }, agents: () => whileOwned(active, () => readLiveAgents()),
    du, swapPct: async () => (await readMemory()).swapPct, now: Date.now, record: async (r) => {
      const w = await ledger("ledger", "scheduler-worker-retire", "--wire", JSON.stringify(r));
      if (w.ok !== true) throw new Error(`收回记录没记上：${String(w.error)}`);
    },
  });
  for (const d of result.done) console.log(`[lifecycle] 收 ${d.agent}（${d.rule}）${d.freed !== null ? `，腾出 ${Math.round(d.freed / 1048576)}MB` : ""}`);
  return result.failed.map((f) => ({ taskId: `lifecycle ${f.agent}`, error: f.error }));
}
