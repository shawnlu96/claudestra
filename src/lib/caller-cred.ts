/**
 * MCP 调用方身份的凭据（T85，docs/architecture/caller-identity.md）：每次启动一个会话，manager / launcher 签一个随机凭据，
 * 明文只写进一次性文件（目录 0700、文件 0600），argv 和环境里只有它的路径（`ps -E` 看得到进程的启动环境，进程里 delete 也抹不掉）；
 * 路径只给 MCP 服务进程（CC：--mcp-config 里该服务的 env；Codex ACP：宿主进程），它读进内存就删文件（takeCallerCred）。
 * 盘上的窗口 = 启动 → MCP 服务读走，启动收尾（就绪、失败、异常、信号）兜底再删（withOneShot）。Claude Code / Codex 主进程与它们的 Bash 子进程都拿不到。
 * 落盘长存的只有 sha256 → {agent, 启动时的会话, 运行时}；同一个 agent 再签就删掉旧的，重启后旧凭据当场失效。
 * tests/caller-cred.test.ts。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomic } from "./state-file.js";

/** 一次性凭据文件路径的环境变量名（只出现在 MCP 服务 / 宿主自己的环境里）；值是路径，不是凭据 */
export const CALLER_CRED_FILE_ENV = "CLAUDESTRA_CALLER_CRED_FILE";
export const CALLER_CREDS_PATH = statePath("caller-creds.json");
const ONE_SHOT_DIR = statePath("run", "caller-cred");
/** 一次性文件没被读走、启动进程又没来得及删（被 kill -9）时的清扫线 */
const ONE_SHOT_STALE_MS = 10 * 60_000;
/** writeOneShot 起的文件名；takeCallerCred 只删长这样的文件（路径来自环境变量，不能让它删到别的文件） */
const ONE_SHOT_NAME = /^[0-9a-f]{16}\.cred$/;

export interface CredRecord {
  agent: string;
  /** 启动时已知的会话 id（fork 的新 id 启动后才知道，这里就没有）；身份里的会话以 registry 当前值为准 */
  sessionId?: string;
  /** 模型家族 = registry 的 runtime（claude-code / codex / pi） */
  family: string;
  issuedAt: string;
}

interface CredStore {
  version: 1;
  creds: Record<string, CredRecord>;
}

export const hashCred = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
export const newCredToken = (): string => randomBytes(32).toString("hex");

const isStore = (d: unknown): d is CredStore =>
  !!d && typeof d === "object" && typeof (d as CredStore).creds === "object" && (d as CredStore).creds !== null;

export function readCredStore(path = CALLER_CREDS_PATH): Record<string, CredRecord> {
  const r = readJsonStateSync(path, isStore);
  return r.status === "ok" ? (r.data as CredStore).creds : {};
}

/** 凭据 → 它签给谁；没签过 / 已被同 agent 的新凭据顶掉 → null */
export function lookupCred(creds: Record<string, CredRecord>, token: string | undefined | null): CredRecord | null {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  return creds[hashCred(token)] ?? null;
}

/** 在锁里删掉 agent 的全部记录，再按需记一条新的 */
async function replaceAgentCreds(agent: string, add: [string, CredRecord] | undefined, path: string): Promise<void> {
  const lock = await acquireLock(`${path}.lock`, 10_000);
  try {
    const old = readCredStore(path);
    const creds: Record<string, CredRecord> = {};
    for (const [h, r] of Object.entries(old)) if (r.agent !== agent) creds[h] = r;
    if (!add && Object.keys(creds).length === Object.keys(old).length) return; // 没有可撤的：不写文件，bridge 的缓存也不用失效
    if (add) creds[add[0]] = add[1];
    await writeJsonAtomic(path, { version: 1, creds } satisfies CredStore, { mode: 0o600 });
  } finally {
    lock?.release();
  }
}

/** 签一个新凭据并返回明文（只在内存里交给调用方）。同一 agent 的旧记录一并删掉 = 旧凭据立即失效 */
export async function issueCallerCred(rec: Omit<CredRecord, "issuedAt">, path = CALLER_CREDS_PATH): Promise<string> {
  const token = newCredToken();
  await replaceAgentCreds(rec.agent, [hashCred(token), { ...rec, issuedAt: new Date().toISOString() }], path);
  return token;
}

/** 撤销 agent 的全部凭据、不签新的：这次启动的运行时不签（Pi / Codex tmux 版，含 ACP 退回 tmux），上一代的也不能再算数 */
export const revokeCallerCreds = (agent: string, path = CALLER_CREDS_PATH): Promise<void> => replaceAgentCreds(agent, undefined, path);

