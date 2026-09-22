/**
 * 优雅退出一个会话窗口：清场 → 键入退出指令 → 处理收尾弹窗 → 最后强杀。
 *
 * 从 manager.gracefulExit 原样搬到 WindowOps 之上（P3c）：manager 与端到端脚本走的是
 * 同一段代码，端到端验证的就是生产路径。CC / Pi 的按键序列与时序逐字节不变——
 * win.capture / sendKey / sendEscape 就是 manager 原先直接调的 tmuxCapture /
 * tmuxRaw send-keys / tmuxSendEscape。
 *
 * 清场（阶段 1+2）可由适配器的 exitPrelude 接管：Codex 连按 Esc 是 backtrack 回溯手势，
 * 默认序列会把 "/quit" 的 q 喂给回溯遮罩、剩下的 "uit" 当成一轮用户消息发给模型。
 */
import { isAtShell } from "../tmux-helper.js";
import type { ManagedRuntimeAdapter, WindowOps } from "./types.js";

/** 默认清场：interruptKeys 连发 3 轮确保停下当前操作，再一次守卫 Esc 清菜单 / 弹窗 */
async function defaultExitPrelude(win: WindowOps, adapter: ManagedRuntimeAdapter): Promise<"at-shell" | "continue"> {
  for (let i = 0; i < 3; i++) {
    for (const key of adapter.control.interruptKeys) await win.sendKey(key);
    await win.sleep(800);
    const pane = await win.capture(5);
    if (isAtShell(pane)) return "at-shell";
    // 如果出现了 ❯ 提示符（Claude Code 空闲），可以继续退出
    if (/❯/.test(pane.split("\n").slice(-5).join("\n"))) break;
  }
  // 发 Escape 清除任何菜单/弹窗（走双击护栏：连发两个 Esc = CC 的 Rewind 手势）
  await win.sendEscape();
  await win.sleep(500);
  return "continue";
}

export async function gracefulExitWindow(win: WindowOps, adapter: ManagedRuntimeAdapter): Promise<boolean> {
  // 阶段 1+2: 清场（适配器可接管）
  const prelude = adapter.exitPrelude ? await adapter.exitPrelude(win) : await defaultExitPrelude(win, adapter);
  if (prelude === "at-shell") return true;

  // 阶段 3: 发退出命令
  await win.sendLiteral(adapter.exitCommand);
  await win.sleep(100);
  await win.sendKey("Enter");

  // 阶段 4: 轮询处理收尾弹窗，最多等 30 秒（没有 onExitPane 的运行时只等回 shell）
  for (let i = 0; i < 60; i++) {
    await win.sleep(500);
    const pane = await win.capture(10);
    if (isAtShell(pane)) return true;
    await adapter.onExitPane?.(pane, win);
  }

  // 阶段 5: 最后手段 — 强制杀进程
  const finalPane = await win.capture(5);
  if (!isAtShell(finalPane)) {
    // 发 Ctrl+C 多次 + Ctrl+D
    await win.sendKey("C-c");
    await win.sleep(300);
    await win.sendKey("C-c");
    await win.sleep(300);
    await win.sendKey("C-d");
    await win.sleep(2000);
  }

  const check = await win.capture(3);
  return isAtShell(check);
}
