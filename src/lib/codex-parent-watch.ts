/** Codex 父进程消失时退出 MCP；孤儿不能继续争抢同一频道。 */
import { codexParentGone, isPidAlive } from "./codex-thread.js";
export function watchCodexParent(close: () => void, log: (s: string) => void): void {
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (!codexParentGone(parent, process.ppid, isPidAlive)) return;
    log(`👋 Codex 父进程 ${parent} 已退出，channel-server 随之退出`);
    close();
  }, 2_000);
  timer.unref();
}
