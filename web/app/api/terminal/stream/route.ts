export const runtime = "nodejs";

import { apiAgentName, bridgeAuthHeaders, BRIDGE } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";

/**
 * 远程终端输出流（SSE 纯透传）。
 *
 * 代理 Bridge `GET /api/v1/agents/:name/terminal?cols=&rows=`（fork 端点，
 * 见 src/bridge/web-terminal.ts）。与 chat/stream 不同：终端帧无需翻译，
 * 直接 pipe 上游 body——Bridge 已经按 SSE 格式发帧 + 5s ping。
 *
 * 浏览器断开 → request.signal abort → 上游 fetch 中止 → Bridge 销毁 PTY
 * + viewer session（生命周期跟着这条流走，无需显式 close 端点）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return new Response("未登录", { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return new Response("missing agent", { status: 400 });
  const cols = url.searchParams.get("cols") || "100";
  const rows = url.searchParams.get("rows") || "30";

  let upstream: Response;
  try {
    upstream = await fetch(
      `${BRIDGE}/api/v1/agents/${encodeURIComponent(apiAgentName(agent))}/terminal?cols=${encodeURIComponent(cols)}&rows=${encodeURIComponent(rows)}`,
      {
        headers: { ...bridgeAuthHeaders(), Accept: "text/event-stream" },
        signal: request.signal,
      }
    );
  } catch (e) {
    return new Response(`${await st("Bridge 不可达", "Bridge unreachable")}: ${(e as Error).message}`, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    let msg = `${await st("Bridge 终端不可用", "Bridge terminal unavailable")} (${upstream.status})`;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    return new Response(msg, { status: upstream.status === 404 ? 404 : 502 });
  }

  // ⚠ 不要直接 `new Response(upstream.body)` 纯透传：客户端 abort 时 Next 对
  // 透传 body 的取消传导不可靠（dev 双 effect 实测漏了一条流→Bridge 僵尸 PTY）。
  // 手动泵流 + 显式监听 request.signal，保证断开必然传导到上游。
  const upstreamBody = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const onAbort = () => reader.cancel().catch(() => {});
      request.signal.addEventListener("abort", onAbort);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        /* 客户端断开（enqueue 抛错）或上游断（Bridge 重启）*/
        reader.cancel().catch(() => {});
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // 消费端取消（客户端断开的另一条路径）→ 显式掐上游
      upstreamBody.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
