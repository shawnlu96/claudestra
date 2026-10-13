/**
 * 团队正文只读代理（team-project-TEAMVIS7）：网页 → 本机 → 中心 team-body 读口，用本机 person 凭据签名（同 shared-ledger.ts）。
 *   GET /shared-ledger/team-body/features/:featureId/tasks/:taskId → TeamBodyRead（契约原样，严格解析后才回）
 * 先问能力位（按中心 + 团队缓存 10 分钟）：没有就回 404 {code:"unsupported"}，不发读请求。中心的 403 / 409 / 404 归成固定 code
 * （not_member / gate_refused / not_open / unsupported），429 透传 Retry-After；其他失败一律固定 503，不带中心或凭据的原文。
 * 只读：不接受非 GET、不接受查询串。tests/web-collab-team-body-proxy.test.ts。
 */
import type { Principal } from "../../lib/principals.js";
import type { InstanceKey } from "../../lib/instance-key.js";
import { requestSharedLedger, SharedLedgerRemoteError } from "../../lib/shared-ledger-client-transport.js";
import { resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "../../lib/shared-ledger-mode.js";
import { sharedLedgerGateProxy } from "../../lib/shared-ledger-gate-proxy.js";
import {
  parseTeamBodyCapability, parseTeamBodyError, parseTeamBodyRead, TEAM_BODY_PATHS, TEAM_BODY_STATUS,
} from "../../lib/shared-ledger-contract-team-body.js";

export interface TeamBodyProxyDeps {
  stateDir: string; centerId: string; teamId: string; projectId: string; key: InstanceKey;
  fetch?: typeof fetch; now?: () => number;
}

const PREFIX = "/shared-ledger/team-body/";
const ROUTE = /^\/shared-ledger\/team-body\/features\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
const CAPABILITY_TTL_MS = 10 * 60_000;
const capabilities = new Map<string, { supported: boolean; at: number }>();
/** 测试用：清掉能力位缓存 */
export function resetTeamBodyCapabilityCache(): void { capabilities.clear(); }

const json = (status: number, body: unknown, headers?: Record<string, string>) => Response.json(body, { status, headers });
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k]!);

/** 中心拒绝的正文：认得出契约错误码就留 code，认不出（代理自己的 403 页等）只留状态 */
async function rejection(status: number, response: Response): Promise<unknown> {
  try { return { code: parseTeamBodyError(status, await response.json()).code }; }
  catch { return { code: null }; } // 不是契约形状的拒绝：按状态判，正文不往外带
}

async function supported(credential: SharedLedgerLocalCredential, deps: TeamBodyProxyDeps): Promise<boolean> {
  const now = deps.now ?? Date.now, k = JSON.stringify([deps.centerId, deps.teamId]);
  const hit = capabilities.get(k);
  if (hit && now() - hit.at < CAPABILITY_TTL_MS) return hit.supported;
  let ok: boolean;
  try {
    ok = await requestSharedLedger(credential, deps.key, { fetch: deps.fetch, now, stateDir: deps.stateDir }, "GET",
      fill(TEAM_BODY_PATHS.capability, { teamId: deps.teamId }), undefined, undefined, rejection, undefined,
      (status, body) => parseTeamBodyCapability(status, body).supported) as boolean;
  } catch (e) {
    if (!(e instanceof SharedLedgerRemoteError && e.status === TEAM_BODY_STATUS.unsupported)) throw e;
    ok = false;
  }
  capabilities.set(k, { supported: ok, at: now() });
  return ok;
}

/** 中心的拒绝 → 给网页的固定形状；code 只取契约里的那几个 */
function refused(e: SharedLedgerRemoteError): Response {
  if (e.status === 429) {
    const seconds = String(Math.max(1, Math.ceil(e.retryAfterMs / 1000)));
    return json(429, { code: "rate_limited", retryAfter: Number(seconds) }, { "Retry-After": seconds });
  }
  const code = (e.response as { code?: unknown } | null)?.code;
  if (e.status === TEAM_BODY_STATUS.unsupported) return json(404, { code: "unsupported" });
  if (e.status === 403) return json(403, { code: code === "gate_refused" ? "gate_refused" : "not_member" });
  if (e.status === TEAM_BODY_STATUS.not_open) return json(409, { code: "not_open" });
  return json(e.status === 400 ? 400 : 503, { code: "unavailable" });
}

/** gate proxy 选好绑定之后调；不是本模块的路径返回 null */
export async function teamBodyRead(req: Request, path: string, principal: Principal, deps: TeamBodyProxyDeps): Promise<Response | null> {
  if (!path.startsWith(PREFIX)) return null;
  const m = ROUTE.exec(path);
  if (!m || req.method !== "GET" || new URL(req.url).search) return json(400, { error: "unsupported team body route" });
  if (principal.disabled || principal.peer) return json(403, { error: "shared ledger identity unavailable" });
  const [, featureId, taskId] = m as unknown as [string, string, string];
  try {
    const credential = resolveSharedLedgerCredential(principal.id, "person", deps.centerId, deps.teamId, deps.projectId, "read", deps.stateDir);
    if (!credential) return json(403, { error: "shared ledger identity unavailable" });
    if (!(await supported(credential, deps))) return json(404, { code: "unsupported" });
    const read = parseTeamBodyRead(await requestSharedLedger(credential, deps.key, { fetch: deps.fetch, now: deps.now, stateDir: deps.stateDir }, "GET",
      fill(TEAM_BODY_PATHS.read, { teamId: deps.teamId, featureId, taskId }), undefined, undefined, rejection));
    // 中心回的必须就是问的这张卡、这个项目：别的项目的正文不经这个绑定出境
    if (read.projectId !== deps.projectId || read.teamId !== deps.teamId || read.featureId !== featureId || read.taskId !== taskId) {
      return json(403, { error: "project unavailable" });
    }
    return json(200, read);
  } catch (e) {
    if (e instanceof SharedLedgerRemoteError) return refused(e);
    // 凭据 / 传输异常的原文可能含密钥：固定离线错误
    return json(503, { code: "unavailable" });
  }
}

/** local-api 路由表的一项：只认 /shared-ledger/team-body/，绑定选择与 shared-ledger 同一个 gate proxy */
export function handleTeamBodyApi(req: Request, path: string, principal: Principal): Promise<Response | null> | null {
  return path.startsWith(PREFIX) ? sharedLedgerGateProxy(req, path, principal, teamBodyRead) : null;
}
