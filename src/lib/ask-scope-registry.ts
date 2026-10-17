import { caseFoldProtected } from "./ask-scope-case-policy.js";

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
const protectedExact = (path: string): boolean => /(?:^|\/)(?:recovery-key-(?:class|defaults)|ask-scope-[^/]*|order-ask[^/]*|order-deliver-scope[^/]*)\.ts$/.test(path)
  || path.startsWith("scripts/guard/");
/** Ask and delivery share this verdict; case variants are folded per askScopeCaseFold (ask-scope-case-policy.ts). */
export const scopeProtected = (path: string): boolean => caseFoldProtected("protected", path, protectedExact);

/** Permission decisions require a human scope answer even when the proposed edit is only wiring. */
const SCOPE_PERMISSION_FILES = [
  "src/lib/peer-scope-gate.ts", "src/lib/peer-secret-gate.ts", "src/lib/order-tool-route.ts", "src/lib/caller-identity.ts",
  "src/bridge/api-auth.ts", "src/bridge/terminal-auth.ts", "src/bridge/interrupt-gate.ts", "src/bridge/web-gateway.ts",
  "src/bridge/local-api/control.ts", "src/bridge/local-api/shared-projects-auth.ts",
] as const;

const wireExact = (path: string): boolean => protectedExact(path)
  || (SCOPE_PERMISSION_FILES as readonly string[]).includes(path)
  || /(?:-gate|-auth|auth-)/.test(path.slice(path.lastIndexOf("/") + 1)) || /^src\/lib\/ledger-checks[^/]*\.ts$/.test(path);
export const scopeWireProtected = (path: string): boolean => caseFoldProtected("wire", path, wireExact);

/** A case variant of a registry table path is another spelling, never that entry's grant (nor a wiring target). */
export const scopeRegistryVariant = (path: string): boolean => caseFoldProtected("registry", path, () => false,
  (folded) => ASK_SCOPE_REGISTRY.some((r) => r.path.toLowerCase() === folded));
