/**
 * 远程终端（bridge/web-terminal.ts）：SSE 下行 + POST 输入 / resize。凭据 grant 里要有 terminal，否则 403。
 * 浏览器断开 → signal abort → bridge 销毁 PTY + viewer session（生命周期跟着这条流走，无需显式 close）。
 * 宿主 shell（/shells）的窗口本身不跟流走：断开只收 viewer，要 closeShell 才结束。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api, apiStream } from "./client";

/** 宿主 shell（bridge/web-shell.ts）在 TerminalView 里的目标写法：agent 名过不了「:」的校验，不会撞 */
const SHELL_PREFIX = "shell:";
export const shellTerminalTarget = (id: string): string => `${SHELL_PREFIX}${id}`;

/** target = agent 名或 shellTerminalTarget(id) */
export function terminalStreamPath(target: string, cols: string | number, rows: string | number): string {
  const base = target.startsWith(SHELL_PREFIX)
    ? `/shells/${encodeURIComponent(target.slice(SHELL_PREFIX.length))}`
    : `/agents/${encodeURIComponent(apiAgentName(target))}`;
  return `${base}/terminal?cols=${encodeURIComponent(String(cols))}&rows=${encodeURIComponent(String(rows))}`;
}

export function terminalStream(target: string, cols: string | number, rows: string | number, signal: AbortSignal): Promise<Response> {
  return apiStream(terminalStreamPath(target, cols, rows), { signal });
}

/** d = base64(原始字节，xterm onData 的转义序列原样)；逐键 / 微批，bridge 不限流 */
export function terminalInput(id: string, d: string): Promise<void> {
  return api(`/terminal/${encodeURIComponent(id)}/input`, { method: "POST", json: { d }, timeoutMs: 5_000 }).then(() => undefined);
}

/** bridge 按 tmux window 实际尺寸 clamp 过再回来（iTerm 钳制时 < 请求值） */
export function terminalResize(id: string, cols: number, rows: number): Promise<{ cols?: number; rows?: number }> {
  return api(`/terminal/${encodeURIComponent(id)}/resize`, { method: "POST", json: { cols, rows }, timeoutMs: 5_000 });
}

export interface ShellInfo {
  id: string;
  cwd: string;
}
export interface ShellDir {
  label: string;
  dir: string;
}
export interface ShellList {
  shells: ShellInfo[];
  /** 可选起始目录（家目录 + 登记过的项目目录），第一项是缺省；新建只收这里面的 */
  dirs: ShellDir[];
  /** 宿主的家目录（列表里把路径缩写成 ~ 用） */
  home: string;
  max: number;
}

/** home 前缀缩成 ~（shell 列表与终端标题用）；只认整段目录，/Users/he2 不会变成 ~2 */
export function shortPath(p: string, home: string): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** 403 = 这台设备没有覆盖 master 的终端授予（入口就不给）；404 = bridge 太老没有这个接口 */
export const listShells = (): Promise<ShellList> => api<ShellList>("/shells");
export const createShell = (dir?: string): Promise<{ shell: ShellInfo }> => api("/shells", { method: "POST", json: dir ? { dir } : {} });
/** 结束 shell（kill-window）；只断开不用调它，shell 会留着 */
export const closeShell = (id: string): Promise<void> => api(`/shells/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
