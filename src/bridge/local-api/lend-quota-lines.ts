/**
 * 出借额度线的网页端口（QLINE1）：GET /lend/quota-lines 读线、状态与实际容量；POST /lend/quota-lines 改一族的两条线或模式。
 * 门 = owner 本人 + 全权 manage 凭据（同 lend-grant.ts），身份只看 Principal、请求体里没有身份字段；门在读盘 / 读请求体之前判。
 * 回包只有脱敏元数据（家族、已用百分比、重置时刻、观测时刻与来源、阈值、状态、收窄档、容量合计），没有账户 / 凭据 / 会话 / 本机路径；
 * 出错一律固定文案（错误码 + 一句话），底层原始错误（可能带本机路径、配置里的字段名）只进本机日志。
 * 给 QWARN1 的冻结形状见下面 LendQuotaLinesView；state 是这里判好的，前端不要拿百分比自己猜停没停。tests/lend-quota-line-api.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { canReadLedger } from "../../lib/devices.js";
import { claudeLendSlots, cachedClaudeReadiness, noteClaudeReadiness } from "../../lib/lend-claude-worker-capacity.js";
import { sharedClaudeReadiness } from "../../lib/lend-claude-ready.js";
import { readLend, LEND_PATH, type LendEntry } from "../../lib/lend-config.js";
import { pausedUntil } from "../../lib/lend-health.js";
import { LEND_JOURNAL_PATH } from "../../lib/lend-journal.js";
import { parsePatch, readQuotaLines, saveQuotaLines, QUOTA_LINES_PATH, type QuotaLineMode, type QuotaLinesRead } from "../../lib/lend-quota-line-config.js";
import { refreshQuotaFacts, type QuotaFacts } from "../../lib/lend-quota-line-facts.js";
import { capSlots, familyLine, type FamilyLineView } from "../../lib/lend-quota-line.js";
import { effectiveLend, readLendContext } from "../../lib/lend-policy.js";
import { LEND_FAMILIES, type LendFamily } from "../../lib/lend-wire-types.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";

const PATH = "/lend/quota-lines";
const BODY_MAX = 4_096;
const READ_BUSY_MS = 2_000;

/**
 * 一族在全部有效授权上的容量合计：
 * granted = 授权名额；lineCap = 只按本规则在授权名额上收窄后的上限（理论值，不是实际可接）；
 * available = 实际可接容量（与 hello 同口径：Claude 登录 / 额度墙 / 运行时暂停、Codex QP1 暂停都已算进去），未套本规则；
 * slots = available 再按本规则收窄 = 借入方此刻从 hello 看到的 total 合计。available / slots 为 null = 读不到实际状态（显示未知，不当 0 也不当满）。
 */
interface FamilySlotsView extends FamilyLineView { granted: number; lineCap: number; available: number | null; slots: number | null }
/** 对外的固定错误码（脱敏）：原因的细节只在本机日志 */
type ConfigError = "config_unreadable" | "config_invalid";
export interface LendQuotaLinesView {
  ok: true;
  /** missing = 用默认；invalid = 文件坏了、正按默认执行（error 是固定错误码，重存一次即修好） */
  config: { status: QuotaLinesRead["status"]; error: ConfigError | null; mode: QuotaLineMode };
  /** 读数时刻（毫秒）；各族另有自己的 observedAt，unknown 的族为 null */
  at: number;
  families: FamilySlotsView[];
  /** 仅 POST：原配置文件损坏、已另存备份后重写（固定码） */
  warning?: "replaced_invalid";
}

/** 每条有效授权此刻实际可接的容量（未套额度线）；null = 读不到 */
export type ActualSlots = (entries: LendEntry[], now: number) => Record<LendFamily, number>[] | null;

export interface LendQuotaLinesDeps {
  linesPath: string;
  lendPath: string;
  now: () => number;
  facts: (now: number) => Promise<QuotaFacts>;
  context: typeof readLendContext;
  actual: ActualSlots;
  log: (msg: string) => void;
}

