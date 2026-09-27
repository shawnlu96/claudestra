/**
 * 本机「打开目录」的运行时部分：平台、真实探测（文件存在 / PATH 查找）、探测结果缓存 10 分钟、spawn。
 * 纯逻辑（候选表、拼 argv）在 lib/host-openers.ts；HTTP 面在 bridge/local-api/host.ts（只认回环来源）。
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { detectOpeners, openArgv, type Opener, type Platform, type Probe } from "./host-openers.js";

const PROBE_TTL_MS = 10 * 60_000;

export function currentPlatform(): Platform {
  const p = osPlatform();
  return p === "darwin" || p === "win32" ? p : "linux";
}

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Windows 上命令带扩展名；其余平台按原名找 */
const cmdSuffixes = (): string[] => (currentPlatform() === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]);

function realProbe(): Probe {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = cmdSuffixes();
  const which = (cmd: string): boolean => dirs.some((d) => exts.some((e) => existsSync(join(d, cmd + e))));
  return { exists: (p) => existsSync(expandHome(p)), which };
}

let cache: { openers: Opener[]; at: number } | null = null;

/** 过期后下一次请求顺手重探（不用定时器） */
export function probeOpeners(now: number = Date.now()): Opener[] {
  if (!cache || now - cache.at >= PROBE_TTL_MS) cache = { openers: detectOpeners(currentPlatform(), realProbe()), at: now };
  return cache.openers;
}

export type OpenResult = { ok: true } | { ok: false; error: string };

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false; // stat 抛错 = 路径不存在或无权限，对调用方都是「目录不存在」
  }
}

/** 用 id 对应的程序打开目录；目录必须真实存在。spawn 成功即 resolve（GUI 程序自己活着） */
export function openDirectory(id: string, dir: string): Promise<OpenResult> {
  if (!isDirectory(dir)) return Promise.resolve({ ok: false, error: "目录不存在" });
  const argv = openArgv(id, dir, currentPlatform(), realProbe());
  if (!argv) return Promise.resolve({ ok: false, error: "不支持的打开方式" });
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (e) => resolve(e ? { ok: false, error: e.message } : { ok: true }));
  });
}
