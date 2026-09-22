/**
 * Codex 的退出清场（graceful-exit.ts 的 exitPrelude / onExitPane）。
 *
 * 为什么不能用默认序列（interruptKeys ×3 + 守卫 Esc）：Codex 的 Esc 连按是 backtrack 手势——
 * 空闲时第一下出「esc again to edit previous message」，第二下打开历史回溯遮罩
 * （「q to quit … enter to edit message」），再按就往前翻旧消息。随后键入的 "/quit" 里 q 关掉
 * 遮罩、剩下的 "uit" + Enter 被当成一轮用户消息发给模型（2026-09-23 审查在 0.153.4 实测复现：
 * 模型真的回了一句，Codex 没退出，30s 后才被强杀兜底）；时序再差一点，Enter 落在遮罩上就是
 * 「编辑并重发旧消息」，直接改写对话。
 *
 * 所以这里的规矩：**绝不连发 Esc**。回合在跑才发一次 Esc 打断，遮罩开着就按 q 关掉，
 * 其余什么都不按，直接交给 /quit。
 */
import { isAtShell } from "../tmux-helper.js";
import type { WindowOps } from "./types.js";

/** 回合进行中的状态行：「• Working (12s • esc to interrupt)」 */
export const CODEX_BUSY_RE = /esc to interrupt/i;
/** 历史回溯遮罩的底部提示（注意与「esc again to edit previous message」区分：那条不含 "edit message"） */
export const CODEX_BACKTRACK_OVERLAY_RE = /to edit message/i;

/** 状态行与遮罩提示都画在最底部；只看末尾几行，历史里提到这些字样的不算 */
const tailOf = (pane: string, n = 8) => pane.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

export const codexBusy = (pane: string): boolean => CODEX_BUSY_RE.test(tailOf(pane));
export const codexOverlayOpen = (pane: string): boolean => CODEX_BACKTRACK_OVERLAY_RE.test(tailOf(pane));

/** 打断后等回合真正停下的上限（等不到也继续：/quit 在忙时同样会被处理） */
const SETTLE_ROUNDS = 20;
const SETTLE_POLL_MS = 500;

export async function codexExitPrelude(win: WindowOps): Promise<"at-shell" | "continue"> {
  let pane = await win.capture(40);
  if (isAtShell(tailOf(pane, 5))) return "at-shell";
  if (codexOverlayOpen(pane)) {
    await win.sendLiteral("q"); // 关遮罩；Enter 在这里 = 编辑并重发旧消息，绝不能按
    await win.sleep(500);
    pane = await win.capture(40);
  }
  if (!codexBusy(pane)) return "continue";
  await win.sendEscape(); // 只发一次
  for (let i = 0; i < SETTLE_ROUNDS; i++) {
    await win.sleep(SETTLE_POLL_MS);
    pane = await win.capture(40);
    if (isAtShell(tailOf(pane, 5))) return "at-shell";
    if (!codexBusy(pane)) break;
  }
  return "continue";
}

/**
 * /quit 发出后的兜底：万一遮罩还是开着（别的入口刚发过 Esc），只按 q 关掉它、不补 Enter——
 * 退不出去就让 graceful-exit 的强杀兜底（空闲 Codex 收到 C-c 本来就会退出）。
 */
const overlayClosedOnce = new WeakSet<WindowOps>();
export async function codexOnExitPane(pane: string, win: WindowOps): Promise<"handled" | "none"> {
  // 每次退出（一个 WindowOps）最多按一次：误认的话也只多一个 q，不会每 500ms 往输入框里灌
  if (overlayClosedOnce.has(win) || !codexOverlayOpen(pane)) return "none";
  overlayClosedOnce.add(win);
  await win.sendLiteral("q");
  return "handled";
}
