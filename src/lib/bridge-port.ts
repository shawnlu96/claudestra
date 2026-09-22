/**
 * bridge 端口的派生与「漂移」判定（纯函数，单测覆盖）。
 *
 * 为什么需要：tmux server 的全局环境停在它被创建的那一刻。改了 .env 的 BRIDGE_PORT /
 * BRIDGE_URL 之后，bridge 换到了新端口，但：
 *  - 每个 claude 进程启动时带着的 BRIDGE_URL 还是旧的，channel-server 按设计退避重连旧端口
 *    ⇒ 全员离线且不报错；
 *  - tmux 新窗口继承的 BRIDGE_PORT 也还是旧的，读它的 Stop hook 静默打到旧端口。
 * 所以一方面启动命令显式带上 BRIDGE_PORT、hook 统一从 resolveBridgeUrl 推端口，
 * 另一方面 launcher 比对 tmux 全局环境与当前配置，漂了就整体重启。
 */

import { DEFAULT_BRIDGE_PORT, resolveBridgeUrl } from "./bridge-url.js";

/** ws://host:port/... 里的端口；没写端口按协议默认值 */
export function bridgePortOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    if (u.protocol === "ws:" || u.protocol === "http:") return 80;
    if (u.protocol === "wss:" || u.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

/** 本机 bridge 的 HTTP 基址（hook / manager 通知用）。端口跟随 BRIDGE_URL，其次 BRIDGE_PORT */
export function bridgeHttpBase(env: Record<string, string | undefined> = process.env): string {
  const port = bridgePortOf(resolveBridgeUrl(env)) ?? DEFAULT_BRIDGE_PORT;
  return `http://127.0.0.1:${port}`;
}

/** 与 ws 地址同主机同端口的 HTTP 地址（探活用；远程 bridge 就探远程） */
export function bridgeHttpUrlOf(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}`;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function endpointKey(url: string): string | null {
  try {
    const u = new URL(url);
    const host = LOOPBACK.has(u.hostname) ? "loopback" : u.hostname.toLowerCase();
    return `${host}:${bridgePortOf(url)}`;
  } catch {
    return null;
  }
}

/**
 * tmux 全局环境（进程们启动时拿到的）与当前配置指向的 bridge 是否不同。
 * localhost / 127.0.0.1 视为同一主机，避免写法差异触发一次全员重启。
 * 解析不了的不算漂移（宁可不动，也不因为脏值把所有会话重启一遍）。
 */
export function bridgeDrift(
  tmuxEnv: { BRIDGE_URL?: string; BRIDGE_PORT?: string },
  current: string,
): { from: string; to: string } | null {
  const from = resolveBridgeUrl(tmuxEnv);
  const a = endpointKey(from);
  const b = endpointKey(current);
  if (!a || !b || a === b) return null;
  return { from, to: current };
}

/** `tmux show-environment -g NAME` 的输出 → 值；未设置 / 已 unset（`-NAME`）返回 undefined */
export function parseTmuxEnvLine(out: string, name: string): string | undefined {
  const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : undefined;
}
