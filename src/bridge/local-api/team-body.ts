/**
 * 团队正文只读代理（team-project-TEAMVIS7）：网页 → 本机 → 中心 team-body 读口，用本机 person 凭据签名（同 shared-ledger.ts）。
 *   GET /shared-ledger/team-body/features/:featureId/tasks/:taskId → TeamBodyRead（契约原样，严格解析后才回）
 * 先问能力位（按中心 + 团队缓存 10 分钟）：没有就回 404 {code:"unsupported"}，不发读请求。中心的 403 / 409 / 404 归成固定 code
 * （not_member / gate_refused / not_open / unsupported），429 透传 Retry-After；其他失败一律固定 503，不带中心或凭据的原文。
 * 只读：不接受非 GET、不接受查询串。tests/web-collab-team-body-proxy.test.ts。
 * 记录上的 meta（中心以后给 event 补的白名单元数据 kind / ts / stageTo）不在现行契约里：先摘下来，其余照契约严格解析，
 * 再把校验过的白名单字段挂回原记录；别的键、形状不对的值一律丢掉，不让它连累整份正文，也不往网页带。
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

/** 白名单元数据：kind 是短标识，ts 是 Unix ms，stageTo 只跟 stage 事件走 */
interface TeamBodyMeta { kind?: string; ts?: number; stageTo?: string }
const META_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
function metaOf(value: unknown): TeamBodyMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, out: TeamBodyMeta = {};
  if (typeof v.kind === "string" && META_WORD.test(v.kind)) out.kind = v.kind;
  if (typeof v.ts === "number" && Number.isSafeInteger(v.ts) && v.ts >= 0) out.ts = v.ts;
  if (out.kind === "stage" && typeof v.stageTo === "string" && META_WORD.test(v.stageTo)) out.stageTo = v.stageTo;
  return Object.keys(out).length ? out : null;
}
/** 摘下每条记录的 meta：返回给契约解析的正文（不带 meta）和按记录下标的元数据 */
function splitMeta(raw: unknown): { body: unknown; metas: (TeamBodyMeta | null)[] } {
  const records = (raw as { records?: unknown } | null)?.records;
  if (!raw || typeof raw !== "object" || !Array.isArray(records)) return { body: raw, metas: [] };
  const metas: (TeamBodyMeta | null)[] = [];
  const stripped = records.map((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r) || !Object.hasOwn(r, "meta")) { metas.push(null); return r; }
    const { meta, ...rest } = r as Record<string, unknown>;
    metas.push(rest.kind === "event" ? metaOf(meta) : null);
    return rest;
  });
  return { body: { ...(raw as object), records: stripped }, metas };
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
    const { body, metas } = splitMeta(await requestSharedLedger(credential, deps.key, { fetch: deps.fetch, now: deps.now, stateDir: deps.stateDir }, "GET",
      fill(TEAM_BODY_PATHS.read, { teamId: deps.teamId, featureId, taskId }), undefined, undefined, rejection));
    const read = parseTeamBodyRead(body);
    // 中心回的必须就是问的这张卡、这个项目：别的项目的正文不经这个绑定出境
    if (read.projectId !== deps.projectId || read.teamId !== deps.teamId || read.featureId !== featureId || read.taskId !== taskId) {
      return json(403, { error: "project unavailable" });
    }
    return json(200, { ...read, records: read.records.map((r, i) => (metas[i] ? { ...r, meta: metas[i] } : r)) });
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
