/**
 * Codex 选择菜单在不在屏上（T63 护栏）。菜单画在底部，页脚是「Press enter to confirm or esc to go back / cancel」；这时回车会选中
 * 光标所在项（额度提醒里第 1 项就是「Switch to gpt-5.6-luna」），Esc 是返回，数字 / 方向键是换选项——程序化的路径一个键都不能发。
 * 判定比 auq-pane 的 parseCodexSelectPane 宽：只看末尾几行有没有页脚。parsed = AUQ 认得出选项（会出选择卡，owner 点哪个发哪个），
 * unparsed = 认不出（没有选择卡，由 runtime-dialogs 兜底出运行时卡）。只该对 Codex 窗口用：调用方先确认 runtime。tests/codex-menu.test.ts。
 */
import { CODEX_FOOTER_RE, parseCodexSelectPane } from "./auq-pane.js";
import { nonEmptyTail } from "./runtimes/codex-ready.js";

/** 页脚要在末尾这么多个非空行里：更早的是历史输出（Codex resume 回放、agent 自己在讲这个菜单） */
const MENU_TAIL_LINES = 6;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export type CodexMenuState = "none" | "parsed" | "unparsed";

export function codexMenuState(pane: string): CodexMenuState {
  const plain = pane.replace(ANSI_RE, "");
  if (!nonEmptyTail(plain, MENU_TAIL_LINES).some((l) => CODEX_FOOTER_RE.test(l))) return "none";
  return parseCodexSelectPane(plain) ? "parsed" : "unparsed";
}

export const codexMenuShown = (pane: string): boolean => codexMenuState(pane) !== "none";

/** 拒绝注入 / 打断时给人看的话（owner 在卡上点选项，或者自己到终端里处理） */
export const CODEX_MENU_REFUSAL = "它停在 Codex 的选择菜单上，没发任何键（回车会选中菜单项）；先在卡上或终端里处理菜单";
