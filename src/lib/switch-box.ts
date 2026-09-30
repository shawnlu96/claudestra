/**
 * 「Switch model?」/「Change effort level?」确认框的宽口径识别（纯函数，不 import tmux-helper：发键闸 codex-key-guard 要用，
 * 而 tmux-helper 反过来 import 它）。这种框上回车 = 替 owner 选 Yes（bbae4e7c 真机实证：注入的 /effort 被框吞掉、框被按掉），
 * 所以宁宽勿窄：底部出现框标题独占一行、或「N. Yes, switch to …」选项就算。真输入框还在 = 没有框盖着，
 * 对话里提到框标题不算。严格识别（带目标、带按哪个键）是 tmux-helper 的 detectSwitchConfirmPrompt。单测 tests/switch-box.test.ts。
 */
import { inputBox } from "./input-box.js";

export const SWITCH_BOX_REFUSAL = "它停在切模型 / effort 确认框上，没发任何键（回车会替框选 Yes）；请到终端或网页终端里自己按";

export function switchBoxShown(pane: string): boolean {
  const lines = pane.replace(/\s+$/, "").split("\n");
  if (inputBox(lines)) return false;
  const tail = lines.map((l) => l.trim()).filter(Boolean).slice(-12);
  return tail.some((l) => l === "Switch model?" || l === "Change effort level?" || /^(❯\s*)?\d{1,2}\.\s+Yes, switch to\b/i.test(l));
}
