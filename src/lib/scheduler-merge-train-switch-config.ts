/** Merge train switch (i28-MT1sw), the scheduler.json side: a leaf so scheduler-config.ts can parse it without import cycles. */
export type MergeTrainMode = "on" | "observe" | "off";
export const MERGE_TRAIN_MODES: readonly MergeTrainMode[] = ["on", "observe", "off"];
export const isMergeTrainMode = (v: unknown): v is MergeTrainMode => MERGE_TRAIN_MODES.includes(v as MergeTrainMode);

/** `projects.<id>.mergeTrain`; absent = on (no key written), anything else is a config error like every other project key. */
export function mergeTrainField(id: string, raw: unknown): { mergeTrain?: MergeTrainMode } {
  if (raw === undefined) return {};
  if (!isMergeTrainMode(raw)) throw new Error(`scheduler project ${id}: mergeTrain must be on / observe / off`);
  return { mergeTrain: raw };
}
