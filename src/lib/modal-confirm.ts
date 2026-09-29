/**
 * launcher / 就绪轮询自动按 Enter 的判据（纯函数）。单测 tests/modal-confirm.test.ts、tests/modal-parser.test.ts、tests/limit-menu.test.ts。
 * 「底部有带 ❯ 的编号项」也可能是输入框里的多行编号草稿（tests/fixtures/turn-zone/cc-numlist-draft.txt）：所以先按框形状认输入框
 * （lib/input-box.ts，和押后 / 抢占同一套），真输入框还在 = 没有弹窗盖着，一个键都不按。
 * 切模型 / effort 确认框也不按：launcher、就绪轮询都不是注入方，核对不了框里的目标（tests/modal-confirm.test.ts）。
 */
import { parseAuqPane } from "./auq-pane.js";
import { paneShowsLimitMenu } from "./limit-menu.js";
import {
  detectBypassConsentPrompt,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  detectSwitchConfirmPrompt,
  parseChoicePrompt,
  parseModalOptions,
  trustPromptMoves,
} from "./tmux-helper.js";
import { inputBox } from "./input-box.js";

/**
 * pane 上是否有「可以安全自动按 Enter 确认」的 modal：parseModalOptions 几何识别（❯ 标记的选项菜单），再按负向黑名单排除必须人决定的——
 * 运行时权限弹窗、AskUserQuestion、session-idle（除非 allowSessionIdle：master 启动时允许，agent 由 permission-watcher 发按钮）、信任 / Bypass 首启框、额度菜单。
 * CC 改启动期 modal 文案（dev-channel / trust files …）也不会让 launcher 卡住：❯ + Enter to confirm 的几何特征还在就自动通过。
 */
export function isAutoConfirmableModal(
  pane: string,
  opts: { allowSessionIdle?: boolean } = {}
): boolean {
  // 弹窗会盖住输入框；输入框还在，画面上的「❯ 1.」就是草稿或对话内容，按 Enter 会把 owner 没打完的草稿提交掉
  if (inputBox(pane.replace(/\s+$/, "").split("\n"))) return false;
  const modalOpts = parseModalOptions(pane);
  // v2.23.1+ 无编号选择弹窗（effort 默认档位确认等）也算：默认高亮项 = 保持现状，Enter 无副作用
  const choice = modalOpts ? null : parseChoicePrompt(pane);
  if (!modalOpts && !choice) return false;
  // 两个解析器都保证恰有 ❯ 高亮项，但显式再校验一次，防未来重构破坏不变量
  if (modalOpts && !modalOpts.some((o) => o.selected)) return false;
  if (choice && !choice.some((o) => o.selected)) return false;
  // 运行时权限弹窗（Do you want to edit / run / allow ...）必须用户决定
  if (detectRuntimePermissionPrompt(pane)) return false;
  // AskUserQuestion 是 agent 在问人：Enter 等于替人选了高亮的第 1 项
  if (parseAuqPane(pane)) return false;
  // session-idle 弹窗除非显式允许
  if (!opts.allowSessionIdle && detectSessionIdlePrompt(pane)) return false;
  // 目录信任弹窗默认高亮「No, exit」——直接 Enter 等于退出。它由 trustPromptMoves
  // 专门处理（先 Down 到 Yes 再 Enter），这里绝不能当普通弹窗自动 Enter
  if (trustPromptMoves(pane) !== null) return false;
  // Bypass 首启确认同样默认高亮「No, exit」，而且接受与否是用户自己的安全决定——
  // 任何自动化都不替用户按（setup 里征得同意后写 skipDangerousModePermissionPrompt）
  if (detectBypassConsentPrompt(pane)) return false;
  // 额度菜单：Enter 会替人选中高亮项（光标可能停在「Switch to usage credits」上），一个键都不发，留给人（T24）
  if (paneShowsLimitMenu(pane)) return false;
  // 切模型 / effort 确认框：CC 会主动弹同款框提议降级，这里看不出是谁引出的——只有注入方核对过目标才按（runSwitchCommand）
  if (looksLikeSwitchConfirm(pane)) return false;
  return true;
}

/** 黑名单宁宽勿窄：严格识别之外，底部出现框标题或「N. Yes, switch to …」选项也算（CC 改了框的排版也不会漏成自动 Enter） */
export function looksLikeSwitchConfirm(pane: string): boolean {
  if (detectSwitchConfirmPrompt(pane)) return true;
  const tail = pane.split("\n").map((l) => l.trim()).filter(Boolean).slice(-12);
  return tail.some((l) => l === "Switch model?" || l === "Change effort level?" || /^(❯\s*)?\d{1,2}\.\s+Yes, switch to\b/i.test(l));
}
