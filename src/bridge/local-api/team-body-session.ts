/**
 * 团队会话页代理（team-project-TEAMVIS8）：网页 → 本机 → 中心 session-pages 取页口，用本机 person 凭据签名（同 team-body.ts）。
 *   POST /shared-ledger/team-body/features/:featureId/tasks/:taskId/session-pages          {cursor, limit?} → {requestId, expiresAt}
 *   GET  /shared-ledger/team-body/features/:featureId/tasks/:taskId/session-pages/:requestId → {requestId, status, expiresAt, homeOnline, result}
 * 中心把请求交给主场（主场长轮询领取、脱敏后回传，bridge/team-body-fetch.ts）；网页拿 requestId 轮询 GET，本机不替它重发。
 * 只读：POST 只是登记「要这一页」，不带消息、不改任何卡的状态；不接受查询串，正文只认 cursor / limit 两个键。
 * 失败归成固定 code：not_member / gate_refused（403）、not_open（409）、expired（410，含中心已不认得的 requestId）、
 * home_offline（503，中心契约错误体认得出才算）、unsupported（404）、rate_limited（429）；其余一律 503 unavailable，不带中心或凭据的原文。
 * 回来的页必须是问的这张卡的 session-page 记录，否则 403。tests/web-collab-team-session-proxy.test.ts。
 */
import type { Principal } from "../../lib/principals.js";
import { requestSharedLedger, SharedLedgerRemoteError } from "../../lib/shared-ledger-client-transport.js";
import { resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "../../lib/shared-ledger-mode.js";
import {
  parseTeamBodyError, parseTeamBodyPageRead, parseTeamBodyPageRequest, parseTeamBodyPageTicket, TEAM_BODY_PATHS, TEAM_BODY_STATUS,
  type TeamBodyPageRead, type TeamBodyPageTicket,
} from "../../lib/shared-ledger-contract-team-body.js";
import type { TeamBodyProxyDeps } from "./team-body.js";

/** team-body.ts 的能力位缓存和拒绝正文解析：由它传进来，两个文件不互相 import 运行时代码 */
export interface TeamBodyGate {
  supported: (credential: SharedLedgerLocalCredential, deps: TeamBodyProxyDeps) => Promise<boolean>;
  rejection: (status: number, response: Response) => Promise<unknown>;
}

const ID = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";
const ROUTE = new RegExp(`^/shared-ledger/team-body/features/(${ID})/tasks/(${ID})/session-pages(?:/(${ID}))?$`);
/** 一页要多少条：网页不给就用这个；上限照契约（200） */
const DEFAULT_LIMIT = 50;
const BODY_MAX_BYTES = 2048;

export const isTeamBodySessionPath = (path: string): boolean => /\/session-pages(?:\/|$)/.test(path);

const json = (status: number, body: unknown, headers?: Record<string, string>) => Response.json(body, { status, headers });
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k]!);

/** 网页的请求正文 → cursor / limit；多余的键、形状不对一律 null */
async function wanted(req: Request): Promise<{ cursor: string | null; limit: number } | null> {
  let raw: unknown;
  try {
    const body = await req.text();
    if (Buffer.byteLength(body, "utf8") > BODY_MAX_BYTES) return null;
    raw = JSON.parse(body);
  } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== "cursor" && k !== "limit")) return null;
  const cursor = v.cursor ?? null, limit = v.limit ?? DEFAULT_LIMIT;
  if ((cursor !== null && typeof cursor !== "string") || typeof limit !== "number") return null;
  return { cursor, limit };
}

function refused(e: SharedLedgerRemoteError, polling: boolean): Response {
  if (e.status === 429) {
    const seconds = String(Math.max(1, Math.ceil(e.retryAfterMs / 1000)));
    return json(429, { code: "rate_limited", retryAfter: Number(seconds) }, { "Retry-After": seconds });
  }
  const code = (e.response as { code?: unknown } | null)?.code;
  if (e.status === TEAM_BODY_STATUS.expired) return json(410, { code: "expired" });
  // 能力位问过了还 404：轮询时是中心已经不认得这个 requestId（过期清掉了），发请求时是取页口没开
  if (e.status === TEAM_BODY_STATUS.unsupported) return polling ? json(410, { code: "expired" }) : json(404, { code: "unsupported" });
  if (e.status === 403) return json(403, { code: code === "gate_refused" ? "gate_refused" : "not_member" });
  if (e.status === TEAM_BODY_STATUS.not_open) return json(409, { code: "not_open" });
  return json(e.status === 400 ? 400 : 503, { code: "unavailable" });
}

