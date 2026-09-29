/**
 * 运行时错误 → client.log（壳记 [shell]，PWA 记 [pwa]）：window 的 error / unhandledrejection 与错误兜底层（lib/error-boundary.ts）共用这一个出口。
 * 带完整 JS 栈（含列号）：生产 chunk 全在第 1 行，只记文件名 + 行号等于没记；配合 next.config 的 productionBrowserSourceMaps，
 * 用 `node scripts/resolve-stack.mjs` 还原到源码位置。5 分钟最多 8 条，防死循环类错误刷爆日志。
 */
import { postClientLog } from "@/lib/client-log";
import { isNativeShell } from "@/lib/native";

const errLogWindow: number[] = [];
/** message（和栈的每一行）截到 300 字：JSON 解析错误之类会把出错的原文片段带进来，没必要整段进日志 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);

/** kind 以 error / unhandledrejection 开头：开发者面板（features/devtools/dev-events.ts）按这个前缀标红。extra 附在栈后（组件栈） */
export function reportRuntimeError(kind: string, err: unknown, fallback: string, extra?: string) {
  const now = Date.now();
  while (errLogWindow.length && now - errLogWindow[0] > 5 * 60_000) errLogWindow.shift();
  if (errLogWindow.length >= 8) return;
  errLogWindow.push(now);
  const e = err instanceof Error ? err : null;
  // 20 帧：React 自己的 8 帧（throwIfInfiniteUpdateLoopDetected → dispatchSetState）之后才轮到我们的调用方
  const stack = (e?.stack || "").split("\n").slice(0, 20).map((l) => clip(l, 300)).join("\n"); // 栈首行也带着整条 message
  const text = `${stack} ${e?.message || fallback}`;
  // 浏览器扩展注入脚本的报错不是我们的，ResizeObserver loop 是浏览器的良性警告：都不占额度
  if (/\b(chrome|moz|safari-web)-extension:\/\//.test(text) || /ResizeObserver loop (completed|limit)/.test(text)) {
    errLogWindow.pop();
    return;
  }
  const msg = `${kind} ${clip(e?.message || fallback, 300)}${stack ? `\nstack: ${stack}` : ""}${extra ? `\n${extra}` : ""}`;
  const tag = isNativeShell() ? "[shell]" : "[pwa]";
  postClientLog(`${tag} ${msg}`);
}

/** 错误兜底层的上报：scope 标出是哪一层兜住的（root / chat / collab / sidebar / bubble），where 是气泡的消息 id；组件栈截前 12 行 */
export function reportBoundaryError(scope: string, err: Error, componentStack: string, where?: string) {
  const comp = componentStack.trim().split("\n").slice(0, 12).map((l) => l.trim()).join(" < ");
  const tag = where ? `error boundary=${scope} id=${where}` : `error boundary=${scope}`;
  reportRuntimeError(tag, err, String(err), comp ? `components: ${comp}` : undefined);
}
