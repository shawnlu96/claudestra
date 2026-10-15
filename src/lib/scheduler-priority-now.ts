/** now only overrides the feature switch; every other existing gate remains authoritative. */
import type { Database } from "bun:sqlite";
import type { Feature } from "./ledger-feature.js";
import { readPriority, readPriorityModes } from "./ledger-priority-read.js";
import type { AutostartSwitch } from "./scheduler-autostart.js";
import { switchOff } from "./shared-ledger-gate-switch.js";

export function priorityNowNode(db: Database, f: Feature, key: string): boolean {
  return readPriority(db, f.project, { kind: "node", id: f.id, nodeKey: key }).effective === "now";
}

export function priorityNowSwitch(db: Database, f: Feature, sw: AutostartSwitch, key?: string, observe = false): string | null {
  const legacy = switchOff(sw, f.id);
  if (!legacy || sw.off || key === undefined || !(readPriorityModes(db, f.project).priorityNowStart.mode === "on" || observe)) return legacy;
  return priorityNowNode(db, f, key) ? null : legacy;
}
