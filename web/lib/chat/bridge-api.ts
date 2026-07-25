/**
 * Bridge /api/v1 客户端（BFF 专用，server-side only）。
 *
 * 2026-07-10 迁移：upstream（shawnlu96/claudestra v2.6→v2.9）自带了多前端
 * 解耦（docs/web-frontend-guide.md），旧 fork 的 /web/* 网关全部让位：
 *   - 收发消息  → POST /api/v1/agents/:name/messages（Bearer token）
 *   - 实时流    → GET  /api/v1/events（SSE，BFF 翻译成 WebStreamEvent）
 *   - 历史      → GET  /api/v1/agents/:name/history[/:sessionId]（live+归档）
 *   - 交互回传  → POST /api/v1/agents/:name/{interrupt,answer}（fork additive 端点）
 *   - 生命周期  → POST /api/v1/agents[/:name/{kill,restart}]（fork additive 端点）
 *
 * Token 由 CLI 签发：`bun src/manager.ts token-add web-ui --agents '*,master' --force`
 * → 写入 web/.env.local 的 CLAUDESTRA_API_TOKEN。BFF 在 server 端带
 * Authorization: Bearer 调 Bridge（127.0.0.1），浏览器永不直连 3847，
 * 也绕开了 EventSource 不能带 header 的坑（guide §4.3）。
 */

export const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://127.0.0.1:3847";

const TOKEN = process.env.CLAUDESTRA_API_TOKEN || "";

/** 大总管的前端保留名 ↔ API 的 "master"。 */
export const MASTER_AGENT_NAME = "__master__";

/** 前端会话名 → /api/v1 的 agent 名（__master__ → master，其余原样）。 */
export function apiAgentName(agent: string): string {
  return agent === MASTER_AGENT_NAME ? "master" : agent;
}

export function bridgeAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

/** GET /api/v1<path>，返回解析后的 JSON（非 2xx 时抛错，message 带 Bridge 的 error）。 */
export async function bridgeGet<T = Record<string, unknown>>(
  path: string,
  opts?: { timeoutMs?: number }
): Promise<T> {
  const res = await fetch(`${BRIDGE}/api/v1${path}`, {
    headers: bridgeAuthHeaders(),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; retryable?: boolean };
  if (!res.ok) {
    // 状态码/可重试标记随 Error 带出去——上层要靠它区分「真离线」和「链路重连中」
    // （全转成 502 的话，前端只能一律显示"发送失败"）。
    const err = new Error(json.error || `Bridge ${res.status}`) as Error & {
      status?: number;
      retryable?: boolean;
    };
    err.status = res.status;
    err.retryable = json.retryable === true;
    throw err;
  }
  return json;
}

/** POST /api/v1<path>（JSON body），语义同 bridgeGet。 */
export async function bridgePost<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number; method?: "POST" | "PUT" }
): Promise<T> {
  const res = await fetch(`${BRIDGE}/api/v1${path}`, {
    method: opts?.method ?? "POST",
    headers: { "Content-Type": "application/json", ...bridgeAuthHeaders() },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; retryable?: boolean };
  if (!res.ok) {
    // 状态码/可重试标记随 Error 带出去——上层要靠它区分「真离线」和「链路重连中」
    // （全转成 502 的话，前端只能一律显示"发送失败"）。
    const err = new Error(json.error || `Bridge ${res.status}`) as Error & {
      status?: number;
      retryable?: boolean;
    };
    err.status = res.status;
    err.retryable = json.retryable === true;
    throw err;
  }
  return json;
}
