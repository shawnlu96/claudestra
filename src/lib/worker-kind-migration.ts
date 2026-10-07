import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cardWorkerMigrationEvidence, type WorkerMigrationEvidence } from "./agent-lifecycle-store.js";
import { pmsByProject } from "./ledger-store.js";
import { markWorkerKinds, setWorkerKind, type KindEvidence } from "./worker-kind.js";

interface WorkerKindChange { agent: string; kind?: "worker" | "main"; sources: string[]; references?: WorkerMigrationEvidence[] }
export interface WorkerKindMigration {
  changes: WorkerKindChange[]; unresolved: string[]; uncovered: WorkerMigrationEvidence[]; missingSources: string[]; error?: string;
}

/** A missing session or index entry is not proof of a manual agent: historical and foreign records may be absent here. */
export function planWorkerKindMigration(db: Database, agents: Record<string, KindEvidence & { sessionId?: string }>, journalDb?: Database): WorkerKindMigration {
  try {
    const history = cardWorkerMigrationEvidence(db, journalDb), pms = [...pmsByProject(db).values()].flat();
    const next = Object.fromEntries(Object.entries(agents).map(([name, info]) => [name, { ...info }]));
    markWorkerKinds(next, pms);
    const unresolved: string[] = [];
    const evidence = new Map<string, string[]>();
    const references = new Map<string, WorkerMigrationEvidence[]>();
    for (const [name, info] of Object.entries(agents)) {
      const links = history.evidence.filter((link) => link.agent === name && link.local && !!info.sessionId && link.sessionId === info.sessionId &&
        (link.source !== "worker_agents" || !!link.taskId));
      if (!links.length) { unresolved.push(name); continue; }
      setWorkerKind(next, name, "worker", pms);
      evidence.set(name, [...new Set(links.map((link) => link.source))]);
      references.set(name, links);
    }
    const changes = Object.entries(next).flatMap(([agent, info]) => info.kind === agents[agent].kind ? [] :
      [{ agent, kind: info.kind, sources: evidence.get(agent) ?? ["protected_identity"], references: references.get(agent) ?? [] }]);
    const uncovered = history.evidence.filter((row) => !agents[row.agent] ||
      !row.local || !row.sessionId || row.sessionId !== agents[row.agent].sessionId || (row.source === "worker_agents" && !row.taskId));
    return { changes, unresolved, uncovered, missingSources: history.missingSources };
  } catch (error) {
    // No partial plan survives an unreadable ledger: otherwise a failed PM lookup could hide a protected identity.
    return { changes: [], unresolved: Object.keys(agents), uncovered: [], missingSources: ["read_failed"], error: String(error) };
  }
}

/** Caller owns the registry lease, persistence and the regular ledger event writer; planning itself never changes either store. */
export function applyWorkerKindMigration(agents: Record<string, KindEvidence>, plan: WorkerKindMigration): number {
  if (plan.error) return 0;
  for (const change of plan.changes) {
    if (!agents[change.agent]) throw new Error(`Migration agent disappeared: ${change.agent}`);
    if (change.kind) agents[change.agent].kind = change.kind;
    else delete agents[change.agent].kind;
  }
  return plan.changes.length;
}

export interface WorkerKindMigrationAudit {
  key: string; savedAt: number;
  changes: (WorkerKindChange & { sessionId: string | null; project: string })[];
}
interface MigrationRegistry {
  agents: Record<string, KindEvidence & { sessionId?: string; projectId?: string }>;
  workerKindMigrationAudit?: WorkerKindMigrationAudit;
}
const auditKey = (batch: Omit<WorkerKindMigrationAudit, "key">): string =>
  "worker-kind-migration:" + createHash("sha256").update(JSON.stringify(batch)).digest("hex");

/** Reject a corrupt pending batch before any registry or event write; never replace its evidence with a new plan. */
function validateMigrationAudit(value: unknown): asserts value is WorkerKindMigrationAudit {
  const b = value as WorkerKindMigrationAudit | undefined;
  if (!b || !Number.isFinite(b.savedAt) || !Array.isArray(b.changes) || !b.changes.length || !b.changes.every((c) =>
    c && typeof c.agent === "string" && !!c.agent && typeof c.project === "string" && !!c.project &&
    (c.sessionId === null || typeof c.sessionId === "string") && (c.kind === undefined || c.kind === "worker" || c.kind === "main") &&
    Array.isArray(c.sources) && c.sources.length > 0 && c.sources.every((s) => typeof s === "string" && !!s)) ||
    b.key !== auditKey({ savedAt: b.savedAt, changes: b.changes })) throw new Error("Invalid pending worker migration audit");
}

/** Saving tags and pending evidence is one registry write; recording events and clearing evidence are separate, retryable writes. */
export async function runWorkerKindMigration<R extends MigrationRegistry>(reg: R, plan: WorkerKindMigration, dryRun: boolean, deps: {
  save(reg: R): Promise<void>;
  event(project: string, key: string, fact: Record<string, unknown>): Promise<void>;
  now(): number;
}): Promise<Record<string, unknown>> {
  const pending = reg.workerKindMigrationAudit;
  if (pending !== undefined) validateMigrationAudit(pending);
  if (plan.error) throw new Error(plan.error);
  const coverage = { uncoveredCount: plan.uncovered.length, missingSourceCount: plan.missingSources.length,
    unresolvedCount: plan.unresolved.length, wouldTag: plan.changes.filter((c) => c.kind === "worker").map((c) => c.agent) };
  if (dryRun) return { ok: true, dryRun: true, ...plan, ...coverage, pendingAudit: pending ?? null };
  let batch = pending;
  if (!batch && plan.changes.length) {
    const changes = plan.changes.map((change) => {
      const agent = reg.agents[change.agent];
      if (!agent?.projectId) throw new Error(`Migration agent has no project: ${change.agent}`);
      return { ...change, sessionId: agent.sessionId ?? null, project: agent.projectId };
    });
    const body = { savedAt: deps.now(), changes };
    batch = { ...body, key: auditKey(body) };
    const next = { ...reg, agents: Object.fromEntries(Object.entries(reg.agents).map(([name, info]) => [name, { ...info }])),
      workerKindMigrationAudit: batch } as R;
    applyWorkerKindMigration(next.agents, plan);
    await deps.save(next);
    reg.agents = next.agents;
    reg.workerKindMigrationAudit = batch;
  }
  if (!batch) return { ok: true, marked: 0, ...plan, ...coverage };
  const facts = batch.changes.map((change) => {
    const current = reg.agents[change.agent];
    return { ...change, currentSessionId: current?.sessionId ?? null, currentKind: current?.kind ?? null,
      drifted: !current || (current.sessionId ?? null) !== change.sessionId || current.kind !== change.kind };
  });
  for (const project of new Set(batch.changes.map((c) => c.project))) {
    const changes = facts.filter((c) => c.project === project);
    await deps.event(project, `${batch.key}:${project}`, { op: "worker_kind_migration", savedAt: batch.savedAt, marked: changes.length, changes });
  }
  const clean = { ...reg };
  delete clean.workerKindMigrationAudit;
  await deps.save(clean);
  delete reg.workerKindMigrationAudit;
  return { ok: true, marked: pending ? 0 : batch.changes.length, audited: batch.changes.length, ...plan, ...coverage,
    changes: pending ? [] : plan.changes, remainingChanges: pending ? plan.changes : [] };
}
