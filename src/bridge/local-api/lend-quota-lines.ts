/**
 * 出借额度线的网页端口（QLINE1）：GET /lend/quota-lines 读线、状态与实际容量；POST /lend/quota-lines 改一族的两条线或模式。
 * 门 = owner 本人 + 全权 manage 凭据（同 lend-grant.ts），身份只看 Principal、请求体里没有身份字段；门在读盘 / 读请求体之前判。
 * 回包只有脱敏元数据（家族、已用百分比、重置时刻、读数时刻、阈值、状态、收窄档、容量合计），没有账户 / 凭据 / 会话 / 本机路径。
 * 给 QWARN1 的冻结形状见下面 LendQuotaLinesView；state 是这里判好的，前端不要拿百分比自己猜停没停。tests/lend-quota-line-api.test.ts。
 */
import { canReadLedger } from "../../lib/devices.js";
import { readLend, LEND_PATH } from "../../lib/lend-config.js";
import { parsePatch, readQuotaLines, saveQuotaLines, QUOTA_LINES_PATH, type QuotaLineMode, type QuotaLinesRead } from "../../lib/lend-quota-line-config.js";
import { refreshQuotaFacts, type QuotaFacts } from "../../lib/lend-quota-line-facts.js";
import { capSlots, familyLine, WARN_ZONE_APPROVED, type FamilyLineView } from "../../lib/lend-quota-line.js";
import { effectiveLend, readLendContext } from "../../lib/lend-policy.js";
import { LEND_FAMILIES } from "../../lib/lend-wire-types.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";

const PATH = "/lend/quota-lines";
const BODY_MAX = 4_096;

/** 一族在全部有效授权上的容量合计：granted = 授权里的名额，slots = 按本规则收窄后的（不含 QP1 / Claude 登录等别的收窄） */
interface FamilySlotsView extends FamilyLineView { granted: number; slots: number }
export interface LendQuotaLinesView {
  ok: true;
  /** missing = 用默认；invalid = 文件坏了、正按默认执行（error 是原因，重存一次即修好） */
  config: { status: QuotaLinesRead["status"]; error: string | null; mode: QuotaLineMode };
  warnZoneApproved: boolean;
  /** 读数时刻（毫秒）；各族另有自己的 readAt，unknown 的族为 null */
  at: number;
  families: FamilySlotsView[];
}

export interface LendQuotaLinesDeps {
  linesPath: string;
  lendPath: string;
  now: () => number;
  facts: (now: number) => Promise<QuotaFacts>;
  context: typeof readLendContext;
}
const DEFAULTS: LendQuotaLinesDeps = { linesPath: QUOTA_LINES_PATH, lendPath: LEND_PATH, now: Date.now, facts: (now) => refreshQuotaFacts(now), context: readLendContext };

async function view(d: LendQuotaLinesDeps, lines: QuotaLinesRead): Promise<LendQuotaLinesView> {
  const now = d.now();
  const facts = await d.facts(now);
  const [read, ctx] = [await readLend(d.lendPath), await d.context()];
  const grants = effectiveLend(read, ctx.contacts, ctx.projects, now).lend;
  const families = LEND_FAMILIES.map((f) => {
    const v = familyLine(f, { lines, facts }, now);
    const granted = grants.reduce((n, e) => n + (e.families[f] ?? 0), 0);
    const slots = grants.reduce((n, e) => n + capSlots(v.limit, e.families[f] ?? 0), 0);
    return { ...v, granted, slots };
  });
  return { ok: true, config: { status: lines.status, error: lines.status === "invalid" ? lines.error : null, mode: lines.file.mode },
    warnZoneApproved: WARN_ZONE_APPROVED, at: now, families };
}

async function readBody(req: Request): Promise<unknown | Response> {
  if (Number(req.headers.get("content-length") || 0) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return apiJson(400, { ok: false, error: "请求体要是 JSON 对象" }); // 坏 JSON 就是这个原因，不需要原始错误
  }
}

async function save(d: LendQuotaLinesDeps, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const patch = parsePatch(body);
  if (typeof patch === "string") return apiJson(400, { ok: false, error: patch });
  const r = await saveQuotaLines(patch, d.linesPath, d.now());
  if (!r.ok) return apiJson(r.code === "busy" ? 503 : 500, { ok: false, error: r.error });
  const out = await view(d, { status: "ok", file: r.file });
  return apiJson(200, { ...out, ...(r.replacedInvalid ? { warning: `原配置文件损坏（${r.replacedInvalid}），已另存后按这次保存的内容重写` } : {}) });
}

export function makeLendQuotaLinesApi(deps: Partial<LendQuotaLinesDeps> = {}) {
  const d: LendQuotaLinesDeps = { ...DEFAULTS, ...deps };
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== PATH) return null;
    if (!isOwnerPrincipal(principal) || !canReadLedger(principal)) return forbidden("only the owner (full-access device) can manage lending quota lines");
    if (req.method === "GET") return apiJson(200, await view(d, await readQuotaLines(d.linesPath)));
    if (req.method === "POST") return save(d, req);
    return apiJson(405, { ok: false, error: "method not allowed" });
  };
}

export const handleLendQuotaLinesApi = makeLendQuotaLinesApi();
