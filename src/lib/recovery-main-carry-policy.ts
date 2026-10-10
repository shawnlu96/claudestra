/**
 * MAINP2 switch: the formal PM main-carry transaction (review-main-carry-manual.ts) reads its mode through the one recovery
 * policy (recovery-policy.ts, key `mainCarry`), never its own flag. Default observe. on: a proven carry may be written;
 * observe: report the plan and evidence only; off: refuse. An unreadable file / unknown key reads as off (conservative stop).
 * No mode widens any gate: the engine's single/multi-hop carry, review, CI and lock gates stay as they are. Production on is
 * the PM's own `ledger scheduler-recovery <project> on --key mainCarry`, never a default here. tests/recovery-main-carry-policy.test.ts.
 */
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

export const MAIN_CARRY_KEY = "mainCarry" as const;

export interface MainCarryMode { mode: RecoveryMode; source: "config" | "default" | "error"; diagnostic?: string }

/** Read every time (no cache), never throws: whatever the port says, an error source is off. */
export function mainCarryMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): MainCarryMode {
  try {
    const p = policy(project, MAIN_CARRY_KEY);
    if (p.source === "error") return { mode: "off", source: "error", diagnostic: p.diagnostic ?? "恢复策略读不了" };
    if (!["on", "observe", "off"].includes(p.mode)) return { mode: "off", source: "error", diagnostic: `未知模式 ${String(p.mode)}` };
    return { mode: p.mode, source: p.source };
  } catch (e) {
    return { mode: "off", source: "error", diagnostic: `恢复策略读取异常：${(e as Error).message.slice(0, 200)}` };
  }
}
