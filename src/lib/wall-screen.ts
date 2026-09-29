/**
 * 直接往 CC 的 TUI 打字的路径（cron 打到现存 agent、Web / Discord 斜杠直通、自动 /save-compact）打字前先看一眼：窗口停在额度菜单
 * 或撞墙后的自动续跑倒计时上就不打——倒计时上一打字就取消 CC 排好的自动续跑，菜单上回车会选中高亮项（可能是「Switch to usage
 * credits」）。T24 的规矩：这种画面一个键都不发。抓不到屏返回 null（不拦，交给调用方原来的逻辑）。
 */
import { wallWaitKind } from "./quota-wall-text.js";
import { tmuxCapture } from "./tmux-helper.js";

export type WallWait = "menu" | "countdown";

export async function windowWallWait(win: string): Promise<WallWait | null> {
  return wallWaitKind(await tmuxCapture(win, 30).catch(() => "")); // 抓不到：认不出，按调用方原来的逻辑走
}

/** 拒绝打字时给人 / 调用方看的原因。额度状态只告诉 owner（canSeeQuota）：别人只知道「现在收不了」 */
export const wallWaitRefusal = (kind: WallWait, canSeeQuota = true): string =>
  !canSeeQuota ? "此刻不能接收命令（窗口在等待画面上，没发任何键），稍后再试"
    : kind === "menu" ? "它停在额度菜单上，没发任何键（菜单里有花钱的选项）" : "它停在撞墙后的自动续跑倒计时上，没发任何键（一打字就会取消 CC 的自动续跑）";
