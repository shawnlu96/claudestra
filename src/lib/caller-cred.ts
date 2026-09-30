/**
 * MCP 调用方身份的凭据（T85，docs/architecture/caller-identity.md）：每次启动一个会话，manager / launcher 签一个随机凭据，
 * 只交给 MCP 服务进程（CC：--mcp-config 里该服务的 env；Codex ACP：宿主进程，它起适配器前就从环境里删掉），
 * 从不进 Claude Code / Codex 主进程的环境，于是它们的 Bash 子进程拿不到。
 * 落盘的只有 sha256 → {agent, 启动时的会话, 运行时}；同一个 agent 再签就删掉旧的，重启后旧凭据当场失效。
 * 明文只在「manager 写一次性文件 → 启动命令里的 shell 展开读走并删掉」这几百毫秒里在盘上（oneShotArg）。
 * tests/caller-cred.test.ts。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomic } from "./state-file.js";

/** channel-server / acp-host 读凭据的环境变量名（只出现在 MCP 服务 / 宿主自己的环境里，读完即删） */
export const CALLER_CRED_ENV = "CLAUDESTRA_CALLER_CRED";
export const CALLER_CREDS_PATH = statePath("caller-creds.json");
const ONE_SHOT_DIR = statePath("run", "caller-cred");
/** 一次性文件没被 shell 读走（窗口没起来、命令没执行）时的清扫线 */
const ONE_SHOT_STALE_MS = 10 * 60_000;

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

/** 从环境里取走凭据（取完删掉，本进程再起的子进程就继承不到） */
export function takeCallerCred(env: Record<string, string | undefined>): string | undefined {
  const v = env[CALLER_CRED_ENV]?.trim();
  delete env[CALLER_CRED_ENV];
  return v || undefined;
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
  const path = join(dir, `${randomBytes(8).toString("hex")}.cred`);
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  return path;
}

/** 就绪后兜底删一次（正常早已被 shell 读走删掉） */
export function discardOneShot(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

/**
 * 启动命令里的那一截：`"$(cat 文件; rm -f 文件)"`。命令行、zsh 历史、tmux 屏幕上只有路径；
 * 文件已经不在（被清扫）时退回 fallback，会话照样起来，只是身份是 verified=false。
 */
export function oneShotArg(path: string, fallback: string, esc: (s: string) => string): string {
  return `"$(cat ${esc(path)} 2>/dev/null || printf '%s' ${esc(fallback)}; rm -f ${esc(path)})"`;
}
