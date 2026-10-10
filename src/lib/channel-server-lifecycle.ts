/**
 * channel-server 的「Claude Code 那头没了」探测（CSO-1）。
 *
 * SDK 的 StdioServerTransport 只听 stdin 的 data / error，EOF 不会触发 onclose；而连上 bridge 后
 * ws 与退避定时器让事件循环常驻，父进程退了也不会自己结束 → ppid=1 孤儿。两条探测都汇到调用方
 * 传进来的 onGone（channel-server 里是 mcp.close() → 唯一的正当退出 mcp.onclose）。
 * 测试：tests/channel-server-lifecycle.test.ts。
 */
import { codexParentGone, isPidAlive } from "./codex-thread.js";

/** stdin 读到 EOF / 被关 = 客户端断开了 stdio */
export function watchStdinEnd(stdin: NodeJS.ReadableStream, onGone: () => void): void {
  let fired = false;
  const once = () => { if (!fired) { fired = true; onGone(); } };
  stdin.once("end", once);
  stdin.once("close", once);
}

/**
 * 父进程被强杀、而 stdin 写端还被别的进程（孙进程继承等）拿着时收不到 EOF，只能盯父进程。
 * 判据同 codexParentGone：起来时的父进程死了或 ppid 变了。定时器 unref，不拖住正常退出。
 */
export function watchParentGone(onGone: (parent: number) => void, intervalMs = 2000): void {
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (!codexParentGone(parent, process.ppid, isPidAlive)) return;
    clearInterval(timer);
    onGone(parent);
  }, intervalMs);
  timer.unref?.();
}
