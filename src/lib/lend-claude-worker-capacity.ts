/**
 * 出借 Claude 位：worker 用出借方本机已有的 Claude Code 登录（和本机新开 worker 一样），不要 setup-token。
 * 本机没登录 / 额度满时报 0 位并说原因——与 QP1 的 Codex 撞额度同一路：容量报 0，借入方就不派，lend status 写原因。
 * 判定缓存在进程里，过期后后台刷新，读的一方永远同步拿缓存；还没探过 = 先报 0（下一轮就有结果）。tests/lend-claude-capacity.test.ts。
 * 跨进程（常驻出借循环 ↔ 一次性的推送收单进程）经 journal meta 共享同一份结论：lend-claude-ready.ts。
 */
import type { Database } from "bun:sqlite";
import { LEND_ROLES, type LendEntry } from "./lend-config.js";
import { LEASED_STATES, openSlots, ordersToday } from "./lend-journal.js";
import { pausedUntil, quotaViewOf, type QuotaView } from "./lend-health.js";
import { readInventoryQuota } from "./ai-quota.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";
import { isTestProcess } from "./test-guard.js";
import { claudeAuthOutput } from "./lend-claude-pause-auth.js";
import { claudePauseReadiness, claudePauseSlots, resetClaudePauseCache } from "./lend-claude-pause.js";

export interface ClaudeReadiness { ready: boolean; reason: string | null; at: number }
export const CLAUDE_READY_FRESH_MS = 60_000;
const CHECKING = "正在核对本机 Claude 登录";
let cached: ClaudeReadiness | null = null;
let inflight: Promise<ClaudeReadiness> | null = null;
let warned: string | null = null;
/** 推送收单进程、常驻出借循环关掉（claudeReadinessManual）：结论只在它们显式探测时变，见 lend-claude-ready.ts */
let background = true;

/**
 * 不可用原因只有这几类固定文案（额度已满可带重置时刻）：原因会进 journal meta、lend status、stderr 和 bridge 日志，
 * 原始错误文本可能带本机路径和账号，一律不往外带。tests/lend-claude-ready-reason.test.ts。
 */
export const CLAUDE_REASONS = {
  noCli: "找不到 Claude Code CLI", testProcess: "测试进程不探本机 Claude 登录", unreadable: "读不到 claude auth status 的结果（Claude Code 太旧或卡住）",
  loggedOut: "本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login", failed: "核对本机 Claude 登录失败", timeout: "核对本机 Claude 登录超时",
  quotaFull: "本机 Claude 额度已满",
  nonzero: "claude auth status 非零退出，核对本机 Claude 登录失败",
} as const;
const FIXED_REASONS = new Set<string>(Object.values(CLAUDE_REASONS));
const QUOTA_RESET_RE = /^本机 Claude 额度已满，\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z 重置$/;
export const isClaudeReason = (s: unknown): s is string => typeof s === "string" && (FIXED_REASONS.has(s) || QUOTA_RESET_RE.test(s));

export const claudeQuota = async (): Promise<QuotaView> => quotaViewOf((await readInventoryQuota()).claude);

