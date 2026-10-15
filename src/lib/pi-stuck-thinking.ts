/**
 * Pi 的事件态卡在 thinking、画面却明确空闲：以画面为准（turn-state 的 thinking 分支调用）。
 * 起因：Pi 逐个 await 扩展的 agent_settled 处理函数，排在前面的扩展不返回，我们的 Stop 就发不出去，押后消息一直投不进。
 * 画面判据用 piPaneIdleVerdict（🔗 状态行是我们自己写的、忙碌指示器是内嵌文字的横线）；认不出画面 = 不算空闲。
 * 单测 tests/turn-state-pi-stuck.test.ts。
 */
import { piPaneIdleVerdict } from "./tmux-helper.js";

/**
 * Pi 在跑时忙碌横线一直在，工具调用之间的停顿是秒级；但回合刚开始、横线还没画出来的那一拍要扛住。
 * 2 分钟：远大于正常停顿，又远小于押后消息 30 分钟才报排队的告警（加上每分钟一次的扫描，约 3 分钟内投出）。
 */
export const PI_STUCK_THINKING_QUIET_MS = 2 * 60_000;

/** 画面明确是我们的 Pi 窗口而且空闲 */
export const piPaneClearlyIdle = (pane: string | null | undefined): boolean => !!pane?.trim() && piPaneIdleVerdict(pane) === "idle";

export function piStuckThinkingIdle(i: { pane: string | null; paneAgain?: string | null; quietMs?: number }): boolean {
  return piPaneClearlyIdle(i.pane) && piPaneClearlyIdle(i.paneAgain) && (i.quietMs ?? 0) >= PI_STUCK_THINKING_QUIET_MS;
}
