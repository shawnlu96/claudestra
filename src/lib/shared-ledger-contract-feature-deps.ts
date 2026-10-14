/** Independent `feature-deps` endpoint: closed V1 feature responses cannot carry extra fields.
 * Old centers answer 403 (catch-all forbidden). Only structural edges travel here:
 * never notes, evidence, locks, resource paths or card ids. Schema is the only import so the center can vendor it.
 */
import { array, boolean, choice, id, integer, invalid, literal, object, positive, unique } from "./shared-ledger-contract-schema.js";

export const FEATURE_DEPS_RESOURCE = /^feature-deps$/;
export interface FeatureDep {
  projectId: string; from: string; to: string; kind: "split" | "declared" | "task"; satisfied: boolean; count: number;
}
export interface FeatureDepsUpload { schemaVersion: 1; teamId: string; sourceInstanceId: string; edges: FeatureDep[] }
export interface FeatureDeps { schemaVersion: 1; teamId: string; edges: FeatureDep[]; updatedAt: number }
const edge = object({ projectId: id, from: id, to: id, kind: choice(["split", "declared", "task"]), satisfied: boolean, count: positive });
const edges = (value: unknown): FeatureDep[] => {
  const parsed = array(edge, 2000)(value);
  unique(parsed.map((e) => JSON.stringify([e.projectId, e.from, e.to, e.kind])));
  if (parsed.some((e) => e.from === e.to)) invalid();
  return parsed;
};
const upload = object({ schemaVersion: literal(1), teamId: id, sourceInstanceId: id, edges });
const read = object({ schemaVersion: literal(1), teamId: id, edges, updatedAt: integer });
const receipt = object({ schemaVersion: literal(1), accepted: integer });
export function parseFeatureDepsUpload(value: unknown): FeatureDepsUpload { return upload(value); }
export function parseFeatureDeps(value: unknown): FeatureDeps { return read(value); }
export function parseFeatureDepsReceipt(value: unknown): { schemaVersion: 1; accepted: number } { return receipt(value); }