/** gate proxy 选好绑定之后调；不是会话页路径返回 null */
export async function teamBodySessionPage(req: Request, path: string, principal: Principal, deps: TeamBodyProxyDeps,
  gate: TeamBodyGate): Promise<Response | null> {
  if (!isTeamBodySessionPath(path)) return null;
  const m = ROUTE.exec(path);
  const polling = !!m?.[3];
  if (!m || req.method !== (polling ? "GET" : "POST") || new URL(req.url).search) return json(400, { error: "unsupported team body route" });
  if (principal.disabled || principal.peer) return json(403, { error: "shared ledger identity unavailable" });
  const [, featureId, taskId, requestId] = m as unknown as [string, string, string, string | undefined];
  // 中心的 5xx 在传输层一律算不可达；只有契约形状的 home_offline 错误体才说明「中心在、主场不在」
  let homeOffline = false;
  const base = deps.fetch ?? fetch;
  const fetcher = (async (url: URL | string | Request, init?: RequestInit) => {
    const response = await base(url, init);
    if (response.status === TEAM_BODY_STATUS.home_offline) {
      try { homeOffline = parseTeamBodyError(response.status, await response.clone().json()).code === "home_offline"; }
      catch { homeOffline = false; }
    }
    return response;
  }) as typeof fetch;
  const options = { fetch: fetcher, now: deps.now, stateDir: deps.stateDir };
  try {
    const credential = resolveSharedLedgerCredential(principal.id, "person", deps.centerId, deps.teamId, deps.projectId, "read", deps.stateDir);
    if (!credential) return json(403, { error: "shared ledger identity unavailable" });
    if (requestId === undefined) {
      const want = await wanted(req);
      let payload: ReturnType<typeof parseTeamBodyPageRequest>;
      try {
        if (!want) throw new Error("invalid");
        payload = parseTeamBodyPageRequest({ schemaVersion: 1, projectId: deps.projectId, featureId, taskId, ...want });
      } catch { return json(400, { error: "invalid session page request" }); }
      if (!(await gate.supported(credential, deps))) return json(404, { code: "unsupported" });
      const ticket = await requestSharedLedger(credential, deps.key, options, "POST", fill(TEAM_BODY_PATHS.pageRequest, { teamId: deps.teamId }),
        payload, undefined, gate.rejection, undefined, (_, body) => parseTeamBodyPageTicket(body)) as TeamBodyPageTicket;
      return json(200, { requestId: ticket.requestId, expiresAt: ticket.expiresAt });
    }
    if (!(await gate.supported(credential, deps))) return json(404, { code: "unsupported" });
    const read = await requestSharedLedger(credential, deps.key, options, "GET",
      fill(TEAM_BODY_PATHS.pageRead, { teamId: deps.teamId, requestId }), undefined, undefined, gate.rejection, undefined,
      (_, body) => parseTeamBodyPageRead(body)) as TeamBodyPageRead;
    // 别的请求、别的卡的页不经这条路径出境
    const foreign = read.result?.kind === "page" && read.result.records.some((r) => r.featureId !== featureId || r.taskId !== taskId);
    if (read.requestId !== requestId || foreign) return json(403, { error: "project unavailable" });
    return json(200, { requestId, status: read.status, expiresAt: read.expiresAt, homeOnline: read.homeOnline, result: read.result });
  } catch (e) {
    if (e instanceof SharedLedgerRemoteError) return refused(e, polling);
    if (homeOffline) return json(503, { code: "home_offline" });
    // 凭据 / 传输异常的原文可能含密钥：固定离线错误
    return json(503, { code: "unavailable" });
  }
}
