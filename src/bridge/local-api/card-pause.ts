/**
 * UXPAUSE1 · card-level pause over the local API (the web button is UXCARD2's). GET reads the switch and the card's pause state;
 * POST …/pause (with a reason) and POST …/resume run `ledger card-pause` / `card-resume` in a manager child as owner, so the
 * ledger event's actor is owner and the CLI's own checks (stage, switch, manual merge request, duplicate) decide.
 */
import type { Database } from "bun:sqlite";
import { cardPauseMode, cardPauseState } from "../../lib/card-pause.js";
import { pauseRefusal } from "../../lib/card-pause-write.js";
import { canManage } from "../../lib/devices.js";
import { getTask } from "../../lib/ledger-store.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { ledgerDb } from "../ledger-feed.js";
import { BUN_PATH, MANAGER_PATH, ENV_WITH_BUN } from "../config.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { ledgerProjectExists } from "./ledger.js";

export interface CardPauseApiDeps {
  exists(project: string): Promise<boolean>;
  db(): Database | null;
  run(args: string[]): Promise<Record<string, unknown>>;
}
/** The manager child's environment: no channel id, so the CLI resolves the caller as owner (as local-api/project-pm.ts does). */
export const ownerEnv = (): Record<string, string | undefined> => ({ ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: undefined });
const real: CardPauseApiDeps = {
  exists: ledgerProjectExists, db: ledgerDb,
  run: (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ownerEnv(), timeoutMs: 60_000 }),
};

const PATH = /^\/ledger\/([^/]+)\/tasks\/([^/]+)\/(pause|resume)$/;
const badId = (s: string): boolean => !s || s.length > 200 || /[\p{Cc}]/u.test(s) || s.startsWith("-");

function decode(raw: string): string | null {
  try { const s = decodeURIComponent(raw); return badId(s) ? null : s; }
  catch { return null; }
}

/** The GET view: switch position, whether paused, by whom / when / why, and whether a pause is possible now (or why not). */
function view(db: Database, project: string, taskId: string): Record<string, unknown> | null {
  const task = getTask(db, taskId);
  if (!task || task.project !== project) return null;
  const state = cardPauseState(db, taskId), paused = state?.paused === true;
  const refusal = paused ? "已暂停" : pauseRefusal(db, task);
  return { mode: cardPauseMode(project), paused, actor: paused ? state!.actor : null, at: paused ? state!.at : null,
    reason: paused ? state!.reason : null, stage: task.stage, canPause: refusal === null, refusal };
}

const status = (r: Record<string, unknown>): number =>
  r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : r.code === "conflict" ? 409 : 400;

export async function handleCardPauseApi(req: Request, path: string, principal: Principal, deps: CardPauseApiDeps = real): Promise<Response | null> {
  const m = PATH.exec(path);
  if (!m) return null;
  if (!canManage(principal)) return forbidden("card pause requires manage authorization");
  const verb = m[3]!;
  if (req.method !== "POST" && !(req.method === "GET" && verb === "pause")) return apiJson(405, { error: "method not allowed" });
  const project = decode(m[1]!), taskId = decode(m[2]!);
  if (!project || !taskId) return apiJson(400, { error: "invalid project or task" });
  try {
    if (!(await deps.exists(project))) return apiJson(404, { error: "project not found" });
    const db = deps.db();
    if (!db) return apiJson(503, { error: "ledger unavailable" });
    const current = view(db, project, taskId);
    if (!current) return apiJson(404, { error: "task not found" });
    if (req.method === "GET") return apiJson(200, current);
    let args: string[];
    if (verb === "pause") {
      const body = await readJsonBody(req) as { reason?: unknown } | typeof INVALID_JSON;
      if (body === INVALID_JSON) return invalidJsonBody();
      if (!body || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 600) return apiJson(400, { error: "reason (1–600 chars) required" });
      args = ["ledger", "card-pause", taskId, "--reason", body.reason.trim()];
    } else args = ["ledger", "card-resume", taskId];
    const r = await deps.run(args);
    return apiJson(status(r), r.ok ? { ...r, view: view(db, project, taskId) } : r);
  } catch (e) {
    console.error("[card-pause] request failed", e);
    return apiJson(503, { error: "card pause state unavailable" });
  }
}
