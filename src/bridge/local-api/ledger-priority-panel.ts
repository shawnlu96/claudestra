/** Priority panel reads reuse ledger access; mutations are server-bound asks answered through the existing owner route. */
import { canReadLedger } from "../../lib/devices.js";
import { priorityPanel, panelHistory, panelResult } from "../../lib/ledger-priority-panel.js";
import { panelAsk, type PanelRequest } from "../../lib/ledger-priority-panel-write.js";
import { readSchedulerConfig } from "../../lib/scheduler-config.js";
import { readLendSync } from "../../lib/lend-config.js";
import { workBoardSlots } from "../../lib/ledger-work-board-slots.js";
import { autostartSpecPath } from "../../lib/scheduler-autostart-deps.js";
import { LedgerError } from "../../lib/ledger-store.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { askDb, createAskFull } from "../asks.js";
import { ledgerDb } from "../ledger-feed.js";
import { ledgerProjectExists } from "./ledger.js";
import { workBoardSpecReady } from "./work-board.js";

export async function handlePriorityPanelApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/ledger\/([^/]+)\/priority(?:\/(requests|history|result))?$/);
  if (!m) return null;
  if (!canReadLedger(principal)) return forbidden("ledger requires a full-scope owner credential");
  const writing = m[2] === "requests";
  if (writing && !isOwnerPrincipal(principal)) return forbidden("只允许 owner 本人发起优先级操作");
  if (req.method !== (writing ? "POST" : "GET")) return apiJson(405, { ok: false, error: "method not allowed" });
  let project: string;
  try { project = decodeURIComponent(m[1]); }
  catch { return apiJson(400, { ok: false, error: "bad project encoding" }); } // Invalid caller encoding is reported as a client error.
  if (!project || project.length > 200 || /[\p{Cc}]/u.test(project)) return apiJson(400, { ok: false, error: "invalid project" });
  try {
    if (!await ledgerProjectExists(project)) return apiJson(404, { ok: false, error: "project not found" });
    const db = ledgerDb(), now = Date.now();
    if (!db) return apiJson(503, { ok: false, error: "台账尚不可用，无法确认 now 工作" });
    if (writing) {
      const body = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      // A write connection is opened only for an authenticated owner request, never while observing the panel.
      const result = askDb().transaction(() => createAskFull(panelAsk(askDb(), project, body as PanelRequest, now))).immediate();
      return apiJson(201, { ok: true, askId: result.ask.id, label: result.ask.title, choice: "[button:priority_apply]" });
    }
    if (m[2] === "result") {
      const id = new URL(req.url).searchParams.get("askId") ?? "";
      return db.transaction(() => apiJson(200, { ok: true, ...panelResult(db, project, id) })).deferred();
    }
    if (m[2] === "history") return apiJson(200, { ok: true, history: panelHistory(db, project), now });
    const policy = readSchedulerConfig().projects[project];
    const borrow = readLendSync().file.borrow.filter(b => b.projects.includes(project) && b.priority !== "off");
    const opts = { registry: [], maxWorkers: policy?.maxActiveWorkers ?? 0, now,
      ...(policy?.remote ? { pool: { remote: policy.remote, borrow } } : {}) };
    const panel = db.transaction(() => priorityPanel(db, project, now, { ...opts,
      availableSlots: workBoardSlots(db, project, opts.maxWorkers, borrow, policy?.remote, now),
      specReady: taskId => workBoardSpecReady(autostartSpecPath(taskId)),
    })).deferred();
    return apiJson(200, { ok: true, ...panel, canWrite: isOwnerPrincipal(principal) });
  } catch (error) {
    if (error instanceof LedgerError) return apiJson(error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 400,
      { ok: false, code: error.code, error: error.message });
    console.warn("[priority-panel] request failed", error);
    return apiJson(503, { ok: false, error: "优先级数据读取失败，请重试" });
  }
}
