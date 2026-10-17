/** /clear: 90s new + 40s config + 60s bootstrap + 30s registry + 30s watcher + 20s transport. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openLedger } from "../ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "../recovery-policy.js";
import { readRegistryAgentsSync } from "../registry.js";

export const CLEAR_BUDGET_VERSION = 1;
export const CLEAR_BUDGET_MS = 270_000;
const LEGACY_CLEAR_MS = 225_000;
const KEY = "acpClearBudget";

export class ClearBudget {
  private readonly started: number;
  private readonly allowance: number;
  constructor(readonly deadline: number, private readonly now = Date.now, private readonly mono = () => performance.now()) {
    if (!Number.isSafeInteger(deadline)) throw new Error("ACP clear deadline 无效");
    this.started = mono();
    this.allowance = Math.min(CLEAR_BUDGET_MS, deadline - now());
  }
  /** Wall-clock jumps cannot extend an admitted operation; every native wait receives this bound. */
  timeout(cap: number): number {
    const left = Math.floor(Math.min(this.deadline - this.now(), this.allowance - (this.mono() - this.started)));
    if (left <= 0) throw new Error("ACP clear 端到端预算已耗尽");
    return Math.min(cap, left);
  }
}

function clearBudgetProject(channelId: string): string {
  return readRegistryAgentsSync().find((a) => a.channelId === channelId)?.projectId ?? "claude-orchestrator";
}

export function clearBudgetMode(channelId: string): RecoveryMode {
  return recoveryPolicy(clearBudgetProject(channelId), KEY).mode;
}

/** No message text or config values: one durable sample per opaque target and protocol version. */
export function observeClearBudget(channelId: string, db?: Database): void {
  try {
    db ??= openLedger();
    recordObserved(db, { project: clearBudgetProject(channelId), mechanism: KEY,
      target: "", actionKey: `${createHash("sha256").update(channelId).digest("hex")}:protocol-${CLEAR_BUDGET_VERSION}`,
      action: "ACP clear 使用共享 270 秒期限；当前按原 225 秒契约执行", data: { version: CLEAR_BUDGET_VERSION } }, Date.now());
  } catch (e) {
    console.warn(`⚠️ ACP clear 预算观察记录失败：${e instanceof Error ? e.message : e}`);
  }
}

/** The host explicitly advertises its protocol in acp_config; the versioned clear request selects it. */
export function clearCallPlan(channelId: string, hostVersion: unknown, o: {
  mode?: () => RecoveryMode; observe?: () => void; now?: () => number;
} = {}): { timeoutMs: number; fields: Record<string, unknown> } {
  const mode = (o.mode ?? (() => clearBudgetMode(channelId)))();
  if (mode === "observe") (o.observe ?? (() => observeClearBudget(channelId)))();
  if (mode !== "on" || hostVersion !== CLEAR_BUDGET_VERSION) return { timeoutMs: LEGACY_CLEAR_MS, fields: {} };
  return { timeoutMs: CLEAR_BUDGET_MS,
    fields: { clearBudgetVersion: CLEAR_BUDGET_VERSION, deadline: (o.now ?? Date.now)() + CLEAR_BUDGET_MS } };
}

/** Old bridges never send a versioned deadline; unknown fields alone do not opt in. */
export function hostClearBudget(frame: Record<string, unknown>, channelId: string, mode = () => clearBudgetMode(channelId)): ClearBudget | undefined {
  if (frame.clearBudgetVersion !== CLEAR_BUDGET_VERSION || frame.deadline === undefined) return undefined;
  // Re-read for every new action. An already admitted operation keeps its bound even after a rollback.
  const current = mode();
  if (current === "observe") observeClearBudget(channelId);
  if (current !== "on") throw new Error("ACP clear 预算档位已改变，请重试");
  return new ClearBudget(frame.deadline as number);
}
