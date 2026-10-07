import type { Principal } from "../../lib/principals.js";
import { sharedProjectOwnerPrincipal } from "./shared-projects-auth.js";
import { readBoundedRequestBody, RequestBodyError } from "../../lib/request-body.js";
import { parseV2ProjectRecord, parseV2ProjectsRequest, parseV2ProjectsResponse } from "../../lib/shared-ledger-contract-v2-projects.js";
import { joinOfferProjectDisplay } from "../../lib/shared-ledger-join-offer.js";
import { authenticateApi } from "../api-auth.js";
import { apiJson } from "../api-respond.js";
import { sharedProjectsSnapshot, readSharedProjectsLocalSnapshot, type SharedProjectsLocalSnapshot, type SharedProjectsSnapshot } from "./shared-projects-snapshot.js";
import { sharedProjectsClientPorts, SHARED_PROJECTS_CAPABILITIES } from "./shared-projects-client.js";
import { SHARED_LEDGER_PROJECT_HEADER } from "../../lib/shared-ledger-gate-proxy.js";
import { sharedProjectsPorts } from "./shared-projects-runtime.js";
import { bootstrapSharedProject, createSharedProject, continueSharedProject, proposeSharedProject } from "./shared-projects-actions.js";
import { readSharedProjectCompletion } from "./shared-projects-completion.js";
import { requireProjectPerson, SharedProjectsError, type ProjectCreate, type ProjectPerson, type ProjectSelection, type SharedProjectsPorts } from "./shared-projects-ports.js";

const ROOT = "/api/v1/shared-projects";
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const OP = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export interface SharedProjectsRouteDeps {
  auth: (req: Request, url: URL) => Promise<Principal | Response>;
  /** The factory receives only the authenticated effective principal; it selects original scope from trusted local state. */
  ports?: SharedProjectsPorts | ((principal: Principal) => Promise<SharedProjectsPorts | undefined>);
  localSnapshot?: () => Promise<SharedProjectsLocalSnapshot>;
}
/** Actual authentication precedes original binding selection and canonical N2/N3 adapters. */
const live: SharedProjectsRouteDeps = { auth: (req, url) => authenticateApi(req, url, { rateLimit: true }) };

function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SharedProjectsError(400, "invalid_body");
  return v as Record<string, unknown>;
}
function keys(b: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(b).some(k => !allowed.includes(k))) throw new SharedProjectsError(400, "invalid_body");
}
function name(value: unknown): string {
  const p = joinOfferProjectDisplay({ teamId: "team", projectId: "project", name: value });
  if (!p) throw new SharedProjectsError(400, "invalid_name");
  return p.name;
}
function selection(value: unknown): ProjectSelection | undefined {
  if (value === undefined) return undefined;
  const b = record(value);
  keys(b, b.mode === "create" ? ["mode"] : ["mode", "localProjectId"]);
  if (b.mode === "create") return { mode: "create" };
  if (b.mode === "existing" && typeof b.localProjectId === "string" && ID.test(b.localProjectId)) return { mode: "existing", localProjectId: b.localProjectId };
  throw new SharedProjectsError(400, "invalid_selection");
}
function createInput(b: Record<string, unknown>, who: ProjectPerson): ProjectCreate {
  keys(b, ["operationId", "id", "name", "selection"]);
  if (typeof b.operationId !== "string" || !OP.test(b.operationId) || (b.id !== undefined && (typeof b.id !== "string" || !ID.test(b.id)))) {
    throw new SharedProjectsError(400, "invalid_body");
  }
  const input = parseV2ProjectsRequest("create", { centerId: who.centerId, teamId: who.teamId,
    operationId: b.operationId, name: name(b.name), ...(b.id !== undefined ? { id: b.id } : {}) });
  return { operationId: input.operationId, name: input.name, ...(input.id ? { id: input.id } : {}), selection: selection(b.selection) };
}

