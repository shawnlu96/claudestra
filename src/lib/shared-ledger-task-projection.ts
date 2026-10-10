/**
 * One task → SharedLedgerTaskProjection, shared by the import export (shared-ledger-export.ts) and the mirror push
 * (shared-ledger-projector.ts). Callers differ only in sourceSeq, summary, member code and executor; every field rule lives here.
 */
import type { Database } from "bun:sqlite";
import type { listTasks } from "./ledger-store.js";
import { listSteps } from "./ledger-steps.js";
import type { SharedLedgerTaskProjection } from "./shared-ledger-contract.js";

type Task = ReturnType<typeof listTasks>[number];
export interface TaskProjectionInput {
  sourceSeq: number; stepSeq: number; specSummary: string; specDigest: string | null;
  assigneeCode: string | null; executorInstanceId: string;
  /** Task ids sent for the same feature in this export / push; deps from anywhere else are dropped. */
  featureTaskIds: ReadonlySet<string>;
  edges: readonly { from: string; to: string }[];
  /** Lowercase commits the install repo knows; any other head (short, private, unknown) is sent as null, never as raw text. */
  commits: ReadonlySet<string>;
}

const projectionHead = (head: string | null, commits: ReadonlySet<string>) =>
  head && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) && commits.has(head) ? head : null;
const projectionPr = (pr: string | null) => pr && /^\d+$/.test(pr) && Number(pr) > 0 ? Number(pr) : null;

export function sharedLedgerTaskProjection(db: Database, task: Task, input: TaskProjectionInput): SharedLedgerTaskProjection {
  const asks = db.prepare("SELECT kind, state, blocking FROM asks WHERE taskId = ? AND source NOT IN ('auq','permission','codex') ORDER BY id")
    .all(task.id) as { kind: string; state: string; blocking: number | null }[];
  return { sourceTaskId: task.id, sourceRev: task.rev, sourceSeq: input.sourceSeq, stage: task.stage,
    assigneeCode: input.assigneeCode, executorInstanceId: input.executorInstanceId,
    pr: projectionPr(task.pr), head: projectionHead(task.headSHA, input.commits),
    // Only edges inside the same feature: the center maps deps by source id and rejects unknown ones.
    deps: input.edges.filter((d) => d.to === task.id && input.featureTaskIds.has(d.from)).map((d) => d.from).sort(),
    specSummary: input.specSummary, specDigest: input.specDigest, fullText: "home_only",
    steps: listSteps(db, task.id).filter((s) => !s.derived).map((s) => ({ sourceStepId: `${s.step}:${s.round}`,
      sourceRev: s.rev, sourceSeq: input.stepSeq, state: s.state })),
    asks: asks.map((a) => ({ kind: a.kind, state: a.state, blocking: a.blocking === 1 })) };
}
