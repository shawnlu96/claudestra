/**
 * 直接往 TUI 打字 / 发键的路径（cron 打到现存 agent、Web / Discord 斜杠直通、自动 /save-compact、打断）打字前先看一眼：CC 窗口停在额度菜单
 * 或撞墙后的自动续跑倒计时上就不打——倒计时上一打字就取消 CC 排好的自动续跑，菜单上回车会选中高亮项（可能是「Switch to usage
 * credits」）；Codex 窗口停在选择菜单上也不打（回车会选中菜单项，T63，lib/codex-menu.ts）。T24 的规矩：这种画面一个键都不发。
 * 抓不到屏返回 null（不拦，交给调用方原来的逻辑）。
 */
import { CODEX_MENU_REFUSAL, codexMenuShown } from "./codex-menu.js";
import { wallWaitKind } from "./quota-wall-text.js";
import { readRegistryAgentsSync } from "./registry.js";
import { paneLooksIdle, tmuxCapture } from "./tmux-helper.js";

export type WallWait = "menu" | "countdown" | "codex_menu";

/** 画面 + 这个窗口的运行时 → 该不该拦（纯函数）。Codex 菜单只对 Codex 窗口认：CC agent 的正文里提到这句不算 */
export function wallWaitOf(pane: string, runtime: string | undefined): WallWait | null {
  if (runtime === "codex") return codexMenuShown(pane) ? "codex_menu" : null;
  return wallWaitKind(pane);
}

/** tmux 窗口目标（master:=agent-x / master:agent-x）→ registry 里的运行时；master 与认不出的按 CC */
export function runtimeOfWindow(win: string): string | undefined {
  const name = win.replace(/^[^:]*:=?/, "");
  return readRegistryAgentsSync().find((a) => a.name === name)?.runtime;
}

export async function windowWallWait(win: string, runtime: string | undefined = runtimeOfWindow(win)): Promise<WallWait | null> {
  return wallWaitOf(await tmuxCapture(win, 30).catch(() => ""), runtime); // 抓不到：认不出，按调用方原来的逻辑走
}

/** 拒绝打字时给人 / 调用方看的原因。额度状态只告诉 owner（canSeeQuota）：别人只知道「现在收不了」 */
export const wallWaitRefusal = (kind: WallWait, canSeeQuota = true): string =>
  !canSeeQuota ? "此刻不能接收命令（窗口在等待画面上，没发任何键），稍后再试"
    : kind === "codex_menu" ? CODEX_MENU_REFUSAL
    : kind === "menu" ? "它停在额度菜单上，没发任何键（菜单里有花钱的选项）" : "它停在撞墙后的自动续跑倒计时上，没发任何键（一打字就会取消 CC 的自动续跑）";

/** Web「清空会话」（api-routes /clear）能不能打 /clear：停在额度菜单 / Codex 选择菜单上一个键都不发；回合进行中也不打（会插进对话流） */
export function clearRefusal(pane: string, runtime: string | undefined): string | null {
  const wall = wallWaitOf(pane, runtime);
  if (wall) return `${wallWaitRefusal(wall)}，没有打 /clear`;
  return paneLooksIdle(pane) ? null : "agent 正在回合中，先停止（interrupt）再 clear";
}
