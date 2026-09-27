/**
 * 远程终端（bridge/web-terminal.ts）：SSE 下行 + POST 输入 / resize。凭据 grant 里要有 terminal，否则 403。
 * 浏览器断开 → signal abort → bridge 销毁 PTY + viewer session（生命周期跟着这条流走，无需显式 close）。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api, apiStream } from "./client";

export function terminalStream(agent: string, cols: string | number, rows: string | number, signal: AbortSignal): Promise<Response> {
  return apiStream(`/agents/${encodeURIComponent(apiAgentName(agent))}/terminal?cols=${encodeURIComponent(String(cols))}&rows=${encodeURIComponent(String(rows))}`, { signal });
}

/** d = base64(原始字节，xterm onData 的转义序列原样)；逐键 / 微批，bridge 不限流 */
export function terminalInput(id: string, d: string): Promise<void> {
  return api(`/terminal/${encodeURIComponent(id)}/input`, { method: "POST", json: { d }, timeoutMs: 5_000 }).then(() => undefined);
}

/** bridge 按 tmux window 实际尺寸 clamp 过再回来（iTerm 钳制时 < 请求值） */
export function terminalResize(id: string, cols: number, rows: number): Promise<{ cols?: number; rows?: number }> {
  return api(`/terminal/${encodeURIComponent(id)}/resize`, { method: "POST", json: { cols, rows }, timeoutMs: 5_000 });
}
