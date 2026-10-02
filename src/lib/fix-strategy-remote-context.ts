/** Remote convergence reads the same scheduler policy and effective borrow gates as ordinary placement. */
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { readSchedulerConfig, type RemotePolicy } from "./scheduler-config.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
import { readLend, type BorrowEntry } from "./lend-config.js";
import { convergenceLifecycle, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import type { LedgerTask } from "./ledger-stages.js";
import { notifyProjectPm } from "./pm-notify.js";
import { borrowPeers, prCoordinates } from "./scheduler-pool-facts.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { peerRefusal, type PlacementFacts } from "./scheduler-placement.js";
import { remoteHeadAt } from "./lend-git.js";
import { runBounded } from "./run-bounded.js";
import type { RemoteHead } from "./order-deliver.js";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";

export interface RemoteConvergenceContext {
  lifecycle?: ConvergenceLifecycle;
  remote: RemotePolicy | null; borrow: readonly BorrowEntry[]; source: string | null; spec: string | null; maxWorkers: number;
  notify(text: string): Promise<void>;
  remoteHead(repo: string, branch: string): Promise<RemoteHead>;
}
const contexts = new WeakMap<Database, RemoteConvergenceContext>();
export const setRemoteConvergenceContext = (db: Database, context: RemoteConvergenceContext): void => void contexts.set(db, context);

/** Zero project slots may replace an old context remotely, but can never create a local repair worker. */
export function zeroSlotLifecycle(db: Database, maxWorkers: string | undefined): ConvergenceLifecycle | undefined {
  if (maxWorkers !== "0") return undefined;
  return { ...(contexts.get(db)?.lifecycle ?? convergenceLifecycle()), localFamilyWait: () => "本机0槽，不创建修复worker" };
}

export async function remoteContext(db: Database, task: LedgerTask, deps: ConvergenceLifecycle): Promise<RemoteConvergenceContext> {
  const injected = contexts.get(db);
  if (injected) return injected;
  const config = readSchedulerConfig(deps.registryPath ? join(dirname(deps.registryPath), "scheduler.json") : undefined).projects[task.project];
  const borrow = deps.registryPath ? (await readLend(join(dirname(deps.registryPath), "lend.json"))).file.borrow : await readEffectiveBorrow();
  let spec: string | null = null;
  if (task.spec) {
    try { spec = readFileSync(task.spec, "utf8"); }
    catch (e) { console.warn(`convergence spec unavailable: ${(e as Error).message}`); }
  }
  return { remote: config?.remote ?? null, borrow, source: config?.repoDir ?? null, spec, maxWorkers: config?.maxActiveWorkers ?? 0,
    notify: async (text) => {
      if (deps.registryPath) throw new Error("isolated convergence lifecycle needs an injected PM notification port");
      deps.active(); await notifyProjectPm(db, task.project, text, { fromName: "scheduler" }); deps.active();
    },
    remoteHead: (repo, branch) => remoteHeadAt(repo, branch, runBounded) };
}

export function convergencePlacement(db: Database, task: LedgerTask, context: RemoteConvergenceContext, family: "claude" | "codex",
  role: "write" | "review", now: number): { facts: PlacementFacts; reasons: string[] } {
  const peers = borrowPeers(db, task.project, context.borrow, now).map(peerFacts);
  const reasons: string[] = [];
  const repo = prCoordinates(task.pr)?.repo ?? context.remote?.repo ?? null;
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string").map(resourceKey) : [];
  const held = db.query("SELECT resource FROM scheduler_resources WHERE project = ? AND taskId != ?").all(task.project, task.id) as { resource: string }[];
  const locksFree = !!globs.length && !globs.includes(null) && !held.some((h) => globs.some((g) => resourcesOverlap(g!, resourceKey(h.resource) ?? h.resource)));
  const facts: PlacementFacts = { remote: context.remote, repo, peers, local: { running: 0, room: false },
    pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: role === "review" || locksFree };
  for (const p of peers) {
    const proto = getLendPeer(db, p.peer)?.proto ?? 1;
    const why = proto < 3 ? `proto ${proto} 不认识收敛单` : peerRefusal(facts, p, role, family) ??
      ((p.v2?.slots[family] ?? 0) <= 0 ? `对方没有空闲的 ${family} 槽` : null);
    if (why) { reasons.push(`${p.peer}：${why}`); if (p.v2) p.v2 = { ...p.v2, why }; }
    if (p.v2) p.v2 = { ...p.v2, slots: { claude: family === "claude" ? p.v2.slots.claude : 0, codex: family === "codex" ? p.v2.slots.codex : 0 } };
  }
  return { facts, reasons };
}
