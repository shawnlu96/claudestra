/**
 * Bridge WebSocket Client — 共享的轻量级 Bridge 请求工具
 * 被 manager.ts 和 discord-reply.ts 使用
 */

import { resolveBridgeUrl } from "./bridge-url.js";
import { resolveLogPath } from "./log-paths.js";

const BRIDGE_URL = resolveBridgeUrl();

/** timeoutMs：缺省 10s；批量管理（manager fleet）这类要逐个 agent 发键复核的请求自己给更长的 */
export async function bridgeRequest(msg: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any> {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Bridge 请求超时 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ ...msg, requestId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (data.requestId === requestId) {
          clearTimeout(timer);
          ws.close();
          if (data.error) reject(new Error(data.error));
          else resolve(data.result);
        }
      } catch { /* non-critical */ }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(
        new Error(
          "无法连接 Bridge。检查：launchctl list | grep claudestra；" +
            "重启：launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge；" +
            `日志：${resolveLogPath("bridge", "err")}`
        )
      );
    };
  });
}

type BridgeSendResult = { ok: true; result: any } | { ok: false; sent: boolean; error: string; rejected?: string };

/**
 * Like bridgeRequest, for callers that must not resend blindly: sent=false means the request never left this process or
 * the bridge answered with a typed `rejected` code (refused before any delivery) — safe to plan again. Any other error
 * after sending is sent=true: the bridge may have delivered before failing, so the outcome is unknown.
 * stillActive is asked in the same synchronous block as the send: a caller that stopped during the handshake sends nothing.
 */
export async function bridgeSend(msg: Record<string, unknown>, opts?: { timeoutMs?: number; stillActive?: () => boolean }): Promise<BridgeSendResult> {
  return new Promise((resolve) => {
    let sent = false;
    let done = false;
    const ws = new WebSocket(BRIDGE_URL);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const finish = (r: BridgeSendResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, sent, error: "Bridge 请求超时" }), opts?.timeoutMs ?? 10000);
    ws.onopen = () => {
      if (opts?.stillActive && !opts.stillActive()) return finish({ ok: false, sent: false, error: "发送方已停止，帧没有发出" });
      ws.send(JSON.stringify({ ...msg, requestId }));
      sent = true;
    };
    ws.onmessage = (event) => {
      let data: any;
      try {
        data = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return; // a frame that is not JSON is some other broadcast on this socket, not our answer
      }
      if (data?.requestId !== requestId) return;
      if (!data.error) return finish({ ok: true, result: data.result });
      const rejected = typeof data.rejected === "string" ? data.rejected : undefined;
      finish({ ok: false, sent: rejected ? false : sent, error: String(data.error), ...(rejected ? { rejected } : {}) });
    };
    ws.onerror = () => finish({ ok: false, sent, error: "Bridge 连接出错" });
    ws.onclose = () => finish({ ok: false, sent, error: "Bridge 连接在答复前断开" });
  });
}
