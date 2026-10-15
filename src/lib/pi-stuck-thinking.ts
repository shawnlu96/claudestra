/**
 * Pi 的事件态卡在 thinking、画面却明确空闲：以画面为准（turn-state 的 thinking 分支调用）。
 * 起因：Pi 逐个 await 扩展的 agent_settled 处理函数，排在前面的扩展不返回，我们的 Stop 就发不出去，押后消息一直投不进。
 * 画面判据比 piPaneIdleVerdict 严：那条只看尾部有没有 🔗、尾部 15 行有没有忙碌横线，残缺画面也会判 idle；
 * 这里是放行押后消息的依据，认不出完整的 Pi 布局就不算空闲。单测 tests/turn-state-pi-stuck.test.ts。
 */
import { trimTrailingBlank } from "./pane-tail.js";
import { PI_STATUS_RE } from "./tmux-helper.js";

/**
 * Pi 在跑时忙碌横线一直在，工具调用之间的停顿是秒级；但回合刚开始、横线还没画出来的那一拍要扛住。
 * 2 分钟：远大于正常停顿，又远小于押后消息 30 分钟才报排队的告警（加上每分钟一次的扫描，约 3 分钟内投出）。
 */
export const PI_STUCK_THINKING_QUIET_MS = 2 * 60_000;

/** 输入框上下边框：整行纯横线（实抓 52~222 列） */
const RULE_RE = /^─{10,}$/;
/** 以横线开头的行：纯横线、忙碌横线，或窄窗口里被裁掉尾巴的忙碌横线 */
const DASH_LEAD_RE = /^─{2,}/;
/** 输入框下边框以下的页脚行数上限（实抓 3~4 行：pi-lens / 路径 / 用量 / 状态行） */
const FOOTER_MAX = 6;
/** 两条边框之间的输入行上限：草稿再长就不认，宁可不兜底 */
const EDITOR_MAX = 12;

/**
 * 画面明确是我们的 Pi 窗口而且空闲。Pi 的忙碌指示器就画在输入框上边框的位置（`── ⠧ Working ───`，空闲时是纯横线），
 * 所以要正向确认上边框本身是纯横线，不拿「没看到忙碌横线」当证据：
 * - 最后一条纯横线 = 输入框下边框；它以下是页脚，不超过 FOOTER_MAX 行且含我们的 🔗 / ⚠️ bridge 状态行；
 * - 下边框往上最近一条以横线开头的行 = 上边框，必须在 EDITOR_MAX 行内、本身是纯横线（被裁短的忙碌横线也以横线开头）；
 * - 整屏任何以横线开头却不是纯横线的行（忙碌横线、窄窗口裁掉一截的忙碌横线）都按忙——方向是不兜底，可以接受。
 */
export function piPaneClearlyIdle(pane: string | null | undefined): boolean {
  if (!pane?.trim()) return false;
  const lines = trimTrailingBlank(pane.split("\n")).map((l) => l.trim());
  if (lines.some((l) => DASH_LEAD_RE.test(l) && !RULE_RE.test(l))) return false;
  const bottom = lines.findLastIndex((l) => RULE_RE.test(l));
  const footer = lines.slice(bottom + 1);
  if (bottom < 1 || footer.length > FOOTER_MAX || !footer.some((l) => PI_STATUS_RE.test(l))) return false;
  const top = lines.slice(0, bottom).findLastIndex((l) => DASH_LEAD_RE.test(l));
  return top >= 0 && bottom - top - 1 <= EDITOR_MAX && RULE_RE.test(lines[top]);
}

export function piStuckThinkingIdle(i: { pane: string | null; paneAgain?: string | null; quietMs?: number }): boolean {
  return piPaneClearlyIdle(i.pane) && piPaneClearlyIdle(i.paneAgain) && (i.quietMs ?? 0) >= PI_STUCK_THINKING_QUIET_MS;
}
