/**
 * SWAPFIX1's switch and sample port, shared by its three family-swap self-heals: taking over a clean old author tree (9a, key
 * fixLocalSwap), resuming after a proven earlier reclaim (9b, key lendReclaimIntent) and clearing a half-built author session (2,
 * key authorRebuild). No new key: each reads its existing recovery key. observe records the would-be action once through
 * recordObserved (a recovery_observe note); on acts and records a same-named `fix_swap_selfheal` note. Both dedup on card + head +
 * action. tests/fix-swap-halfbuilt*.test.ts, tests/fix-strategy-worktree*.test.ts, tests/lend-reclaim-scheduler*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

export type SelfHealKey = "fixLocalSwap" | "lendReclaimIntent" | "authorRebuild";
type SelfHealAction = "tree-adopt" | "reclaim-resume" | "halfbuilt-rebuild";

const policies = new WeakMap<Database, RecoveryPolicyPort>();
/** Tests inject a policy per ledger (the setReclaimLocalFixPolicy pattern); the service reads recovery-policy.json. */
export const setSelfHealPolicy = (db: Database, p: RecoveryPolicyPort): void => void policies.set(db, p);
export const selfHealMode = (db: Database, project: string, key: SelfHealKey): RecoveryMode => (policies.get(db) ?? recoveryPolicy)(project, key).mode;

export interface SelfHealSample {
  project: string; key: SelfHealKey; taskId: string; head: string; action: SelfHealAction;
  /** what the action does, read after「本会」under observe */
  text: string;
  /** distinguishes repeated samples of one action on one head (the half-built attempt number) */
  nth?: number;
  data?: Record<string, unknown>;
}

const actionKey = (s: SelfHealSample) => `${s.action}:${s.head.slice(0, 12)}${s.nth ? `:n${s.nth}` : ""}`;
const selfHealDedupKey = (s: Pick<SelfHealSample, "taskId" | "head" | "action" | "nth">): string =>
  `fix-swap-selfheal:${s.taskId}:${s.head}:${s.action}${s.nth ? `:n${s.nth}` : ""}`;

/** One sample per card + head + action: recovery_observe under observe, fix_swap_selfheal under on. */
export function selfHealSample(db: Database, mode: "observe" | "on", s: SelfHealSample, now: number): void {
  const data = { ...s.data, head: s.head, action: s.action, ...(s.nth ? { nth: s.nth } : {}) };
  if (mode === "observe") {
    recordObserved(db, { project: s.project, mechanism: s.key, target: s.taskId, actionKey: actionKey(s), action: s.text, data }, now);
    return;
  }
  const dedupKey = selfHealDedupKey(s);
  tx(db, () => {
    if (getEventByDedup(db, dedupKey)) return;
    appendEvent(db, { actor: "scheduler", now, dedupKey }, { project: s.project, target: s.taskId, kind: "note",
      text: `换家族自愈（${s.key}）：${s.text}`.slice(0, 600), data: { ...data, op: "fix_swap_selfheal", mechanism: s.key } });
  });
}
