/** Compact /work wire contract; the browser never imports backend modules. */
export interface WorkRow {
  taskId: string | null; featureId: string | null; nodeKey: string | null; title: string;
  who: string | null; machine: string; step: 'restate' | 'write' | 'review' | 'fix' | 'merge' | 'deploy' | 'publishing' | null;
  round: number; since: number; normalMinutes: number; remainingMinutes: number; overMinutes: number;
  reason: string | null; code: string | null; estimate: string;
}
export interface WorkBoard {
  now: number; asOfSeq: number; working: WorkRow[]; waiting: WorkRow[]; todo: { ready: WorkRow[]; blocked: WorkRow[] };
  legacyTotal?: number;
  legacy?: { taskId: string; title: string; stage: string }[];
  machines: Record<string, number>; completionHours: number | null; availableSlots: number;
}
