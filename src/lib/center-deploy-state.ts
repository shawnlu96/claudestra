/** Center deployments keep launchd attempt identity separately from the ordinary merge/deploy journal. */
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import type { DeployRun } from "./scheduler-deploy.js";
import type { CenterProof } from "./center-deploy-proof.js";
import type { CenterResult } from "./center-deploy-worker.js";

export interface CenterState {
  observedSha?: string;
  successfulCards?: Record<string, string[]>; cardKeys?: Record<string, string>; proofVersion?: string;
  probe?: { at: number; version: string; cards: string; proof: CenterProof };
  successSha?: string; terminalSha?: string; proof?: CenterProof; askId?: string; run?: DeployRun;
  result?: CenterResult; noticeClaimed?: boolean; attempt?: number;
}
const centerStatePath = (project: string): string => {
  if (!/^[\w.-]{1,80}$/.test(project)) throw new Error("invalid center project");
  return statePath("center-deploy", `${project}.json`);
};
export function readCenterState(project: string): CenterState {
  const r = readJsonStateSync(centerStatePath(project));
  if (r.status === "missing") return {};
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") throw new Error("中心部署状态不可读");
  return r.data as CenterState;
}
export const writeCenterState = (project: string, state: CenterState): void => writeJsonAtomicSync(centerStatePath(project), state, { mode: 0o600 });
