import type { Principal } from "../../lib/principals.js";
import type { InstanceKey } from "../../lib/instance-key.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "../../lib/shared-ledger-client.js";
import { resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "../../lib/shared-ledger-mode.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "../../lib/shared-ledger-scrub.js";
import { parseSharedLedgerCommand } from "../../lib/shared-ledger-contract-validation.js";
import { parseSharedLedgerImport, parseSharedLedgerProjection } from "../../lib/shared-ledger-contract-transfer.js";
import { SHARED_LEDGER_MAX_BODY_BYTES } from "../../lib/shared-ledger-contract.js";
import { parseActivityCursor } from "../../lib/shared-ledger-contract-reads.js";

export interface SharedLedgerProxyDeps {
  stateDir: string;
  centerId: string;
  teamId: string;
  projectId: string;
  key: InstanceKey;
  scrub: SharedLedgerScrubContext;
  /** Injected by authenticated transport. Web principals cannot choose a service subject via request JSON. */
  serviceSubject?: (principal: Principal) => string | null;
  fetch?: typeof fetch;
}
const json = (status: number, body: unknown) => Response.json(body, { status });
function actionFor(resource: string, method: string): SharedLedgerLocalCredential["projects"][number]["actions"][number] | null {
  if (method === "GET" && /^(?:features(?:\/[A-Za-z0-9_.:-]+)?|commands\/[A-Za-z0-9_.:-]+)$/.test(resource)) return "read";
  if (method === "GET" && (resource === "ext-capabilities" || extRead(resource))) return "read";
  if (method !== "POST") return null;
  return resource === "commands" ? "plan" : resource === "imports" ? "import" : resource === "projections" ? "project" : null;
}
/** Add-only reads (P1-D): versions, and activity after a canonical non-negative cursor in the path. */
function extRead(resource: string): { featureId: string; after: number | null } | null {
  const m = /^features\/([A-Za-z0-9_.:-]+)\/(versions|activity\/([^/]+))$/.exec(resource);
  if (!m) return null;
  if (m[2] === "versions") return { featureId: m[1]!, after: null };
  const after = parseActivityCursor(m[3]!);
  return after === null ? null : { featureId: m[1]!, after };
}
/** C5 calls this only after local session authentication; no local owner/PM role grants central authority. */
export async function handleSharedLedgerApi(req: Request, path: string, principal: Principal, deps: SharedLedgerProxyDeps): Promise<Response | null> {
  const match = /^\/(?:api\/v1\/)?shared-ledger\/(.+)$/.exec(path);
  if (!match) return null;
  const resource = match[1];
  const action = actionFor(resource, req.method);
  if (!action || new URL(req.url).search) return json(400, { error: "unsupported shared ledger route" });
  if (principal.disabled || principal.peer) return json(403, { error: "shared ledger identity unavailable" });
  try {
    const service = deps.serviceSubject?.(principal);
    const credential = resolveSharedLedgerCredential(service ?? principal.id, service ? "service" : "person",
      deps.centerId, deps.teamId, deps.projectId, action, deps.stateDir);
    if (!credential) return json(403, { error: "shared ledger identity unavailable" });
    const client = new SharedLedgerClient(credential, deps.key, { fetch: deps.fetch, scrub: deps.scrub });
    if (req.method === "GET") {
      if (resource.startsWith("commands/")) return json(200, await client.receipt(resource.slice("commands/".length)));
      // Team-level booleans only, but the credential above already required read on this project.
      if (resource === "ext-capabilities") return json(200, await client.extCapabilities());
      const ext = extRead(resource);
      if (ext) {
        const read = ext.after === null ? await client.versions(ext.featureId) : await client.activity(ext.featureId, ext.after);
        return read.projectId === deps.projectId ? json(200, read) : json(403, { error: "project unavailable" });
      }
      const result = resource === "features" ? await client.features() : await client.feature(resource.slice("features/".length));
      if ("features" in result) return json(200, { ...result, features: result.features.filter((f) => f.projectId === deps.projectId) });
      if (result.feature.projectId !== deps.projectId) return json(403, { error: "project unavailable" });
      return json(200, result);
    }
    const body = await req.text();
    if (Buffer.byteLength(body) > SHARED_LEDGER_MAX_BODY_BYTES) return json(413, { error: "payload too large" });
    const raw = JSON.parse(body) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(400, { error: "invalid body" });
    // These untrusted hints never affect credential selection, grants or central request payloads.
    const { actor: _actor, role: _role, ...payload } = raw;
    if (resource === "commands") {
      const command = scrubSharedLedger(payload, parseSharedLedgerCommand, deps.scrub);
      if (command.projectId !== deps.projectId) return json(403, { error: "project unavailable" });
      return json(200, await client.command(command));
    }
    if (resource === "imports") {
      const imported = scrubSharedLedger(payload, parseSharedLedgerImport, deps.scrub);
      if (imported.manifest.projectId !== deps.projectId) return json(403, { error: "project unavailable" });
      return json(200, await client.import(imported));
    }
    const projection = scrubSharedLedger(payload, parseSharedLedgerProjection, deps.scrub);
    if (projection.projectId !== deps.projectId) return json(403, { error: "project unavailable" });
    return json(200, await client.projection(projection));
  } catch (error) {
    if (error instanceof SharedLedgerRemoteError) return json(error.status, error.response);
    if (error instanceof SharedLedgerScrubError) return json(400, { error: "upload blocked", fields: error.fields });
    if (error instanceof SyntaxError) return json(400, { error: "invalid JSON" });
    // Credentials and server/transport exception messages can contain secrets; return a fixed offline error.
    return json(503, { error: "shared ledger unavailable; outcome unconfirmed" });
  }
}
