/**
 * 「待你处理」的 HTTP 口（docs 13 §4.4）。门：看 = canReadLedger，大总管的 ask 另要 scope 含 master；答 = owner 本人（isOwnerPrincipal）
 * （ask-entry.ts 的 canSeeAsk / canAnswerAsk）：
 *   GET  /api/v1/asks                              跨项目（侧栏计数、抽屉；大总管的 ask 只在这里，project = "master"）；canAnswer = 这个凭据能不能答
 *   GET  /api/v1/ledger/:project/asks              单个项目
 *   POST /api/v1/ledger/:project/asks/:id/answer   卡片作答 {choices: wire[], text?}；已结案 409 ask_closed；运行时弹框 400
 *   POST /api/v1/presence                          网页可见性 {visible}：可见时每分钟一次、切后台时一次（推送规则判 owner 在不在）
 * 运行时弹框类（AUQ / 权限）的按键仍走 POST /agents/:name/answer，由那个端点记是谁选了什么。实时靠 SSE ask 事件，收到就重拉。
 */
import { canReadLedger } from "../../lib/devices.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { answerFromCard, canSeeAsk } from "../ask-entry.js";
import { listForWeb, ownerPresence } from "../asks.js";

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
  if (!m && path !== "/presence") return null;
  if (!canReadLedger(principal)) return forbidden("asks require a full-scope owner credential");
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
  if (id !== undefined) {
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const b = await jsonBody(req);
    if (!b) return apiJson(400, { ok: false, error: "body {choices: string[], text?: string}" });
    return answerFromCard(project!, id, b, principal);
  }
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  try {
    const asks = listForWeb((a) => canSeeAsk(principal, a), project);
    return apiJson(200, { ok: true, asks, canAnswer: isOwnerPrincipal(principal), presence: ownerPresence.state(), now: Date.now() });
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
}
