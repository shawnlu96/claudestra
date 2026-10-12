/**
 * S2F8 · command routing helpers for the stage-two composition core (shared-ledger-v2-wiring.ts).
 * Commands name center ids; local mode records hang on local feature ids (an N7 replica is `n7-` + 10 hex of the center uuid).
 * The only mapping is the binding the mode file already records (centerExecution / centerPlanned); nothing here invents one.
 * Tests: tests/shared-ledger-v2-wiring-routing.test.ts.
 */
import { join } from "node:path";
import { readJsonStateSync } from "./state-file.js";

export interface CenterFeatureScope { centerId: string; teamId: string; projectId: string }
type Bound = Partial<CenterFeatureScope> & { centerFeatureId?: unknown };

/** The local feature whose mode record is bound to this center feature; none or more than one = null (the gate refuses).
 *  This only picks the id: the gate still rereads and validates the mode file through readSharedLedgerMode. */
export function localFeatureOfCenter(dir: string, scope: CenterFeatureScope, centerFeatureId: string): string | null {
  const state = readJsonStateSync(join(dir, "shared-ledger-modes.json"));
  const features = state.status === "ok" ? (state.data as { features?: unknown } | null)?.features : null;
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  const found = Object.entries(features as Record<string, { centerExecution?: Bound; centerPlanned?: Bound } | null>).filter(([, m]) => {
    const b = m?.centerExecution ?? m?.centerPlanned;
    return !!b && b.centerId === scope.centerId && b.teamId === scope.teamId && b.projectId === scope.projectId
      && b.centerFeatureId === centerFeatureId;
  });
  return found.length === 1 ? found[0]![0] : null;
}

/** Task id a command names at the top level or inside its result / claim (operation.result, lend.claim, lend.result). */
export function commandTaskId(payload: Record<string, unknown>): string | null {
  if (typeof payload.taskId === "string") return payload.taskId;
  const nested = payload.result ?? payload.claim;
  const taskId = nested && typeof nested === "object" ? (nested as Record<string, unknown>).taskId : null;
  return typeof taskId === "string" ? taskId : null;
}
/** dep.set / dep.remove name two cards and nothing else. */
export function commandDepTasks(payload: Record<string, unknown>): [string, string] | null {
  return typeof payload.fromTask === "string" && typeof payload.toTask === "string" ? [payload.fromTask, payload.toTask] : null;
}
