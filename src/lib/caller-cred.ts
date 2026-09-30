/**
 * MCP 调用方身份的凭据（T85，docs/architecture/caller-identity.md）：每次启动一个会话，manager / launcher 签一个随机凭据，
 * 明文只写进一次性文件（目录 0700、文件 0600），argv 和环境里只有它的路径（`ps -E` 看得到进程的启动环境，进程里 delete 也抹不掉）；
 * 路径只给 MCP 服务进程（CC：--mcp-config 里该服务的 env；Codex ACP：宿主进程），它读进内存就删文件（takeCallerCred）。
 * 盘上的窗口 = 启动 → MCP 服务读走，manager / launcher 就绪或失败后兜底再删。Claude Code / Codex 主进程与它们的 Bash 子进程都拿不到。
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
/** 一次性文件没被 shell 读走（窗口没起来、命令没执行）时的清扫线 */
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

/** 签一个新凭据并返回明文（只在内存里交给调用方）。同一 agent 的旧记录一并删掉 = 旧凭据立即失效 */
export async function issueCallerCred(rec: Omit<CredRecord, "issuedAt">, path = CALLER_CREDS_PATH): Promise<string> {
  const token = newCredToken();
  const lock = await acquireLock(`${path}.lock`, 10_000);
  try {
    const creds: Record<string, CredRecord> = {};
    for (const [h, r] of Object.entries(readCredStore(path))) if (r.agent !== rec.agent) creds[h] = r;
    creds[hashCred(token)] = { ...rec, issuedAt: new Date().toISOString() };
    await writeJsonAtomic(path, { version: 1, creds } satisfies CredStore, { mode: 0o600 });
  } finally {
    lock?.release();
  }
  return token;
}

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

/** 写一次性文件（目录 0700、文件 0600），顺手清掉超时没被读走的旧文件。返回路径 */
export function writeOneShot(content: string, dir = ONE_SHOT_DIR, now = Date.now()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > ONE_SHOT_STALE_MS) rmSync(p, { force: true });
    } catch (e) {
      console.error(`⚠ 清不掉过期的一次性凭据文件 ${p}：${(e as Error).message}`); // 下次签发再清，不挡这次启动
    }
  }
  const path = join(dir, `${randomBytes(8).toString("hex")}.cred`); // 名字须合 ONE_SHOT_NAME
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  return path;
}

/** 启动失败时兜底删（正常早被 MCP 服务读走删掉） */
export function discardOneShot(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

/**
 * 就绪后兜底删：先等 MCP 服务自己读走（CC 的就绪看的是 TUI，MCP 服务可能还没起来，删早了它就只能 verified=false），
 * 最多等 waitMs 再删。正常路径文件早已不在，立即返回。
 */
export async function discardOneShotAfterReady(path: string | undefined, waitMs = 20_000): Promise<void> {
  for (const end = Date.now() + waitMs; path && existsSync(path) && Date.now() < end; ) await Bun.sleep(250);
  discardOneShot(path);
}
