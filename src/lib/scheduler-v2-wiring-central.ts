/**
 * S2F · X8 contexts for the scheduler process: dispatch / review (S2I), merge (S2J) and deploy (S2M) sends of a route=central
 * card are bound to the projected center intent, the current S2R fence and the owner's authorization ask as last read online.
 * Every input is a trusted local record (ledger projection, mode file, cached center view / ask); anything missing or
 * inconsistent yields null, which each node treats as held (no center request, no effect). X8 re-checks all of it online.
 */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { parseSchedulerCentralContext, type SchedulerCentralContext } from "./scheduler-central-context.js";
import { parseResourceKey, v2ObjectDigest, type V2Fence, type V2ResourceKey } from "./shared-ledger-contract-v2.js";
import type { Stage2View, Stage2Wiring } from "./shared-ledger-v2-wiring.js";

export type CentralAction = SchedulerCentralContext["action"];
type ViewIntent = Stage2View["intents"][number];

export interface CentralContextInput {
  wiring: Stage2Wiring;
  db: Database;
  taskId: string;
  action: CentralAction;
  head: string | null;
  /** The projected intent; omitted = the newest non-terminal intent of this action on the card. */
  intentId?: string;
  fence: V2Fence | null;
  homeInstanceId: string;
}

export interface CentralCard { project: string; featureId: string; centerFeatureId: string; view: Stage2View }

/** The card's execution feature and its cached center view; null when any link is missing. */
export function centralCard(wiring: Stage2Wiring, db: Database, taskId: string): CentralCard | null {
  const task = getTask(db, taskId), ref = wiring.featureOfTask(db, taskId);
  const view = ref ? wiring.cachedView(ref.centerFeatureId) : null;
  return task && ref && view ? { project: task.project, featureId: ref.localFeatureId, centerFeatureId: ref.centerFeatureId, view } : null;
}

function centralIntent(view: Stage2View, taskId: string, action: string, intentId?: string): ViewIntent | null {
  const live = view.intents.filter((i) => i.taskId === taskId && i.action === action && (intentId ? i.id === intentId
    : !["done", "cancelled"].includes(i.status)));
  return live.sort((a, b) => b.eventSeq - a.eventSeq)[0] ?? null;
}

export function centralContext(input: CentralContextInput): SchedulerCentralContext | null {
  const { wiring, db, taskId, action, head, fence } = input;
  if (!fence) return null;
  const card = centralCard(wiring, db, taskId);
  if (!card) return null;
  const intent = centralIntent(card.view, taskId, action, input.intentId);
  const task = card.view.tasks.find((t) => t.id === taskId), workflow = card.view.workflows.find((w) => w.taskId === taskId);
  if (!intent || !task || !workflow || intent.head !== head || !intent.authorizationAskId) return null;
  const bind = wiring.cachedAsk(intent.authorizationAskId)?.bind;
  if (!bind) return null;
  try {
    return parseSchedulerCentralContext({ teamId: card.view.teamId, projectId: card.view.projectId, ...fence,
      homeInstanceId: input.homeInstanceId, taskId, intentId: intent.id, operationId: intent.operationId,
      taskRev: task.rev, specRev: task.specRev, workflowRev: workflow.rev, head, action,
      authorizationAskId: intent.authorizationAskId, authorizationDigest: v2ObjectDigest(bind), authorizationBind: bind });
  } catch { return null; }
}

/** The fence the center recorded on a projected intent (S2Q's merge-journal claim fence); never the current lease. */
export function centralIntentFence(wiring: Stage2Wiring, db: Database, intentId: string): V2Fence | null {
  const row = db.query("SELECT taskId FROM scheduler_intents WHERE id = ?").get(intentId) as { taskId: string } | null;
  const card = row ? centralCard(wiring, db, row.taskId) : null;
  const intent = card?.view.intents.find((i) => i.id === intentId);
  return intent && intent.status !== "pending"
    ? { serviceGeneration: intent.serviceGeneration, epoch: intent.epoch, bootId: intent.bootId } : null;
}

/** Authorization asks named by the card's live intents, re-read online after each projection sync (binding evidence only). */
export async function refreshCentralAsks(wiring: Stage2Wiring, project: string, view: Stage2View): Promise<void> {
  const ids = new Set(view.intents.filter((i) => i.authorizationAskId && !["done", "cancelled"].includes(i.status))
    .map((i) => i.authorizationAskId!));
  for (const id of ids) {
    try { await wiring.fetchAsk(project, id); }
    catch (e) { console.warn(`[scheduler-v2-wiring] authorization ask ${id} unreadable: ${(e as Error).message}`); }
  }
}

/** A stable lease id for S2G's executor token: X0's fence has none, so the trusted S2R fence is digested (same term = same id). */
export function leaseIdOf(fence: V2Fence): string {
  return `lease-${v2ObjectDigest({ serviceGeneration: fence.serviceGeneration, epoch: fence.epoch, bootId: fence.bootId }).slice(0, 32)}`;
}

const LOCAL_ONLY = /^(task|slot|reviewer):/;
/**
 * S2Q `planData`: the center locks for a home plan. Worker slots, the card lock and reviewer sessions stay home-local (§2.2
 * 资源锁共存); an exact file path is a file lock in the card's repository; a glob or `merge:<project>` locks the whole
 * repository (coarser, never narrower). dependencyDigest covers the card's center dependency rows as last read online.
 */
export function centralPlanData(wiring: Stage2Wiring, db: Database, taskId: string, resources: readonly string[]):
  { dependencyDigest: string; resources: V2ResourceKey[] } | null {
  const card = centralCard(wiring, db, taskId), task = card?.view.tasks.find((t) => t.id === taskId);
  if (!card || !task) return null;
  const scope = { teamId: card.view.teamId, projectId: card.view.projectId, repository: task.repository };
  const keys = new Map<string, V2ResourceKey>();
  try {
    for (const r of resources) {
      if (LOCAL_ONLY.test(r)) continue;
      const exact = !r.startsWith("merge:") && !/[*[\]{}!]/.test(r);
      const key = parseResourceKey(exact ? { ...scope, kind: "file", path: r } : { ...scope, kind: "repository" });
      keys.set(JSON.stringify(key), key);
    }
  } catch { return null; }
  const deps = card.view.dependencies.filter((d) => d.toTask === taskId).map((d) => [d.fromTask, d.kind, d.state, d.rev]).sort();
  return { dependencyDigest: v2ObjectDigest(deps), resources: [...keys.values()] };
}