/** 用 worker 同一份环境跑 `claude auth status --json`，返回原样输出；到 timeoutMs 强杀。测试进程不跑真 CLI（结果随机器变） */
export async function claudeAuthStatus(env: Record<string, string | undefined> = process.env, timeoutMs = 15_000): Promise<string> {
  if (isTestProcess()) throw new Error(CLAUDE_REASONS.testProcess);
  const bin = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (!bin) throw new Error(CLAUDE_REASONS.noCli);
  const childEnv = { ...pickWorkerEnv(env), ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}) };
  const proc = Bun.spawn([bin, "auth", "status", "--json"], { env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return claudeAuthOutput(proc, timeoutMs);
}

/**
 * 本机 Claude 能不能接单：null = 能，否则一句原因。只看 auth status 的 loggedIn（不读凭据、不花额度），再看本机 Claude 额度是否已满。
 * 登录过期在这里看不出来，worker 的 API 错误由 lend-claude-pause-worker 判定并暂停。
 */
export async function probeClaudeLend(io = { status: () => claudeAuthStatus(), quota: claudeQuota }): Promise<string | null> {
  let text: string;
  try { text = await io.status(); } catch (e) { return FIXED_REASONS.has((e as Error).message) ? (e as Error).message : CLAUDE_REASONS.failed; }
  let loggedIn: unknown;
  try { loggedIn = (JSON.parse(text) as { loggedIn?: unknown }).loggedIn; } catch { loggedIn = undefined; /* 非 JSON 落到下一行的原因里 */ }
  if (typeof loggedIn !== "boolean") return CLAUDE_REASONS.unreadable;
  if (!loggedIn) return CLAUDE_REASONS.loggedOut;
  // 额度快照读不到不挡接单；原始错误可能带本机路径，收单进程的 stderr 还会转进 bridge 日志，所以只打固定文案
  const q = await io.quota().catch(() => { console.error("[lend] 读本机 Claude 额度失败，按未知处理"); return null; });
  if (q?.full && (q.resetsAt === null || q.resetsAt > Date.now())) return `${CLAUDE_REASONS.quotaFull}${q.resetsAt ? `，${new Date(q.resetsAt).toISOString()} 重置` : ""}`;
  return null;
}

/** 立即重探（同一时刻只跑一份）；探测出错或给了分类以外的原因都落成「核对失败」，不留在「正在核对」，也不带原始错误 */
export function refreshClaudeReadiness(probe: () => Promise<string | null> = () => probeClaudeLend()): Promise<ClaudeReadiness> {
  const at = Date.now(); // A probe begun before a runtime auth failure cannot certify a later retry.
  inflight ??= probe().then((reason) => ({ ready: reason === null, reason: reason === null || isClaudeReason(reason) ? reason : CLAUDE_REASONS.failed, at }),
    () => ({ ready: false, reason: CLAUDE_REASONS.failed, at }))
    .then((r) => (cached = r)).finally(() => { inflight = null; });
  return inflight;
}

/** 同步读缓存；过期就在后台刷新。null = 还没探过 */
export function claudeReadiness(now = Date.now()): ClaudeReadiness | null {
  if (background && (!cached || now - cached.at >= CLAUDE_READY_FRESH_MS)) void refreshClaudeReadiness();
  return claudePauseReadiness(cached, now);
}

/** 等到一份新鲜结果（bridge 面板接口、推送收单用）；缓存新鲜就直接给 */
export async function freshClaudeReadiness(now = Date.now(), probe?: () => Promise<string | null>): Promise<ClaudeReadiness> {
  return cached && now - cached.at < CLAUDE_READY_FRESH_MS ? cached : refreshClaudeReadiness(probe);
}

/** 外部已有的判定（测试桩 / 别的进程写进 meta 的）直接记进缓存；null = 回到进程刚起的样子（没结论、没提示过、后台刷新开着），测试模拟新进程用 */
export function noteClaudeReadiness(r: ClaudeReadiness | null): void {
  cached = r;
  if (r === null) { warned = null; background = true; resetClaudePauseCache(); }
}

/** 只读缓存，不触发刷新（跨进程同步用：没 Claude 授权的出借方不该因为同步就开始探） */
export const cachedClaudeReadiness = (): ClaudeReadiness | null => cached;

/** 本进程的结论只在调用方显式探测时变：claudeReadiness 不再后台刷新，调用方自己 await freshClaudeReadiness。测试传 false 复原 */
export function claudeReadinessManual(on = true): void { background = !on; }

export function claudeLendSlots(entry: LendEntry | undefined, log: (s: string) => void = console.error): number {
  const slots = entry?.families.claude ?? 0;
  if (!slots) return 0;
  const r = claudeReadiness();
  if (r?.ready) { warned = null; return claudePauseSlots(slots); }
  if (r?.reason && warned !== r.reason) { log(`[lend] Claude 位暂不可用（报 0 位）：${r.reason}`); warned = r.reason; }
  return 0;
}

/** 这一轮整体借不出去的原因（Codex 暂停或没授权、Claude 也没位）；还有能借的位 = null。doctor / lend status 读它 */
export function lendBlockedReason(paused: number | null, entries: LendEntry[]): string | null {
  if ((paused === null && entries.some((e) => (e.families.codex ?? 0) > 0)) || entries.some((e) => claudeLendSlots(e) > 0)) return null;
  const why = [paused !== null ? `本机 Codex 撞了额度，暂停借单到 ${new Date(paused).toISOString()}` : null,
    entries.some((e) => (e.families.claude ?? 0) > 0) ? `Claude 位不可用：${claudeReadiness()?.reason ?? CHECKING}` : null];
  return why.filter(Boolean).join("；") || null;
}

export const claudeHelloSlots = (db: Database, e: LendEntry | undefined) =>
  ({ total: claudeLendSlots(e), busy: e ? Math.min(openSlots(db, e.peer, "claude"), 100) : 0 });

/** v1 不改字段形状；busy 仍只数已领单，Codex 暂停只冻结 Codex。 */
export function lendPollCapacity(e: LendEntry, db: Database, now: number) {
  const busy = (family: string) => (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ?
    AND state IN (${LEASED_STATES.map(() => "?").join(",")})`).get(e.peer, family, ...LEASED_STATES) as { n: number }).n;
  return { families: { codex: pausedUntil(db, now) === null ? e.families.codex ?? 0 : 0, claude: claudeLendSlots(e) },
    busy: { codex: busy("codex"), claude: busy("claude") }, roles: [...LEND_ROLES], repos: e.repos,
    ordersLeftToday: Math.max(0, e.ordersPerDay - ordersToday(db, e.peer, now)) };
}
