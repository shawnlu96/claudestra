import { STATE_DIR } from "./paths.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential } from "./shared-ledger-mode.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { localIdentity } from "./peer-pr-redact.js";
import type { Principal } from "./principals.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

type Binding = SharedLedgerBinding;
interface ProxyContext extends Binding { stateDir: string; key: InstanceKey; scrub: SharedLedgerScrubContext }
type Handler = (req: Request, path: string, principal: Principal, deps: ProxyContext) => Promise<Response | null>;
export interface SharedLedgerGateProxyOptions {
  stateDir?: string;
  key?: () => InstanceKey | null;
}
/** Web callers name the center project they are viewing; the value only selects among the principal's own bindings. */
export const SHARED_LEDGER_PROJECT_HEADER = "x-shared-ledger-project";
const unavailable = () => Response.json({ error: "shared ledger identity unavailable" }, { status: 403 });
/** Selection comes from persistent bindings and authenticated principal; request hints grant no authority. */
export async function sharedLedgerGateProxy(req: Request, path: string, principal: Principal, handler: Handler,
  options: SharedLedgerGateProxyOptions = {}): Promise<Response | null> {
  if (!path.startsWith("/shared-ledger/")) return null;
  if (principal.disabled || principal.peer) return unavailable();
  const dir = options.stateDir ?? STATE_DIR;
  try {
    const available = readSharedLedgerBindings(dir).flatMap(b => {
      const c = resolveSharedLedgerCredential(principal.id, "person", b.centerId, b.teamId, b.projectId, "read", dir);
      return c ? [{ binding: b, secret: c.bearer, identity: { center: c.centerId, team: c.teamId, person: c.personId,
        project: b.projectId, ...(b.localProjectId ? { localProjectId: b.localProjectId } : {}), homeInstanceId: c.instanceId } }] : [];
    });
    if (path === "/shared-ledger/context" && req.method === "GET") {
      return Response.json({ identities: available.map(v => v.identity) });
    }
    // Without a project hint only an unambiguous single binding is used; several bindings never pick an arbitrary authority.
    const wanted = req.headers.get(SHARED_LEDGER_PROJECT_HEADER);
    const chosen = wanted === null ? available : available.filter(v => v.binding.projectId === wanted);
    if (wanted === null && available.length > 1) {
      return Response.json({ code: "shared_ledger_project_required", error: "select a shared ledger project",
        projects: available.map(v => v.binding.projectId) }, { status: 409 });
    }
    if (chosen.length > 1) return Response.json({ code: "shared_ledger_project_ambiguous", error: "shared ledger project is ambiguous" }, { status: 409 });
    if (chosen.length !== 1) return unavailable();
    const key = options.key ? options.key() : instanceKeySync(dir);
    if (!key) return Response.json({ error: "shared ledger unavailable" }, { status: 503 });
    return handler(req, path, principal, { ...chosen[0]!.binding, stateDir: dir, key, scrub: { identity: localIdentity(), knownSecrets: [chosen[0]!.secret] } });
  } catch {
    // Configuration and credential errors can contain secrets; callers get a fixed fail-closed response.
    return Response.json({ error: "shared ledger identity unavailable" }, { status: 503 });
  }
}
