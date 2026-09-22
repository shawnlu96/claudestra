/**
 * auto 权限模式「临时放行」按钮的 id 编解码（纯函数）。
 *
 * auto 不再是启动模式（启动路径把它归一成 bypass），但非 bypass 启动的 agent 仍可能在
 * TUI 里被人 Shift+Tab 切进 auto——被 auto 分类器拦下时这条放行链是现役功能。
 *
 * 为什么要把原模式编进 revert 按钮：原先「切回」写死切到 "auto"，放行前若不在 auto
 * （比如 plan / acceptEdits），点「切回」反而把 agent 切进了 auto。现在放行时记下切换前
 * 的模式，切回就回到那个模式；老消息上不带模式的按钮仍按 auto 处理（兼容）。
 */
import { PERMISSION_MODE_CYCLE } from "../lib/tmux-helper.js";

export interface AutoPermButton {
  isAllow: boolean;
  channelId: string;
  /** 这次点击要切到的权限模式 */
  target: string;
}

const ALLOW = "auto_allow:";
const REVERT = "auto_revert:";

export function isAutoPermButton(id: string): boolean {
  return id.startsWith(ALLOW) || id.startsWith(REVERT);
}

export function parseAutoPermButton(id: string): AutoPermButton | null {
  if (id.startsWith(ALLOW)) {
    return { isAllow: true, channelId: id.slice(ALLOW.length), target: "bypassPermissions" };
  }
  if (id.startsWith(REVERT)) {
    const [channelId, prev] = id.slice(REVERT.length).split(":");
    const known = (PERMISSION_MODE_CYCLE as readonly string[]).includes(prev ?? "");
    return { isAllow: false, channelId, target: known ? prev : "auto" };
  }
  return null;
}

/** 放行后挂的「切回」按钮 id：带上切换前的模式 */
export function autoRevertButtonId(channelId: string, prevMode: string): string {
  return `${REVERT}${channelId}:${prevMode}`;
}
