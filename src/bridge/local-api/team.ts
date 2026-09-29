/** Owner-only, read-only cache projection; never returns account identifiers or credentials. */
import { canReadLedger } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { fileQuotaStore } from "../../lib/quota-state.js";
import { teamQuota } from "../../lib/team-quota.js";
import { teamTasks } from "../../lib/team-tasks.js";
import { ledgerDb } from "../ledger-feed.js";
import { ledgerProjectExists } from "./ledger.js";
import { readTeamActivity } from "../team-activity.js";
import { apiJson, forbidden } from "../api-respond.js";

export async function handleTeamApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (!["/team/quota", "/team/tasks", "/team/activity"].includes(path)) return null;
  if (!canReadLedger(principal)) return forbidden("team requires a full-scope owner credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  if (path === "/team/activity") return activity(req);
  if (path === "/team/tasks") return executorCards(req);
  try {
    return apiJson(200, { providers: teamQuota(await fileQuotaStore().load(), Date.now()) });
  } catch (e) {
    console.warn("[team] quota cache unavailable:", e);
    return apiJson(200, { providers: [] });
  }
}

async function activity(req: Request): Promise<Response> {
  const project = new URL(req.url).searchParams.get("project");
  if (!project || !(await ledgerProjectExists(project))) return apiJson(404, { error: "project not found" });
  try { return apiJson(200, await readTeamActivity(project)); }
  catch (e) {
    console.warn("[team] activity unavailable:", e);
    return apiJson(503, { error: "activity unavailable" });
  }
}

async function executorCards(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const project = q.get("project"), peer = q.get("peer") ?? "", agent = q.get("agent");
  if (!project || !agent) return apiJson(400, { error: "project and agent required" });
  if (!(await ledgerProjectExists(project))) return apiJson(404, { error: "project not found" });
  try {
    const db = ledgerDb();
    return apiJson(200, { tasks: db ? teamTasks(db, project, peer, agent) : [] });
  } catch (e) {
    console.warn("[team] ledger unavailable:", e);
    return apiJson(503, { error: "ledger unavailable" });
  }
}
