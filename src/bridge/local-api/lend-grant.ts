/**
 * 出借方管理面（i28-R7a）：网页上给 peer 一次授权、一键收回、看借出中的单。
 *   GET  /api/v1/lend/grants         → {writeOpen, maxDays, shellSentence, grants, peers, orders}
 *   POST /api/v1/lend/grants         → manager `lend grant`（W1 的 CLI 定规则：until / 名额 / 仓库都由它判）
 *   POST /api/v1/lend/grants/revoke  → manager `lend revoke [--peer=名]`，回包带这个 peer 在跑的单
 * 授权规则只在 W1（lib/lend-grant-rules.ts、lend-policy.ts、manager/lend.ts）：这里只做类型整形、拒 write、拼 argv。
 * 值一律 `--flag=value`、peer 放 `--` 之后，请求体里的 `--xx` 进不了旗标位（tests/web-lend-api.test.ts 的注入反例）。
 * 门 = owner 本人 + 全权凭据（与 asks.ts 开 ask 同一道），三条都在起进程 / 读盘之前判。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { canReadLedger } from "../../lib/devices.js";
import { LEND_PATH, readLend, type LendEntry } from "../../lib/lend-config.js";
import { GRANT_MAX_DAYS, SHELL_SENTENCE, WRITE_ROLE_OPEN } from "../../lib/lend-grant-rules.js";
import { LEND_JOURNAL_PATH, LIVE_STATES } from "../../lib/lend-journal.js";
import { effectiveLend, readLendContext } from "../../lib/lend-policy.js";
import { isOwnerPrincipal, type Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { apiJson, forbidden } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";

/** 频道号置空 = 以 owner 身份跑（CLI 的 requireOwnerOrMaster 只认 owner），与 local-api/lend.ts 一致 */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };
const BODY_MAX = 16_384;
/** 只读连接等调度服务放锁的上限（写法照 lend-watchdog.ts） */
const READ_BUSY_MS = 2_000;
const ENDED_WINDOW_MS = 7 * 86_400_000;
const ENDED_LIMIT = 50;

export interface LendGrantDeps {
  run: (args: string[]) => Promise<any>;
  lendPath: string;
  journalPath: string;
  context: typeof readLendContext;
  now: () => number;
}

const DEFAULTS: LendGrantDeps = {
  run: (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 }),
  lendPath: LEND_PATH,
  journalPath: LEND_JOURNAL_PATH,
  context: readLendContext,
  now: Date.now,
};

export interface GrantView {
  peer: string; repos: string[]; roles: string[]; families: Record<string, number>; ordersPerDay: number;
  until: string | null; grantedAt: string | null; paused: string | null; problem: string | null;
}
export interface OrderView {
  orderId: string; peer: string; family: string; state: string; repo: string | null; pr: number | null; taskId: string | null; step: string | null;
  agent: string | null; startedAt: number | null; updatedAt: number; reason: string | null; notices: NoticesView | null;
}
type NoticesView = { start?: number; end?: { kind: string; why: string | null; sentAt: number | null } };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** lend.json 的每条声明 + W1 effectiveLend 判出的失效原因（暂停 / 过期 / 指纹变了 / 联系人没了）；总开关关着时整段不生效 */
async function grantsOf(d: LendGrantDeps, ctx: Awaited<ReturnType<LendGrantDeps["context"]>>): Promise<GrantView[]> {
  const read = await readLend(d.lendPath);
  if (read.status === "invalid") return [];
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, d.now());
  const live = new Set(eff.lend.map((e) => e.peer));
  const why = (e: LendEntry): string | null => {
    if (live.has(e.peer)) return null;
    if (!read.file.enabled) return "出借总开关关着";
    const prefix = `lend ${e.peer}：`;
    return eff.dropped.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? "未生效";
  };
  return read.file.lend.map((e) => ({
    peer: e.peer, repos: [...e.repos], roles: [...e.roles], families: { ...e.families } as Record<string, number>, ordersPerDay: e.ordersPerDay,
    until: e.until ?? null, grantedAt: e.grantedAt ?? null, paused: e.paused?.reason ?? null, problem: why(e),
  }));
}

