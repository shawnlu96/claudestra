/**
 * 前端 → 服务端 client.log 的唯一打点出口（fire-and-forget，D8-11）。
 *
 * 落到 ~/.claude-orchestrator/web/client.log——iOS 上看不到 console，「收不到消息」
 * 「点了没反应」这类事故只能对这份时间线取证。以前 chat-store / chat.tsx×3 / boot-report
 * 各抄一份同样的 fetch，这里收成一份；调用方自己加 [shell]/[pwa] 之类的前缀。
 *
 * 例外：layout.tsx 的内联脚本在 React 之前跑、是一段字符串，import 不了，保留它自己那份
 * （带 keepalive）。
 */
export function postClientLog(msg: string): void {
  try {
    void fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg }),
    }).catch(() => {});
  } catch {
    /* 不影响主流程 */
  }
}
