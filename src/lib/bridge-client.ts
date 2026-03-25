/**
 * Bridge WebSocket Client — 共享的轻量级 Bridge 请求工具
 * 被 manager.ts 和 discord-reply.ts 使用
 */

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";

export async function bridgeRequest(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Bridge 请求超时 (10s)"));
    }, 10000);

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
      reject(new Error("无法连接 Bridge。请确认: pm2 start --only discord-bridge"));
    };
  });
}
