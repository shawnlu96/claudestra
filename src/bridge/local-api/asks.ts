/**
 * 「待你处理」的 HTTP 口（docs 13 §4.4）。谁能看 / 答全在 lib/ask-access.ts：指给自己的 assignee 本人（guest 也行，只看得到自己的）；
 * 其余看 = canReadLedger（大总管的另要 scope 含 master），答 = owner 本人。台账读不了、又不是设备凭据的（peer、老 token）整个 403：
 *   GET  /api/v1/asks                              跨项目（侧栏计数、抽屉；大总管的 ask 只在这里，project = "master"）；每行 canAnswer
 *   POST /api/v1/ledger/:project/asks              owner 开一条人发起的 ask（指派 / 审核），{title, assignee?, kind?, taskId?, options?, …}
 *   GET  /api/v1/asks/:id[/locate]                 一条 / 它的原消息在哪（聊天引用条、「回到对话」跳原消息）
 *   GET  /api/v1/ledger/:project/asks              单个项目
 *   POST /api/v1/ledger/:project/asks/:id/answer   卡片作答 {choices: wire[], text?}；已结案 409 ask_closed；运行时弹框 400
 *   POST /api/v1/presence                          网页可见性 {visible}：可见时每分钟一次、切后台时一次（推送规则判 owner 在不在）
 * 运行时弹框类（AUQ / 权限）的按键仍走 POST /agents/:name/answer，由那个端点记是谁选了什么。实时靠 SSE ask 事件，收到就重拉。
 */
import { canAnswerAsk, canSeeAsk, humanAssignee } from "../../lib/ask-access.js";
import { draftFromReply } from "../../lib/ask-options.js";
import { assigneeFormatError } from "../../lib/ledger-checks.js";
import { canReadLedger } from "../../lib/devices.js";
import { getAsk, type Ask } from "../../lib/ledger-asks.js";
import { agentInScope, isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { answerFromCard } from "../ask-entry.js";
import { locateAsk } from "../ask-locate.js";
import { askReadDb, createAskFull, listForWeb, ownerPresence } from "../asks.js";

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    // 非法百分号编码是请求方的错，调用方回 400
    return null;
  }
};

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    // 不是 JSON：调用方回 400
    return null;
  }
}

export async function handleAsksApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path === "/asks" ? ["", undefined, undefined, undefined] : path.match(/^\/ledger\/([^/]+)\/asks(?:\/([^/]+)\/(answer))?$/);
  const one = path.match(/^\/asks\/([^/]+?)(\/locate)?$/);
  if (!m && !one && path !== "/presence") return null;
  const ledger = canReadLedger(principal);
  if (!ledger && !(principal.credential && !principal.peer)) return forbidden("asks require a full-scope owner credential or a device credential");
  if (one) return oneAsk(req, decode(one[1]), !!one[2], principal);
  if (path === "/presence") {
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    // 只认 owner 本人（和作答同一道门）：集成 token 一直报「在」会把卡活推送全压掉
    if (!isOwnerPrincipal(principal)) return forbidden("presence requires the owner's own credential");
    const b = await jsonBody(req);
    if (!b || typeof b.visible !== "boolean") return apiJson(400, { ok: false, error: "body {visible: boolean}" });
    ownerPresence.setVisible(principal.credential ?? principal.id, b.visible);
    return apiJson(200, { ok: true, presence: ownerPresence.state() });
  }
  const project = m![1] === undefined ? undefined : decode(m![1]);
  const id = m![2] === undefined ? undefined : decode(m![2]);
  if (project === null || id === null) return apiJson(400, { ok: false, error: "bad path encoding" });
  if (id === undefined && project !== undefined && req.method === "POST") return createHumanAsk(req, project, principal);
  if (id !== undefined) {
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const b = await jsonBody(req);
    if (!b) return apiJson(400, { ok: false, error: "body {choices: string[], text?: string}" });
    return answerFromCard(project!, id, b, principal);
  }
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  try {
    // 台账读不了的（guest）只查指给自己的，别让别人的 200 条把它挤掉
    const rows = listForWeb((a) => canSeeAsk(principal, a), project, ledger ? undefined : humanAssignee(principal.id));
    const asks = rows.map((a): Ask & { canAnswer: boolean } => ({ ...a, canAnswer: canAnswerAsk(principal, a) }));
    return apiJson(200, { ok: true, asks, presence: ownerPresence.state(), now: Date.now() });
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
}