/** Only public project fields leave the bridge, even when an injected center adapter returns extra fields. */
function publicProject(p: Awaited<ReturnType<SharedProjectsPorts["list"]>>[number], d: SharedProjectsPorts) {
  p = parseV2ProjectRecord(p);
  const display = joinOfferProjectDisplay({ teamId: p.teamId, projectId: p.projectId, name: p.name });
  if (!display || !Number.isSafeInteger(p.rev) || !["active", "archived"].includes(p.status)) throw new SharedProjectsError(503, "invalid_center_response");
  const bindings = d.bindings().filter(b => b.centerId === p.centerId && b.teamId === p.teamId && b.projectId === p.projectId);
  return { ...display, centerId: p.centerId, rev: p.rev, status: p.status, localProjectIds: bindings.map(b => b.localProjectId ?? b.projectId) };
}
async function memberAndLocalRoute(req: Request, path: string, b: Record<string, unknown>, d: SharedProjectsPorts): Promise<Response | null> {
  const m = /^\/api\/v1\/shared-projects\/([a-z0-9][a-z0-9_-]{0,31})\/(members|members\/([A-Za-z0-9_.:-]{1,128})\/remove|dirs|leave)$/.exec(path);
  if (!m) return null;
  const who = await d.person();
  requireProjectPerson(who);
  if (m[2] === "members" && req.method === "GET") {
    const result = parseV2ProjectsResponse("members", 200,
      { ok: true, v: 2, centerId: who.centerId, teamId: who.teamId, projectId: m[1], members: await d.members(who, m[1]!) },
      { centerId: who.centerId, teamId: who.teamId, projectId: m[1] });
    if (!result.ok) throw new SharedProjectsError(503, "invalid_center_response");
    const members = result.members;
    return apiJson(200, { ok: true, members: members.map(p => ({ personId: p.personId, code: p.code, role: p.role, status: p.status })) });
  }
  if (m[3] && req.method === "POST") {
    keys(b, []);
    await d.remove(who, m[1]!, m[3]);
    return apiJson(200, { ok: true });
  }
  if ((m[2] === "dirs" && req.method === "PATCH") || (m[2] === "leave" && req.method === "POST")) {
    keys(b, m[2] === "dirs" ? ["localProjectId", "dirs"] : ["localProjectId"]);
    if (typeof b.localProjectId !== "string" || !ID.test(b.localProjectId)) throw new SharedProjectsError(400, "invalid_selection");
    if (!d.bindings().some(v => v.centerId === who.centerId && v.teamId === who.teamId && v.projectId === m[1]
      && (v.localProjectId ?? v.projectId) === b.localProjectId)) throw new SharedProjectsError(409, "binding_changed");
    if (m[2] === "dirs") {
      if (!Array.isArray(b.dirs) || b.dirs.length > 32 || b.dirs.some(v => typeof v !== "string" || v.length > 4096 || !v.startsWith("/") || /[\p{Cc}]/u.test(v))) {
        throw new SharedProjectsError(400, "invalid_dirs");
      }
      await d.setDirs(who, m[1]!, b.localProjectId, b.dirs as string[]);
    } else await d.leave(who, m[1]!, b.localProjectId);
    return apiJson(200, { ok: true, localProjectId: b.localProjectId });
  }
  return apiJson(405, { ok: false, code: "method_not_allowed" });
}

