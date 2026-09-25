import { networkInterfaces, homedir, platform as osPlatform } from "node:os";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { clientIpFromXff, isLocalClient } from "./local-client";
import { detectOpeners, openArgv, type Opener, type Platform, type Probe } from "./openers";

/**
 * 主机信息（server-side only）：本机网卡地址、平台、能打开目录的程序。
 * 探测结果缓存 10 分钟，过期后下一次请求顺手重探（不用定时器）；「本地」按每个请求现算。
 */
const PROBE_TTL_MS = 10 * 60 * 1000;

export function currentPlatform(): Platform {
  const p = osPlatform();
  return p === "darwin" || p === "win32" ? p : "linux";
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function realProbe(): Probe {
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = currentPlatform() === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return {
    exists: (p) => existsSync(expandHome(p)),
    which: (cmd) => pathDirs.some((d) => exts.some((e) => existsSync(join(d, cmd + e)))),
  };
}

let cache: { openers: Opener[]; at: number } | null = null;

export function probeOpeners(): Opener[] {
  if (cache && Date.now() - cache.at < PROBE_TTL_MS) return cache.openers;
  cache = { openers: detectOpeners(currentPlatform(), realProbe()), at: Date.now() };
  return cache.openers;
}

/** 本机所有网卡地址（含 loopback、LAN、tailnet） */
export function localIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const ni of list ?? []) out.push(ni.address);
  return out;
}

export function requestIsLocal(req: Request): boolean {
  return isLocalClient(clientIpFromXff(req.headers.get("x-forwarded-for")), localIps());
}

export interface HostInfo {
  local: boolean;
  platform: Platform;
  openers: Opener[];
}

/** 非本机来源不给程序清单：装了什么软件不该告诉远端（前端本就只在 local 时用它） */
export function hostInfoFor(req: Request): HostInfo {
  const local = requestIsLocal(req);
  return { local, platform: currentPlatform(), openers: local ? probeOpeners() : [] };
}

/** 用 id 对应的程序打开目录；目录必须真实存在。resolve 到 spawn 成功即返回（GUI 程序自己活着）。 */
export function openDirectory(id: string, dir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      if (!statSync(dir).isDirectory()) return resolve({ ok: false, error: "目录不存在" });
    } catch {
      return resolve({ ok: false, error: "目录不存在" }); // stat 抛错 = 路径不存在或无权限，都按不存在报
    }
    const argv = openArgv(id, dir, currentPlatform(), realProbe());
    if (!argv) return resolve({ ok: false, error: "不支持的打开方式" });
    const [cmd, ...args] = argv;
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (e) => resolve(e ? { ok: false, error: e.message } : { ok: true }));
  });
}
