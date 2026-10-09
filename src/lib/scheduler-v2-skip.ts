/**
 * S2D2 · the unified skip gate: a card whose route is `skip` (§2.2) gets no local side effect from any scheduler path.
 * `schedulerV2SkipManager` holds a `ledger <sub>` call for a skip card before it reaches the manager; paths acting outside the
 * manager call the predicates exported here in a ≤3-line hook. Routes are re-read on every call, so a revocation is seen at the next check.
 * Which path uses which gate: scheduler-v2-skip-paths.ts. Tests: tests/shared-ledger-v2-stage2-skip*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { cardWorkerIndex } from "./agent-lifecycle-store.js";
import { finishedLeaseSkip } from "./ledger-scheduler-lease-finished.js";
import { configureTakeoverSkip } from "./lend-pr-takeover.js";
import { intentOf, listRequests, requestRefusal, revokeOf } from "./manual-merge-queue-facts.js";
import type { SchedulerV2Manager } from "./scheduler-v2-pass.js";
import { schedulerV2Held, schedulerV2SkipFeature, schedulerV2SkipTask, sharedModes } from "./scheduler-v2-skip-card.js";
import { SKIP_LEDGER_COMMANDS } from "./scheduler-v2-skip-paths.js";

export { schedulerV2SkipFeature, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
export { schedulerV2Lifecycle } from "./scheduler-v2-skip-lifecycle.js";

const V2_HELD = "v2_held";

/** Missing table / column in an old or test ledger reads as "no such row". */
function row<T>(db: Database, sql: string, ...params: (string | number)[]): T | null {
  try { return db.query(sql).get(...params) as T | null; }
  catch (e) {
    if (/no such (table|column)/.test((e as Error).message)) return null;
    throw e;
  }
}

/** Any card the agent works for (cardWorkerIndex: registration, scheduler session or executor) is skip. */
export function schedulerV2SkipAgent(db: Database, agent: string): boolean {
  if (!sharedModes(db)) return false;
  const links = cardWorkerIndex(db).get(agent)?.links ?? [];
  return links.some((l) => !!l.taskId && schedulerV2SkipTask(db, l.taskId));
}

/** True when any of the listed cards is skip (a train carrying one is not stepped). */
export const schedulerV2SkipAny = (db: Database, cards: readonly { taskId: string }[]): boolean =>
  cards.some((c) => schedulerV2SkipTask(db, c.taskId));

/** The cards whose route is not skip. */
export const schedulerV2Unskipped = <T extends { taskId: string }>(db: Database, cards: readonly T[]): T[] =>
  cards.filter((c) => !schedulerV2SkipTask(db, c.taskId));

/** SQL that leaves skip cards out of a set-based write over `alias.id` (the finished-lease sweep before retire). */
function excludeSkipCards(db: Database, alias: string): string {
  if (!sharedModes(db)) return "";
  const ids = (db.query("SELECT DISTINCT taskId FROM scheduler_resources WHERE scope = 'card'").all() as { taskId: string }[])
    .map((r) => r.taskId).filter((id) => schedulerV2SkipTask(db, id));
  return ids.length ? `AND ${alias}.id NOT IN (${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")})` : "";
}

// These modules sit in this module's import closure, so they cannot import it back: their hooks are handed over on load.
configureTakeoverSkip(schedulerV2SkipTask);
finishedLeaseSkip.card = schedulerV2SkipTask;
finishedLeaseSkip.exclude = excludeSkipCards;

interface Targets { tasks: Set<string>; features: Set<string> }

/** Value of `--flag v` or `--flag=v`. */
function flag(args: readonly string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? null;
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return null;
}

/** A JSON argument as an object. Unparsable JSON names no card: the manager parses the same argument and rejects it unwritten. */
function jsonOf(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; /* see above: an unparsable payload is refused by the manager itself */ }
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

const str = (o: Record<string, unknown> | null, key: string): string | null => (typeof o?.[key] === "string" ? o[key] as string : null);

function addIntent(db: Database, id: string | undefined, out: Targets): void {
  const intent = id ? row<{ taskId: string }>(db, "SELECT taskId FROM scheduler_intents WHERE id = ?", id) : null;
  if (intent) out.tasks.add(intent.taskId);
}