function noticesOf(raw: unknown): NoticesView | null {
  if (typeof raw !== "string" || !raw) return null;
  let n: Record<string, unknown>;
  try {
    n = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // 坏的通知列只影响时间线显示，单子本身照列
  }
  const out: NoticesView = {};
  if (num(n.start) !== null) out.start = n.start as number;
  const end = n.end as Record<string, unknown> | undefined;
  if (end && typeof end === "object") out.end = { kind: String(end.kind ?? ""), why: str(end.why), sentAt: num(end.sentAt) };
  return out;
}

/** 字段白名单：wire.text、payload、receipt、dir 这些一律不出（tests/web-lend-api.test.ts「白名单」） */
function orderView(r: Record<string, unknown>): OrderView {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(String(r.preview ?? "{}")) as Record<string, unknown>;
  } catch {
    p = {}; // 摘要坏了只缺 repo / pr / step 显示
  }
  return {
    orderId: String(r.orderId), peer: String(r.peer), family: String(r.family), state: String(r.state),
    repo: str(p.repo), pr: num(p.pr), taskId: str(p.taskId), step: str(p.step),
    agent: str(r.agent), startedAt: num(r.startedAt), updatedAt: Number(r.updatedAt), reason: str(r.reason), notices: noticesOf(r.notices),
  };
}