const TITLE_MAX = 40;
/** assignee 的三种写法（T8h ledger-checks 同一份校验）：local:<owner:self|guest:hex> 是人、带 / 的是队友的 agent、其余是本机 agent 名 */
const assigneeError = (who: string): string | null =>
  assigneeFormatError(who.startsWith("local:") ? "human" : who.includes("/") ? "peer_agent" : "agent", who);

/**
 * owner 开一条人发起的 ask（T28 chat 的审核、给 guest 指派）：作答只记账，不回投任何 agent（bridge/asks.ts createAsk）。
 * 要全权的 owner 凭据（读得了整本台账）：部分 scope / 没有管理权的设备不能开。dedupKey 撞上已有的：同项目、看得见就把那条给回去，否则只回 409——
 * 否则拿 T28a 形状的键去撞就能读出别的项目里的标题和背景。
 */
async function createHumanAsk(req: Request, project: string, p: Principal): Promise<Response> {
  if (!isOwnerPrincipal(p) || !canReadLedger(p)) return forbidden("only the owner (full-access device) can open an ask");
  const b = await jsonBody(req);
  const title = typeof b?.title === "string" ? Array.from(b.title.trim()).slice(0, TITLE_MAX).join("") : "";
  if (!b || !title) return apiJson(400, { ok: false, error: "body {title, assignee?, kind?: decide|assigned, taskId?, context?, options?, allowText?, expiresIn?, dedupKey?}" });
  const assignee = typeof b.assignee === "string" ? b.assignee : undefined;
  const bad = assignee === undefined ? null : assigneeError(assignee);
  if (bad) return apiJson(400, { ok: false, error: `assignee must be ${bad}` });
  const kind = b.kind === "assigned" ? "assigned" : b.kind === undefined || b.kind === "decide" ? "decide" : null;
  if (!kind || (kind === "assigned" && !assignee)) return apiJson(400, { ok: false, error: "kind must be decide | assigned (assigned needs an assignee)" });
  const exp = typeof b.expiresIn === "number" && b.expiresIn >= 60 && b.expiresIn <= 30 * 24 * 3600 ? Date.now() + b.expiresIn * 1000 : undefined;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  try {
    const { ask: a, existed } = createAskFull({
      project, source: "human", createdBy: p.id, kind, title, assignee, taskId: str(b.taskId, 40), context: str(b.context, 300) ?? "",
      options: draftFromReply(title, b.options)?.options ?? [], allowText: b.allowText !== false, expiresAt: exp, dedupKey: str(b.dedupKey, 200),
      blocking: kind === "assigned" ? true : null,
    });
    if (existed && (a.project !== project || !canSeeAsk(p, a))) return apiJson(409, { ok: false, code: "dedup_conflict", error: "dedupKey already used" });
    return apiJson(existed ? 200 : 201, { ok: true, existed, ask: a });
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
}

/**
 * GET /asks/:id：一条（聊天里「答复：<标题>」引用条按 askId 取标题）；GET /asks/:id/locate：原消息在发起 agent 会话里的位置
 * {agent, sessionId, seq}（网页据此跳过去）。看不见的一律 404；定位另要发起 agent 在凭据 scope 里（和读聊天历史同一道门）
 */
async function oneAsk(req: Request, id: string | null, locate: boolean, p: Principal): Promise<Response> {
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  const db = askReadDb();
  const a = id && db ? getAsk(db, id) : null;
  if (!a || !canSeeAsk(p, a)) return apiJson(404, { ok: false, error: `ask "${id}" not found` });
  if (!locate) return apiJson(200, { ok: true, ask: { ...a, canAnswer: canAnswerAsk(p, a) } });
  if (!a.fromAgent || !agentInScope(p, a.fromAgent)) return apiJson(404, { ok: false, error: "no source message for this ask" });
  const loc = await locateAsk(a.id);
  return loc ? apiJson(200, { ok: true, ...loc }) : apiJson(404, { ok: false, error: "source message not found in the agent's sessions" });
}
