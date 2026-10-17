/**
 * SCOPECASE1: one case-folded protection verdict shared by the ask (planScope) and delivery (judgeScopeFile /
 * checkDeliveredScope) paths. Only a path whose original spelling escapes a rule while its lower-case spelling hits it
 * reads the switch `askScopeCaseFold`: on = protected (hand to a human); observe = one observation note, verdict
 * unchanged; off = baseline. The original path stays the identity for realpath / tracked / grant matching.
 * Rollback: `ledger scheduler-recovery claude-orchestrator off --key askScopeCaseFold --reason ...` (read per call).
 */
import { createHash } from "node:crypto";
import { openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type ObservedAction, type RecoveryKey, type RecoveryPolicyPort } from "./recovery-policy.js";

export const ASK_SCOPE_CASE_KEY: RecoveryKey = "askScopeCaseFold";
/** The registry is Claudestra's own; private repos never reach it (ask-scope-auto.ts livePlan). */
const PROJECT = "claude-orchestrator";

export interface AskScopeCasePort { policy: RecoveryPolicyPort; observe(a: ObservedAction): void }
const PRODUCTION: AskScopeCasePort = {
  policy: recoveryPolicy,
  observe: (a) => { recordObserved(openLedger(), a, Date.now()); },
};
let port = PRODUCTION;
const seen = new Set<string>();
/** Tests only: swap the policy / ledger port (no argument restores production). */
export function useAskScopeCasePort(p?: AskScopeCasePort): void { port = p ?? PRODUCTION; seen.clear(); }

const foldScopePath = (path: string): string => path.toLowerCase();

/**
 * legacy = the case-sensitive rule on the original path, folded = the same rule on the folded path. Folding only ever
 * adds protection; when both agree no switch is read.
 */
export function caseFoldProtected(rule: string, path: string, legacy: (p: string) => boolean, folded: (p: string) => boolean = legacy): boolean {
  if (legacy(path)) return true;
  const lower = foldScopePath(path);
  if (lower === path || !folded(lower)) return false;
  let mode: string;
  try { mode = port.policy(PROJECT, ASK_SCOPE_CASE_KEY).mode; } catch { mode = "off"; }
  if (mode === "on") return true;
  if (mode === "observe") {
    const actionKey = `case:${rule}:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
    if (!seen.has(actionKey)) {
      seen.add(actionKey);
      try {
        port.observe({ project: PROJECT, mechanism: ASK_SCOPE_CASE_KEY, target: "", actionKey,
          action: `按保护文件拦下大小写变体 ${JSON.stringify(path).slice(0, 200)}（${rule}）`, data: { path, folded: lower, rule } });
      } catch (e) {
        seen.delete(actionKey);
        console.error(`askScopeCaseFold 观察未能记账：${(e as Error).message}`);
      }
    }
  }
  return false;
}