/** 在跑的全部 + 7 天内最近 50 张已结束的；journal 还没建 = 没借出过 */
export function readOrders(path: string, now: number, peer?: string): { live: OrderView[]; ended: OrderView[] } {
  if (!existsSync(path)) return { live: [], ended: [] };
  const db = new Database(path, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${READ_BUSY_MS}`);
    const marks = LIVE_STATES.map(() => "?").join(",");
    const byPeer = peer === undefined ? "" : " AND peer = ?";
    const args = peer === undefined ? [] : [peer];
    const live = db.query(`SELECT * FROM lend_orders WHERE state IN (${marks})${byPeer} ORDER BY createdAt DESC`).all(...LIVE_STATES, ...args);
    const ended = peer !== undefined ? [] : db.query(`SELECT * FROM lend_orders WHERE state NOT IN (${marks}) AND updatedAt >= ? ORDER BY updatedAt DESC LIMIT ${ENDED_LIMIT}`)
      .all(...LIVE_STATES, now - ENDED_WINDOW_MS);
    return { live: (live as Record<string, unknown>[]).map(orderView), ended: (ended as Record<string, unknown>[]).map(orderView) };
  } finally {
    db.close();
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  if (Number(req.headers.get("content-length") || 0) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_MAX) return apiJson(413, { ok: false, error: `请求体超过 ${BODY_MAX} 字节` });
  try {
    const v = text ? (JSON.parse(text) as unknown) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 落到下面统一回 400
  }
  return apiJson(400, { ok: false, error: "请求体要是 JSON 对象" });
}

const bad = (error: string) => apiJson(400, { ok: false, error });
/** 数值只整形成字符串交给 CLI 判范围；不认得的类型直接拒，不替 CLI 补缺省 */
const numText = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v.trim() ? v.trim() : null;
const hasNul = (s: string) => s.includes("\0");

/** 请求体 → `lend grant` 的 argv；write 在这里就拒（WRITE_ROLE_OPEN=false 时不起进程），其余规则交给 CLI */
export function grantArgv(b: Record<string, unknown>): string[] | string {
  const roles = b.roles;
  if (roles !== undefined && (!Array.isArray(roles) || roles.some((r) => r !== "review"))) {
    return Array.isArray(roles) && roles.includes("write") ? "write 角色还没开放（W8 合并前出借方强制关）" : "roles 只能是 [\"review\"]";
  }
  const peer = b.peer;
  if (typeof peer !== "string" || !peer.trim() || hasNul(peer)) return "peer 要是非空字符串";
  const repos = b.repos;
  if (!Array.isArray(repos) || !repos.length || repos.some((r) => typeof r !== "string" || !r || r.includes(",") || hasNul(r))) {
    return "repos 要是非空的仓库名数组（owner/repo，不含逗号）";
  }
  if (typeof b.until !== "string" || !b.until.trim() || hasNul(b.until)) return "until 要是非空字符串（ISO 时间或 3d 这样的时长）";
  const codex = numText(b.codex);
  const perDay = numText(b.ordersPerDay);
  if (codex === null) return "codex 要是数字";
  if (perDay === null) return "ordersPerDay 要是数字";
  return [
    "lend", "grant", `--repos=${(repos as string[]).join(",")}`, `--until=${b.until.trim()}`,
    ...(codex === undefined ? [] : [`--codex=${codex}`]), ...(perDay === undefined ? [] : [`--orders-per-day=${perDay}`]),
    "--roles=review", "--", peer,
  ];
}

/** CLI 的结果原样转给前端：ok / error / warning / message，别的字段不带 */
function cliReply(r: any, extra: Record<string, unknown> = {}): Response {
  const pick = { ...(r?.error ? { error: String(r.error) } : {}), ...(r?.warning ? { warning: String(r.warning) } : {}), ...(r?.message ? { message: String(r.message) } : {}) };
  if (r?.ok) return apiJson(200, { ok: true, ...pick, ...extra });
  return apiJson(r?.code === "forbidden" ? 403 : 400, { ok: false, error: "lend 命令失败", ...pick });
}

async function runCli(d: LendGrantDeps, argv: string[]): Promise<any> {
  try {
    return await d.run(argv);
  } catch (e) {
    return { ok: false, error: `manager 起不来：${(e as Error).message}` };
  }
}

async function listAll(d: LendGrantDeps): Promise<Response> {
  const ctx = await d.context();
  const grants = await grantsOf(d, ctx);
  let orders: ReturnType<typeof readOrders>;
  try {
    orders = readOrders(d.journalPath, d.now());
  } catch (e) {
    // 读不了 journal 不能回空列表：前端会把「停止中」的单当成已从 journal 消失；503 让它保持原状下次再拉
    return apiJson(503, { ok: false, error: `读不了出借 journal：${(e as Error).message}` });
  }
  const peers = ctx.contacts.filter((c) => !c.disabled && c.fp).map((c) => ({ name: c.name, fp: c.fp as string }));
  return apiJson(200, { ok: true, writeOpen: WRITE_ROLE_OPEN, maxDays: GRANT_MAX_DAYS, shellSentence: SHELL_SENTENCE, grants, peers, orders: [...orders.live, ...orders.ended] });
}

async function revoke(d: LendGrantDeps, b: Record<string, unknown>): Promise<Response> {
  const peer = b.peer;
  if (peer !== undefined && (typeof peer !== "string" || !peer.trim() || hasNul(peer))) return bad("peer 要是非空字符串；不带 peer = 全部收回");
  const r = await runCli(d, ["lend", "revoke", ...(peer === undefined ? [] : [`--peer=${peer}`])]);
  if (!r?.ok) return cliReply(r);
  let live: OrderView[] = [];
  try {
    live = readOrders(d.journalPath, d.now(), peer as string | undefined).live;
  } catch (e) {
    // 收回已经落盘，快照只是让界面立刻转「停止中」；读不到就由前端下一次 GET 补上
    console.warn(`⚠️ [lend-grant] 收回后读 journal 失败：${(e as Error).message}`);
  }
  return cliReply(r, { orders: live });
}

export function makeLendGrantApi(deps: Partial<LendGrantDeps> = {}) {
  const d: LendGrantDeps = { ...DEFAULTS, ...deps };
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== "/lend/grants" && path !== "/lend/grants/revoke") return null;
    if (!isOwnerPrincipal(principal) || !canReadLedger(principal)) return forbidden("only the owner (full-access device) can manage lending");
    if (path === "/lend/grants" && req.method === "GET") return listAll(d);
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const body = await readBody(req);
    if (body instanceof Response) return body;
    if (path === "/lend/grants/revoke") return revoke(d, body);
    const argv = grantArgv(body);
    return typeof argv === "string" ? bad(argv) : cliReply(await runCli(d, argv));
  };
}

export const handleLendGrantApi = makeLendGrantApi();