async function route(req: Request, path: string, b: Record<string, unknown>, d: SharedProjectsPorts): Promise<Response> {
  const other = await memberAndLocalRoute(req, path, b, d);
  if (other) return other;
  const who = await d.person();
  requireProjectPerson(who);
  const completion = /^\/api\/v1\/shared-projects\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/completion$/.exec(path);
  // Read-only N5 receipt: no center, enrollment, gate or continue call; unknown/stale rather than a guessed availability.
  if (completion && req.method === "GET") return apiJson(200, readSharedProjectCompletion(who, completion[1]!, d));
  const continuing = /^\/api\/v1\/shared-projects\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/continue$/.exec(path);
  if (continuing && req.method === "POST") {
    keys(b, ["askId"]);
    if (typeof b.askId !== "string") throw new SharedProjectsError(400, "invalid_body");
    return apiJson(200, await continueSharedProject(continuing[1]!, b.askId, d));
  }
  if (path === ROOT && req.method === "GET") {
    const projects = await d.list(who);
    if (projects.some(p => p.centerId !== who.centerId || p.teamId !== who.teamId)) throw new SharedProjectsError(503, "invalid_center_response");
    return apiJson(200, { ok: true, projects: projects.map(p => publicProject(p, d)) });
  }
  if (path === `${ROOT}/proposals` && req.method === "POST") {
    const ask = await proposeSharedProject(createInput(b, who), d);
    return apiJson(202, { ok: true, askId: ask.id });
  }
  if (path === ROOT && req.method === "POST") return apiJson(200, await createSharedProject(createInput(b, who), d));
  if (path === `${ROOT}/owner-bootstrap` && req.method === "POST") {
    keys(b, ["operationId"]);
    if (typeof b.operationId !== "string" || !OP.test(b.operationId)) throw new SharedProjectsError(400, "invalid_body");
    const ask = await bootstrapSharedProject(b.operationId, d);
    return apiJson(202, { ok: true, askId: ask.id });
  }
  const match = /^\/api\/v1\/shared-projects\/([a-z0-9][a-z0-9_-]{0,31})(\/invite)?$/.exec(path);
  if (!match) return apiJson(404, { ok: false, code: "not_found" });
  if (!match[2] && req.method === "PATCH") {
    keys(b, ["rev", "name", "status"]);
    if (!Number.isSafeInteger(b.rev) || Number(b.rev) < 1 || (b.name === undefined && b.status === undefined)
      || (b.status !== undefined && b.status !== "active" && b.status !== "archived")) throw new SharedProjectsError(400, "invalid_body");
    const p = await d.patch(who, match[1]!, { rev: Number(b.rev), ...(b.name !== undefined ? { name: name(b.name) } : {}),
      ...(b.status ? { status: b.status as "active" | "archived" } : {}) });
    if (p.centerId !== who.centerId || p.teamId !== who.teamId || p.projectId !== match[1]) throw new SharedProjectsError(503, "invalid_center_response");
    return apiJson(200, { ok: true, project: publicProject(p, d) });
  }
  if (match[2] && req.method === "POST") {
    keys(b, ["peers", "note", "recipient"]);
    if (!Array.isArray(b.peers) || !b.peers.length || b.peers.length > 50 || new Set(b.peers).size !== b.peers.length
      || b.peers.some(p => typeof p !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p))
      || (b.note !== undefined && (typeof b.note !== "string" || Array.from(b.note).length > 120 || /[\p{Cc}\p{Cf}]/u.test(b.note)))) {
      throw new SharedProjectsError(400, "invalid_body");
    }
    const recipient = record(b.recipient);
    keys(recipient, ["personId", "code"]);
    let parsed;
    try { parsed = parseV2ProjectsRequest("invite", { centerId: who.centerId, teamId: who.teamId, projectId: match[1], ...recipient }); }
    catch { throw new SharedProjectsError(400, "invalid_recipient"); } // Canonical union rejects empty or combined identities without echoing input.
    const selected = "personId" in parsed ? { personId: parsed.personId } : { code: parsed.code };
    const result = await d.invite(who, match[1]!, b.peers as string[], b.note as string | undefined, selected);
    return apiJson(202, { ok: true, askId: result.askId });
  }
  return apiJson(405, { ok: false, code: "method_not_allowed" });
}

export async function handleSharedProjectsApi(req: Request, url: URL, d: SharedProjectsRouteDeps = live): Promise<Response | null> {
  if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return null;
  const p = await d.auth(req, url);
  if (p instanceof Response) return p.status === 429 ? p : apiJson(403, { ok: false, code: "owner_required" });
  if (!sharedProjectOwnerPrincipal(p)) return apiJson(403, { ok: false, code: "owner_required" });
  let ports: SharedProjectsPorts | undefined;
  try {
    ports = typeof d.ports === "function" ? await d.ports(p) : d.ports ?? sharedProjectsPorts()
      ?? (d === live ? sharedProjectsClientPorts(p, req.headers.get(SHARED_LEDGER_PROJECT_HEADER)) : undefined);
    if (!ports) return apiJson(503, { ok: false, code: "shared_projects_adapter_unavailable" });
    if (url.search) throw new SharedProjectsError(400, "invalid_query");
    if (url.pathname === `${ROOT}/snapshot` && req.method === "GET") {
      const snapshot: SharedProjectsSnapshot = await sharedProjectsSnapshot(ports, await (d.localSnapshot ?? readSharedProjectsLocalSnapshot)());
      return apiJson(200, snapshot);
    }
    const b = req.method === "GET" ? {} : record(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, 8192))));
    return await route(req, url.pathname, b, ports);
  } catch (error) {
    // No arbitrary center/transport exception or body is reflected to the caller.
    const status = error instanceof SharedProjectsError ? error.status : error instanceof RequestBodyError ? error.status : error instanceof SyntaxError ? 400 : 503;
    let current: unknown;
    if (ports && status === 409 && error instanceof SharedProjectsError && error.current) {
      try { current = publicProject(error.current, ports); }
      catch { /* A malformed current value cannot be shown; preserve the conflict status without echoing the response. */ }
    }
    const unavailable = error instanceof SharedProjectsError && Object.values(SHARED_PROJECTS_CAPABILITIES).some(c => c.reason === error.code);
    const code = unavailable ? error.code : status === 403 ? "project_forbidden" : status === 409 ? "project_conflict" : "project_request_failed";
    return apiJson(status, { ok: false, ...(current ? { current } : {}), code });
  }
}
