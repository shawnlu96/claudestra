import type { Principal } from "../../lib/principals.js";
import { digest, id, parseCommand, record } from "../../lib/shared-ledger-contract-v2.js";
import { readBoundedRequestBody, RequestBodyError } from "../../lib/request-body.js";
import { apiJson } from "../api-respond.js";
import { requireSharedExecEntry, sharedExecCommand, sharedExecEntryPort, SharedExecEntryError, sharedExecEntryFailure } from "../shared-ledger-v2-entry.js";

const ROOT = "/shared-exec";
function scope(principal: Principal, project: string) {
  const p = requireSharedExecEntry(project);
  if (!p.scopeFor) throw new SharedExecEntryError(503, "v2_unmapped");
  const result = p.scopeFor(principal, project);
  if (!result) throw new SharedExecEntryError(403, "forbidden");
  return { teamId: id(result.teamId), projectId: id(result.projectId) };
}
async function route(req: Request, path: string, principal: Principal, url: URL): Promise<Response> {
  if (principal.disabled || principal.peer) throw new SharedExecEntryError(403, "forbidden");
  if (path === `${ROOT}/commands` && req.method === "POST") {
    const raw = record(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, 300_000))));
    // parseCommand also rejects nested actor/role fields; neither can be used to select a credential.
    if ("actor" in raw || "role" in raw) throw new SharedExecEntryError(400, "invalid_field");
    const command = parseCommand(raw);
    const project = id(url.searchParams.get("project") ?? command.projectId);
    const p = sharedExecEntryPort();
    if (p?.commandRoute) {
      const route = p.commandRoute(principal, project, command);
      // Resolve ask/order/dependency targets in the injected router; a caller-selected payload id is not a local routing fact.
      if (typeof route === "object" && route.reason === "migrating") throw new SharedExecEntryError(409, "migrating");
      requireSharedExecEntry(project, true);
      if (typeof route === "object") throw new SharedExecEntryError(503, route.reason);
      if (route !== "central") throw new SharedExecEntryError(403, "execution_not_shared");
    } else {
      requireSharedExecEntry(project, true);
      throw new SharedExecEntryError(503, "v2_unmapped");
    }
    return apiJson(200, await sharedExecCommand(principal, project, command));
  }
  const match = /^\/shared-exec\/(features|receipts|asks)\/([^/]+)$/.exec(path);
  if (!match || req.method !== "GET") throw new SharedExecEntryError(404, "not_found");
  const entity = id(decodeURIComponent(match[2]!)), project = id(url.searchParams.get("project"));
  const p = requireSharedExecEntry(project);
  if (match[1] === "features") return apiJson(200, await p.snapshot(principal, project, entity));
  const target = scope(principal, project);
  if (match[1] === "receipts") {
    const operation = url.searchParams.get("operationId");
    const query = { ...target, requestId: entity, operationId: operation === null || operation === "" ? null : id(operation),
      commandDigest: digest(url.searchParams.get("commandDigest")) };
    return apiJson(200, await p.receipt(principal, query));
  }
  const client = p.clientFor(principal, project);
  if (!client) throw new SharedExecEntryError(503, "unavailable");
  return apiJson(200, await client.queryAsk({ ...target, askId: entity }));
}
/** Exact new family: the existing /shared-ledger gate proxy never handles these routes. */
export async function handleSharedExecApi(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (path !== `${ROOT}/commands` && !/^\/shared-exec\/(features|receipts|asks)\/[^/]+$/.test(path)) return null;
  try { return await route(req, path, principal, url); }
  catch (error) {
    const failure = error instanceof RequestBodyError ? { status: error.status, code: error.code }
      : error instanceof SyntaxError || error instanceof URIError ? { status: 400, code: "invalid_field" } : sharedExecEntryFailure(error);
    return apiJson(failure.status, { ok: false, code: failure.code });
  }
}
