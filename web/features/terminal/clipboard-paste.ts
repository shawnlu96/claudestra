/** 「粘贴」键的结果：ok 已送进终端；empty / blocked 各给一句提示 */
export type PasteOutcome = "ok" | "empty" | "blocked";

/**
 * 读剪贴板 → paste（传 xterm 的 term.paste：按终端是否开了 bracketed paste 决定包不包 \e[200~…\e[201~，
 * 换行规整成 \r，与桌面 Cmd+V 同一条路）。readText 必须在点击手势的同一 task 里发起（iOS 靠它弹系统
 * 「粘贴」确认），所以调用前不能有 await。不补回车：命令落进输入行，用户看过再按 ⏎。
 */
export async function pasteFromClipboard(
  clipboard: { readText(): Promise<string> } | undefined, // 结构类型：根 tsconfig 不带 DOM lib，测试也直接传假的
  paste: (text: string) => void
): Promise<PasteOutcome> {
  if (!clipboard?.readText) return "blocked"; // 明文 http（非安全上下文）没有 clipboard API
  let text: string;
  try {
    text = await clipboard.readText();
  } catch {
    return "blocked"; // 用户点了「不允许」或浏览器策略拒绝：调用方给提示，不是程序错误
  }
  if (!text) return "empty";
  paste(text);
  return "ok";
}
