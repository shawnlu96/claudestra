/** Project-level mechanical exceptions. A declaration is provisional until the exact delivery diff satisfies its check. */
export const ASK_SCOPE_REGISTRY = [
  { path: "src/lib/scheduler-v2-skip-effects.ts", kind: "effects", shapes: ["add", "delete", "count", "sort"],
    check: "skip-effects --check (headScan / parseInventory); registry-order; own entries only" },
  { path: "src/lib/recovery-keys.ts", kind: "keys", shapes: ["add", "delete"], check: "recoveryKeysOrderProblem; own keys only" },
  { path: "src/lib/scheduler-v2-skip-paths.ts", kind: "skip-commands", shapes: ["add"], check: "SKIP_LEDGER_COMMANDS: own new commands only" },
  { path: "src/lib/scheduler-v2-ledger-cmds-args.ts", kind: "command-rules", shapes: ["add"], check: "SCHEDULER_V2_LEDGER_COMMANDS: own new commands only" },
  { path: "src/lib/shared-ledger-gate-cli-services.ts", kind: "services", shapes: ["add"], check: "SCHEDULER_SERVICE_COMMANDS: own new commands only" },
  { path: "src/manager/ledger.ts", kind: "manager", shapes: ["add"], check: "one import + one own command-table spread" },
] as const;

type ScopeKind = (typeof ASK_SCOPE_REGISTRY)[number]["kind"] | "wire";
export interface ScopeGrant { path: string; kind: ScopeKind; check: string; source?: string }

/** These files define the authority boundary, rather than wiring a new implementation into a caller. */
export const scopeProtected = (path: string): boolean => /(?:^|\/)(?:recovery-key-(?:class|defaults)|ask-scope-[^/]*|order-ask[^/]*|order-deliver-scope[^/]*)\.ts$/.test(path)
  || path.startsWith("scripts/guard/");