/** `scheduler-autostart <verb> …`: claim / spec-wait name a feature, post-verify / merge-pm / review-pm a card, settle / step a claim. */
function autostartTargets(db: Database, rest: readonly string[], out: Targets): void {
  const [verb, arg] = rest;
  if (!arg) return;
  if (verb === "claim" || verb === "spec-wait") out.features.add(arg);
  else if (verb === "post-verify" || verb === "merge-pm" || verb === "review-pm") out.tasks.add(arg);
  else if ((verb === "settle" || verb === "step") && /^\d+$/.test(arg)) {
    const claim = row<{ target: string; data: string }>(db, "SELECT target, data FROM events WHERE seq = ?", Number(arg));
    if (!claim) return;
    if (row(db, "SELECT 1 FROM features WHERE id = ?", claim.target)) out.features.add(claim.target);
    else out.tasks.add(claim.target);
    const data = jsonOf(claim.data), featureId = str(data, "featureId"), taskId = str(data, "taskId");
    if (featureId) out.features.add(featureId);
    if (taskId) out.tasks.add(taskId);
  }
}

/** The queue head a manual claim would take (manualTurn's `queued` request): no intent, no revoke, no refusal. */
function manualClaimTarget(db: Database, project: string | undefined, out: Targets): void {
  if (!project || !row(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_intents'")) return;
  const now = Date.now(), head = listRequests(db, project).find((r) => !intentOf(db, r) && !revokeOf(db, r) && !requestRefusal(db, r, now));
  if (head) out.tasks.add(head.taskId);
}

/** The cards and features a `ledger <sub> …` call is about, read from the command's target argument only (SKIP_LEDGER_COMMANDS). */
function schedulerV2LedgerTargets(db: Database, args: readonly string[]): Targets {
  const out: Targets = { tasks: new Set(), features: new Set() };
  const [sub = "", ...rest] = args;
  const first = rest[0];
  const kind = Object.hasOwn(SKIP_LEDGER_COMMANDS, sub) ? SKIP_LEDGER_COMMANDS[sub] : "unregistered";
  if (kind === "task" && first && first !== "-") out.tasks.add(first);
  else if (kind === "intent") addIntent(db, first, out);
  else if (kind === "autostart") autostartTargets(db, rest, out);
  else if (kind === "lend-order" && first) {
    const order = row<{ taskId: string }>(db, "SELECT taskId FROM lend_orders WHERE orderId = ?", first);
    if (order) out.tasks.add(order.taskId);
  } else if (kind === "manual-claim") manualClaimTarget(db, first, out);
  else if (kind === "supervise" || kind === "worker-retire") {
    const id = kind === "supervise" ? str(jsonOf(flag(rest, "--data")), "target") : str(jsonOf(flag(rest, "--wire")), "taskId");
    if (id) out.tasks.add(id);
  } else if (kind === "unregistered" && first) {
    // S2Q's rule for a command it has no row for: the first argument is the card, or an intent of it.
    out.tasks.add(first);
    addIntent(db, first, out);
  }
  return out;
}

/** The skip card or feature a ledger call would write for, or null when it may run. */
function schedulerV2HeldTarget(db: Database, args: readonly string[]): string | null {
  const t = schedulerV2LedgerTargets(db, args);
  for (const id of t.tasks) if (schedulerV2SkipTask(db, id)) return id;
  for (const id of t.features) if (schedulerV2SkipFeature(db, id)) return id;
  return null;
}

/**
 * The pass manager's skip gate (outside S2D's `schedulerV2PassManager`, inside the maintenance guard). Only `ledger` calls are
 * judged; a held call reaches neither S2Q nor the real manager. No ledger = nothing to judge: the manager is returned as is.
 */
export function schedulerV2SkipManager(db: Database | null, manager: SchedulerV2Manager): SchedulerV2Manager {
  if (!db) return manager;
  return async (...args) => {
    if (args[0] === "ledger" && sharedModes(db)) {
      const id = schedulerV2HeldTarget(db, args.slice(1));
      if (id !== null) {
        schedulerV2Held(`ledger ${args[1] ?? ""}`, id);
        return { ok: false, code: V2_HELD, held: true, error: `v2 route skip: ${id} held, nothing written` };
      }
    }
    return manager(...args);
  };
}
