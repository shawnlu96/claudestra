import type { Database } from "bun:sqlite";
import { canManage } from "../../lib/devices.js";
import { activeProjectPm, pmCandidates } from "../../lib/pm-role.js";
import { pmStatus } from "../../lib/pm-role-status.js";
import { readPmState, type PmState } from "../../lib/pm-role-state.js";
import type { Principal } from "../../lib/principals.js";
import { AGENT_NAME_BLOCKLIST_RE } from "../../lib/registry.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { ledgerDb } from "../ledger-feed.js";
import { extensionSocketOf } from "../pi-abort.js";
import { BUN_PATH, MANAGER_PATH, ENV_WITH_BUN } from "../config.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { ledgerProjectExists } from "./ledger.js";

interface PmApiDeps {
  exists(project: string): Promise<boolean>;
  db(): Database | null;
  read(): Promise<PmState>;
  online(state: PmState): ReadonlySet<string>;
  run(args: string[]): Promise<Record<string, unknown>>;
}
const real: PmApiDeps = {
  exists: ledgerProjectExists, db: ledgerDb, read: readPmState,
  online: (state) => new Set(state.agents.filter((a) => a.channelId && extensionSocketOf(a.channelId)).map((a) => a.name)),
  run: (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH,
    env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: undefined }, timeoutMs: 60_000 }),
};

export async function handleProjectPmApi(req: Request, path: string, principal: Principal, deps: PmApiDeps = real): Promise<Response | null> {
  const m = /^\/projects\/([^/]+)\/pm$/.exec(path);
  if (!m) return null;
  // Status includes the project's ledger and peer permissions, so reads use the same management gate.
  if (!canManage(principal)) return forbidden("project PM requires manage authorization");
  if (!["GET", "POST"].includes(req.method)) return apiJson(405, { error: "method not allowed" });
  let project: string;
  try { project = decodeURIComponent(m[1]!); }
  catch { return apiJson(400, { error: "invalid project encoding" }); }
  if (!project || project.length > 200 || /[\p{Cc}]/u.test(project) || project.startsWith("-")) return apiJson(400, { error: "invalid project" });
  try {
    if (!(await deps.exists(project))) return apiJson(404, { error: "project not found" });
    if (req.method === "GET") {
      const db = deps.db();
      if (!db) return apiJson(503, { error: "ledger unavailable" });
      const state = await deps.read();
      return apiJson(200, { active: activeProjectPm(db, project), candidates: pmCandidates(db, project, state.agents, deps.online(state)),
        status: pmStatus(db, project, state) });
    }
    const body = await readJsonBody(req) as { agent?: unknown; dryRun?: unknown } | typeof INVALID_JSON;
    if (body === INVALID_JSON) return invalidJsonBody();
    if (!body || typeof body.agent !== "string" || !body.agent.trim() || AGENT_NAME_BLOCKLIST_RE.test(body.agent)
      || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) return apiJson(400, { error: "agent and optional boolean dryRun required" });
    const args = ["ledger", "pm-switch", body.agent, "--project", project, ...(body.dryRun ? ["--dry-run"] : [])];
    const r = await deps.run(args);
    return apiJson(r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : 400, r);
  } catch (e) {
    console.error("[project-pm] request failed", e);
    return apiJson(503, { error: "project PM state unavailable" });
  }
}