/**
 * 与 helloBody 同一口径：Codex = 授权名额、QP1 暂停中为 0（hello 带 paused，借入方不派）；Claude = claudeLendSlots（登录 / 额度墙 / 运行时暂停）。
 * 出借循环把 Claude 就绪结论写在 journal meta：只读打开、比本进程新就认它（不写回、不探测），与出借循环报的对齐。journal 还没建 = 没暂停过。
 */
export function journalActualSlots(path = LEND_JOURNAL_PATH, claude: (e: LendEntry) => number = (e) => claudeLendSlots(e)): ActualSlots {
  return (entries, now) => {
    let paused: number | null = null;
    if (existsSync(path)) {
      const db = new Database(path, { readonly: true });
      try {
        db.exec(`PRAGMA busy_timeout = ${READ_BUSY_MS}`);
        paused = pausedUntil(db, now);
        const theirs = sharedClaudeReadiness(db);
        const mine = cachedClaudeReadiness();
        if (theirs && (!mine || theirs.at >= mine.at)) noteClaudeReadiness(theirs);
      } finally {
        db.close();
      }
    }
    return entries.map((e) => ({ codex: paused === null ? Math.max(0, e.families.codex ?? 0) : 0, claude: claude(e) }));
  };
}

const DEFAULTS: LendQuotaLinesDeps = {
  linesPath: QUOTA_LINES_PATH, lendPath: LEND_PATH, now: Date.now, facts: (now) => refreshQuotaFacts(now), context: readLendContext,
  actual: journalActualSlots(), log: (m) => console.warn(m),
};

async function view(d: LendQuotaLinesDeps, lines: QuotaLinesRead): Promise<LendQuotaLinesView> {
  const now = d.now();
  const facts = await d.facts(now);
  const [read, ctx] = [await readLend(d.lendPath), await d.context()];
  const grants = effectiveLend(read, ctx.contacts, ctx.projects, now).lend;
  let actual: Record<LendFamily, number>[] | null;
  try { actual = d.actual(grants, now); } catch (e) { d.log(`⚠️ [lend-quota-lines] 读实际可接容量失败，按未知显示：${(e as Error).message}`); actual = null; }
  const families = LEND_FAMILIES.map((f) => {
    const v = familyLine(f, { lines, facts }, now);
    const sum = (pick: (i: number) => number) => grants.reduce((n, _, i) => n + pick(i), 0);
    return {
      ...v,
      granted: sum((i) => grants[i]!.families[f] ?? 0),
      lineCap: sum((i) => capSlots(v.limit, grants[i]!.families[f] ?? 0)),
      available: actual ? sum((i) => actual![i]![f]) : null,
      slots: actual ? sum((i) => capSlots(v.limit, actual![i]![f])) : null,
    };
  });
  if (lines.status === "invalid") d.log(`⚠️ [lend-quota-lines] 额度线配置无效，按默认执行：${lines.error}`);
  const error: ConfigError | null = lines.status !== "invalid" ? null : lines.unreadable ? "config_unreadable" : "config_invalid";
  return { ok: true, config: { status: lines.status, error, mode: lines.file.mode }, at: now, families };
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

/** 保存失败对外只给这两句；原始错误（含本机路径）进日志 */
const SAVE_ERRORS = { busy: "额度线配置正被别的请求修改，稍后再试", io: "保存额度线配置失败，没有生效（详情见本机日志）" } as const;

async function save(d: LendQuotaLinesDeps, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const patch = parsePatch(body);
  if (typeof patch === "string") return apiJson(400, { ok: false, error: patch });
  const r = await saveQuotaLines(patch, d.linesPath, d.now());
  if (!r.ok) {
    d.log(`⚠️ [lend-quota-lines] 保存额度线配置失败（${r.code}）：${r.error}`);
    return apiJson(r.code === "busy" ? 503 : 500, { ok: false, code: r.code, error: SAVE_ERRORS[r.code] });
  }
  if (r.replacedInvalid) d.log(`⚠️ [lend-quota-lines] 原配置文件损坏（${r.replacedInvalid}），已另存后按这次保存的内容重写`);
  const out = await view(d, { status: "ok", file: r.file });
  return apiJson(200, r.replacedInvalid ? { ...out, warning: "replaced_invalid" } : out);
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
