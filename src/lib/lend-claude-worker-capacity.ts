/**
 * 出借 Claude 位：worker 用出借方本机已有的 Claude Code 登录（和本机新开 worker 一样），不要 setup-token。
 * 本机没登录 / 额度满时报 0 位并说原因——与 QP1 的 Codex 撞额度同一路：容量报 0，借入方就不派，lend status 写原因。
 * 判定缓存在进程里，过期后后台刷新，读的一方永远同步拿缓存；还没探过 = 先报 0（下一轮就有结果）。tests/lend-claude-capacity.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LendEntry } from "./lend-config.js";
import { LEASED_STATES, openSlots, ordersToday } from "./lend-journal.js";
import { pausedUntil, quotaViewOf, type QuotaView } from "./lend-health.js";
import { readInventoryQuota } from "./ai-quota.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";
import { isTestProcess } from "./test-guard.js";

export interface ClaudeReadiness { ready: boolean; reason: string | null; at: number }
export const CLAUDE_READY_FRESH_MS = 60_000;
const CHECKING = "正在核对本机 Claude 登录";
let cached: ClaudeReadiness | null = null;
let inflight: Promise<ClaudeReadiness> | null = null;
let warned: string | null = null;

const claudeQuota = async (): Promise<QuotaView> => quotaViewOf((await readInventoryQuota()).claude);

/** 用 worker 同一份环境跑 `claude auth status --json`，返回原样输出；测试进程不跑真 CLI（结果随机器变） */
export async function claudeAuthStatus(env: Record<string, string | undefined> = process.env): Promise<string> {
  if (isTestProcess()) throw new Error("测试进程不探本机 Claude 登录");
  const bin = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (!bin) throw new Error("找不到 Claude Code CLI");
  const childEnv = { ...pickWorkerEnv(env), ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}) };
  const proc = Bun.spawn([bin, "auth", "status", "--json"], { env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 15_000 });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return text;
}

/**
 * 本机 Claude 能不能接单：null = 能，否则一句原因。只看 auth status 的 loggedIn（不读凭据、不花额度），再看本机 Claude 额度是否已满。
 * 登录过期在这里看不出来，worker 第一轮会以 API 错误结束，走 bridge 现有的 API 错误处理。
 */
export async function probeClaudeLend(io = { status: () => claudeAuthStatus(), quota: claudeQuota }): Promise<string | null> {
  let text: string;
  try { text = await io.status(); } catch (e) { return (e as Error).message; }
  let loggedIn: unknown;
  try { loggedIn = (JSON.parse(text) as { loggedIn?: unknown }).loggedIn; } catch { loggedIn = undefined; /* 非 JSON 落到下一行的原因里 */ }
  if (typeof loggedIn !== "boolean") return "读不到 claude auth status 的结果（Claude Code 太旧或卡住）";
  if (!loggedIn) return "本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login";
  const q = await io.quota().catch((e) => { console.error(`[lend] 读本机 Claude 额度失败，按未知处理：${(e as Error).message}`); return null; });
  if (q?.full) return `本机 Claude 额度已满${q.resetsAt ? `，${new Date(q.resetsAt).toISOString()} 重置` : ""}`;
  return null;
}

/** 立即重探（同一时刻只跑一份）；探测本身出错也落成「不可用 + 原因」，不留在「正在核对」 */
export function refreshClaudeReadiness(probe: () => Promise<string | null> = () => probeClaudeLend()): Promise<ClaudeReadiness> {
  inflight ??= probe().then((reason) => ({ ready: reason === null, reason, at: Date.now() }),
    (e) => ({ ready: false, reason: `核对本机 Claude 登录失败：${(e as Error).message}`, at: Date.now() }))
    .then((r) => (cached = r)).finally(() => { inflight = null; });
  return inflight;
}

/** 同步读缓存；过期就在后台刷新。null = 还没探过 */
export function claudeReadiness(now = Date.now()): ClaudeReadiness | null {
  if (!cached || now - cached.at >= CLAUDE_READY_FRESH_MS) void refreshClaudeReadiness();
  return cached;
}

/** 等到一份新鲜结果（bridge 面板接口用）；缓存新鲜就直接给 */
export async function freshClaudeReadiness(now = Date.now()): Promise<ClaudeReadiness> {
  return cached && now - cached.at < CLAUDE_READY_FRESH_MS ? cached : refreshClaudeReadiness();
}

/** 外部已有的判定（测试桩 / 刚探过）直接记进缓存 */
export function noteClaudeReadiness(r: ClaudeReadiness | null): void { cached = r; }

export function claudeLendSlots(entry: LendEntry | undefined, log: (s: string) => void = console.error): number {
  const slots = entry?.families.claude ?? 0;
  if (!slots) return 0;
  const r = claudeReadiness();
  if (r?.ready) { warned = null; return slots; }
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
    busy: { codex: busy("codex"), claude: busy("claude") }, roles: e.roles, repos: e.repos,
    ordersLeftToday: Math.max(0, e.ordersPerDay - ordersToday(db, e.peer, now)) };
}
