/**
 * /api/v1 的响应样板与早退判定（从 api-routes.ts 抽出，D5-5 / D5-11 / D1-5）。
 *
 * 响应逐字节沿用原写法（状态码、文案、JSON 键序），tests/api-route-parity.test.ts 钉住。
 * 叶子模块：只依赖 src/lib，import 时零副作用；api-routes（hub）与 bridge.ts 从这里取。
 */
import { agentInScope, type Principal } from "../lib/principals.js";
import { canManage, canSeeQuota } from "../lib/devices.js";
import { wallWaitRefusal, type WallWait } from "../lib/wall-screen.js";
import { readLiveCcSessionEntries, type CcSessionEntry } from "../lib/cc-sessions.js";
import { isMasterName, readRegistryAgents } from "../lib/registry.js";

export function apiJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 全权 token（scope 含 "*"；注意 "*" 不含 master，见 agentInScope）。 */
/** 管理类端点的门（peers / cron / projects / update / 会话管理…）：owner 设备凭据看 grant.manage；老的全 scope 非 peer token 过渡期放行（lib/devices.ts canManage） */
export function isFullScope(principal: Principal): boolean {
  return canManage(principal);
}

/** 投递被押住（额度闸 / 停在额度菜单，没发键）时 202 里多带的：queued 给所有人，原因 heldBy 只给能看额度的 owner（canSeeQuota） */
export function heldFields(heldBy: unknown, principal: Principal): { queued?: true; heldBy?: string } {
  return typeof heldBy === "string" && heldBy ? { queued: true, heldBy: canSeeQuota(principal) ? heldBy : undefined } : {};
}

/** POST /interrupt 没发键时的回执：停在撞墙画面上 → 能看额度的（canSeeQuota）给 wallWait + 如实的原因，别人只拿中性的 refused；否则空闲 */
export function stopExtra(r: { keys: readonly string[]; wall?: WallWait }, principal: Principal): Record<string, unknown> {
  if (r.keys.length) return {};
  if (!r.wall) return { idle: true };
  const see = canSeeQuota(principal);
  return { [see ? "wallWait" : "refused"]: true, note: wallWaitRefusal(r.wall, see) };
}

/** 403 + 调用方给的文案（各端点「xxx requires a full-scope token」文案各不相同）。 */
export function forbidden(error: string): Response {
  return apiJson(403, { ok: false, error });
}

/** agent 不在 token scope 的统一 403。 */
export function notInScope(agent: string): Response {
  return apiJson(403, { ok: false, error: `agent "${agent}" not in token scope` });
}

/**
 * scope 双向兼容前缀：裸名或 agent- 前缀的任一个在 scope 内即放行（短路顺序同原写法）。
 * master 的各种写法（去掉任意层 agent- 前缀后是 master，或网页的会话名 __master__）只按 master 判：以前 "agent-master"
 * 再加前缀成 "agent-agent-master" 就不算 master 了，"*" 放行，路由按名字解析又落到 master（tests/api-master-scope.test.ts）。
 */
export function inScopeEitherName(principal: Principal, name: string): boolean {
  if (isMasterName(name)) return agentInScope(principal, "master");
  return agentInScope(principal, name) || agentInScope(principal, `agent-${name}`);
}

/** readJsonBody 解析失败的哨兵（合法 JSON 不可能产出 symbol）。 */
export const INVALID_JSON: unique symbol = Symbol("invalid-json");

/** 读 JSON body；解析失败返回 INVALID_JSON，调用方据此回 invalidJsonBody()。 */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    // 坏 JSON 是请求方的错：调用方凭哨兵回 400「invalid JSON body」，服务端没什么可记的
    return INVALID_JSON;
  }
}

export function invalidJsonBody(): Response {
  return apiJson(400, { ok: false, error: "invalid JSON body" });
}

/**
 * handler 异常 → JSON 响应（D5-11）。URIError 来自路由正则匹配后 decodeURIComponent 遇到
 * 非法百分号编码，是请求的错 → 400；其余 → 500。bridge.ts 的 Bun.serve error() 兜底也用它，
 * 否则 Bun 在没设 NODE_ENV 时（launchd 就不设）回 67KB 的 HTML 调试页。
 */
export function apiErrorResponse(e: unknown): Response {
  if (e instanceof URIError) return apiJson(400, { ok: false, error: "bad path encoding" });
  console.error("❌ HTTP handler 异常:", e);
  return apiJson(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
}

/**
 * D1-5：sessionId 是否正被本机一个**活的 interactive** Claude Code 进程占着（用户自己在
 * 终端里开的那种）。判据复用 readLiveCcSessionEntries：pid 活着且启动时刻与登记一致
 * （pid 复用的过期登记被剔除）。已在 registry 里的会话是 Claudestra 自己的窗口，不算。
 */
export async function liveInteractiveHolder(sessionId: string): Promise<CcSessionEntry | null> {
  const [live, reg] = await Promise.all([
    readLiveCcSessionEntries(),
    readRegistryAgents().catch(() => []), // registry 读不到按「没有已管会话」算：最坏多回一次 409，用户选 fork/takeover 即可
  ]);
  if (reg.some((a) => a.sessionId === sessionId)) return null;
  return live.find((e) => e.sessionId === sessionId && e.kind === "interactive") ?? null;
}
