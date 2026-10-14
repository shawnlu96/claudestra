export const PRIORITY_BANDS = ["now", "next", "later"] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];
export const PRIORITY_MODES = ["off", "observe", "on"] as const;
export type PriorityMode = (typeof PRIORITY_MODES)[number];
export const PRIORITY_MECHANISMS = ["prioritySort", "priorityNowStart", "priorityStall", "priorityPanel"] as const;
export type PriorityMechanism = (typeof PRIORITY_MECHANISMS)[number];
export type PriorityTarget = { kind: "feature"; id: string } | { kind: "task"; id: string }
  | { kind: "node"; id: string; nodeKey: string };
export interface PriorityEvidence {
  ownerWords: string;
  ownerAt: number;
  sourceRef: string;
}
export interface PriorityContext {
  actor: string;
  project: string;
  now?: number;
  dedupKey: string;
}
export interface PriorityRecord {
  id: string;
  project: string;
  kind: "feature" | "work";
  featureId: string | null;
  nodeKey: string | null;
  taskId: string | null;
  band: PriorityBand | null;
  rev: number;
  archived: number;
  mergedInto: string | null;
}
export interface PriorityView {
  recordId: string | null;
  rev: number;
  explicit: PriorityBand | null;
  effective: PriorityBand;
  source: "explicit" | "feature" | "system";
  inheritedFrom: string | null;
  ownerRegistered: boolean;
  note: string | null;
  order: number | null;
  queue: string;
  legacyPriority: string | null;
}