/**
 * 按环境里的路径读走凭据并删文件，环境变量也删（本进程再起的子进程继承不到）。文件已不在（/mcp 重连、被兜底删了）
 * = undefined：连接照样注册，只是 verified=false，重启 agent 才有新凭据。
 */
export function takeCallerCred(env: Record<string, string | undefined>): string | undefined {
  const path = env[CALLER_CRED_FILE_ENV]?.trim();
  delete env[CALLER_CRED_FILE_ENV];
  if (!path || !ONE_SHOT_NAME.test(basename(path))) return undefined;
  let token = "";
  try {
    token = readFileSync(path, "utf8").trim();
    rmSync(path, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠ 读不了启动凭据文件（本次 verified=false）：${(e as Error).message}`);
  }
  return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
}

/**
 * 清掉超时没被读走的一次性文件（启动被 kill -9、进程崩在半路）。每次签发前清一次，launcher 开机与每轮巡检也清，
 * 所以没人再启动时残留也活不过 ONE_SHOT_STALE_MS + 一轮巡检。正常在途的文件最多活到就绪 + 20 秒，远在线内。
 */
export function sweepStaleOneShots(dir = ONE_SHOT_DIR, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠ 读不了一次性凭据目录 ${dir}：${(e as Error).message}`);
    return; // 目录还没建过 = 没有残留
  }
  for (const f of names) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > ONE_SHOT_STALE_MS) rmSync(p, { force: true });
    } catch (e) {
      console.error(`⚠ 清不掉过期的一次性凭据文件 ${p}：${(e as Error).message}`); // 下一轮再清，不挡启动
    }
  }
}

/** 写一次性文件（目录 0700、文件 0600），顺手清掉超时没被读走的旧文件。返回路径 */
export function writeOneShot(content: string, dir = ONE_SHOT_DIR, now = Date.now()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleOneShots(dir, now);
  const path = join(dir, `${randomBytes(8).toString("hex")}.cred`); // 名字须合 ONE_SHOT_NAME
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  return path;
}

/** 启动失败时兜底删（正常早被 MCP 服务读走删掉） */
function discardOneShot(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

/** 在途的一次性文件：进程在启动半路退出时（exit / 信号）同步删掉 */
const pendingOneShots = new Set<string>();
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function dropPendingOneShots(): void {
  for (const p of pendingOneShots) {
    try {
      discardOneShot(p);
    } catch (e) {
      console.error(`⚠ 退出时删不掉一次性凭据文件 ${p}：${(e as Error).message}`); // 过期后由签发 / launcher 巡检清扫
    }
  }
  pendingOneShots.clear();
}

function unhookOneShots(): void {
  process.off("exit", dropPendingOneShots);
  for (const s of EXIT_SIGNALS) process.off(s, onExitSignal);
}

/** 信号上只删文件、不改退出语义：别的监听者（create 的信号清理）在就交给它；没有 = 本来会被默认动作杀掉，按原信号再杀自己 */
function onExitSignal(sig: NodeJS.Signals): void {
  dropPendingOneShots();
  unhookOneShots();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

/**
 * 从写好文件到启动收尾都要包在这里：run 正常返回、抛异常、进程 exit（含 create 信号清理的 process.exit）、
 * 收到 SIGINT / SIGTERM / SIGHUP，文件都会删掉。kill -9 拦不住，靠 sweepStaleOneShots。tests/caller-cred-cleanup.test.ts。
 */
export async function withOneShot<T>(path: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!path) return run();
  if (!pendingOneShots.size) {
    process.on("exit", dropPendingOneShots);
    for (const s of EXIT_SIGNALS) process.on(s, onExitSignal);
  }
  pendingOneShots.add(path);
  try {
    return await run();
  } finally {
    pendingOneShots.delete(path);
    if (!pendingOneShots.size) unhookOneShots();
    discardOneShot(path);
  }
}

/**
 * 就绪后兜底删：先等 MCP 服务自己读走（CC 的就绪看的是 TUI，MCP 服务可能还没起来，删早了它就只能 verified=false），
 * 最多等 waitMs 再删。正常路径文件早已不在，立即返回。
 */
export async function discardOneShotAfterReady(path: string | undefined, waitMs = 20_000): Promise<void> {
  for (const end = Date.now() + waitMs; path && existsSync(path) && Date.now() < end; ) await Bun.sleep(250);
  discardOneShot(path);
}
