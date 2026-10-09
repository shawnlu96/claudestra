import type { Database } from "bun:sqlite";
import { getIntent } from "./ledger-scheduler.js";
import { LedgerError } from "./ledger-store.js";

type Target = "task" | "intent" | "session-intent";
type Handling = "central" | "executor" | "mixed" | "unmapped";
interface CommandRule { target: Target; handling: Handling }
const rule = (target: Target, handling: Handling): Readonly<CommandRule> => Object.freeze({ target, handling });

/** Explicit classification makes a new scheduler CLI call require a routing decision in the inventory test. */
export const SCHEDULER_V2_LEDGER_COMMANDS: Readonly<Record<string, Readonly<CommandRule>>> = Object.freeze({
  "scheduler-plan": rule("task", "mixed"),
  "scheduler-settle": rule("intent", "mixed"),
  "scheduler-stage": rule("intent", "central"),
  verify: rule("task", "central"),
  "scheduler-session-bind": rule("session-intent", "executor"),
  "scheduler-retire": rule("task", "executor"),
  "scheduler-session-retire": rule("session-intent", "executor"),
  "scheduler-merge-begin": rule("intent", "executor"),
  "scheduler-merge-step": rule("intent", "executor"),
  "scheduler-ui-ask": rule("intent", "unmapped"),
  "scheduler-review-snapshot": rule("intent", "unmapped"),
  "scheduler-model-outcome": rule("intent", "unmapped"),
  "scheduler-model-inform": rule("task", "unmapped"),
  "scheduler-refusal-epoch": rule("task", "unmapped"),
  "scheduler-legacy-review-retire": rule("task", "unmapped"),
  "lend-takeover": rule("task", "unmapped"),
  "manual-merge-claim": rule("task", "unmapped"),
  "memory-auto": rule("task", "unmapped"),
  "peer-pr-intake": rule("task", "unmapped"),
  "peer-pr-observe": rule("task", "unmapped"),
  "peer-pr-push-record": rule("task", "unmapped"),
  "scheduler-arbiter-delivery": rule("intent", "unmapped"),
  "scheduler-converge-notice": rule("task", "unmapped"),
  "scheduler-convergence": rule("intent", "unmapped"),
  "scheduler-deploy-begin": rule("intent", "unmapped"),
  "scheduler-fallback-manual": rule("task", "unmapped"),
  "scheduler-family-wait": rule("task", "unmapped"),
  "scheduler-fix-relay": rule("task", "unmapped"),
  "scheduler-lock-yield": rule("task", "unmapped"),
  "scheduler-merge-handoff": rule("task", "unmapped"),
  "scheduler-observe": rule("task", "unmapped"),
  "scheduler-plan-rejected": rule("task", "unmapped"),
  "scheduler-pool": rule("intent", "unmapped"),
  "scheduler-pool-refusal": rule("task", "unmapped"),
  "scheduler-review-swap": rule("intent", "unmapped"),
  "scheduler-sec-review-alarm": rule("task", "unmapped"),
  "scheduler-unclaimed": rule("intent", "unmapped"),
  "scheduler-unclaimed-sent": rule("intent", "unmapped"),
});

export interface SchedulerV2LedgerCall {
  command: string;
  argument: string;
  taskId: string;
  intentId: string | null;
  handling: Handling;
}

/** Resolve intent arguments before routing; an absent local intent is deliberately passed to the original manager. */
export function schedulerV2LedgerCall(db: Database, args: readonly string[]): SchedulerV2LedgerCall | null {
  if (args[0] !== "ledger" || !args[1] || !args[2]) return null;
  const command = args[1], argument = args[2];
  const entry = Object.hasOwn(SCHEDULER_V2_LEDGER_COMMANDS, command) ? SCHEDULER_V2_LEDGER_COMMANDS[command] : null;
  let intentId: string | null = null;
  // Future commands can arrive through spread/variable calls. An existing intent still determines their card.
  if (!entry && getIntent(db, argument)) intentId = argument;
  if (entry?.target === "intent") intentId = argument;
  if (entry?.target === "session-intent") {
    const index = args.indexOf("--intent", 3);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) return null;
    intentId = args[index + 1];
  }
  const taskId = intentId === null ? argument : getIntent(db, intentId)?.taskId;
  if (!taskId) return null;
  return { command, argument, taskId, intentId, handling: entry?.handling ?? "unmapped" };
}

/** Parsing happens only after central routing so local and skip calls retain their original CLI behavior. */
export function schedulerV2LedgerFlags(args: readonly string[], valued: readonly string[], bools: readonly string[] = []) {
  const flags: Record<string, string> = Object.create(null), switches = new Set<string>();
  for (let index = 3; index < args.length; index++) {
    const argument = args[index], key = argument.slice(2);
    if (!argument.startsWith("--") || (!valued.includes(key) && !bools.includes(key))) {
      throw new LedgerError("invalid", `未知参数 ${argument}`);
    }
    if (Object.hasOwn(flags, key) || switches.has(key)) throw new LedgerError("invalid", `重复参数 --${key}`);
    if (bools.includes(key)) { switches.add(key); continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new LedgerError("invalid", `缺少 --${key} 的值`);
    flags[key] = value;
  }
  const need = (key: string): string => {
    if (!Object.hasOwn(flags, key) || !flags[key].trim()) throw new LedgerError("invalid", `缺少 --${key}`);
    return flags[key];
  };
  const integer = (key: string): number => {
    const raw = need(key), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new LedgerError("invalid", `--${key} 必须是非负整数`);
    return value;
  };
  return { flags, switches, need, integer };
}

/** Read the durable first claim, never a later bind/result event from a different lease. */
export function schedulerV2LedgerClaimFence(db: Database, intentId: string): unknown | null {
  const intent = getIntent(db, intentId);
  if (!intent) return null;
  const row = db.query(`SELECT json_extract(data, '$.fence') AS fence FROM events
    WHERE target = ? AND kind = 'scheduler' AND actor = 'scheduler' AND json_extract(data, '$.id') = ?
      AND ((json_extract(data, '$.op') = 'settle' AND json_extract(data, '$.to') = 'submitted')
        OR (json_extract(data, '$.op') = 'plan' AND json_extract(data, '$.action') = 'retire'
          AND json_extract(data, '$.claimed') = 1))
    ORDER BY seq LIMIT 1`).get(intent.taskId, intentId) as { fence: string | null } | null;
  return row?.fence === null || row === null ? null : JSON.parse(row.fence);
}
