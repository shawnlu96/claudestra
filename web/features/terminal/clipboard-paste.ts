/** 「粘贴」键的结果：ok 已送进终端；其余各给一句提示 */
export type PasteOutcome = "ok" | "empty" | "blocked" | "multiline";

/** xterm Terminal 里用到的那一小块（结构类型：根 tsconfig 不带 DOM lib，测试直接传假的） */
interface PasteTarget {
  paste(text: string): void;
  readonly modes: { readonly bracketedPasteMode: boolean };
}

/**
 * 读剪贴板 → term.paste（按终端是否开了 bracketed paste 决定包不包 \e[200~…\e[201~，换行规整成 \r）。
 * readText 必须在点击手势的同一 task 里发起（iOS 靠它弹系统「粘贴」确认），所以调用前不能有 await。
 * 不补回车：末尾换行先剥掉；bracketed 没开时中间的换行就是真回车（会逐行执行），这种内容不发。
 */
export async function pasteFromClipboard(clipboard: { readText(): Promise<string> } | undefined, term: PasteTarget): Promise<PasteOutcome> {
  if (!clipboard?.readText) return "blocked"; // 明文 http（非安全上下文）没有 clipboard API
  let raw: string;
  try {
    raw = await clipboard.readText();
  } catch {
    return "blocked"; // 用户点了「不允许」或浏览器策略拒绝：调用方给提示，不是程序错误
  }
  const text = raw.replace(/[\r\n]+$/, "");
  if (!text) return "empty";
  if (/[\r\n]/.test(text) && !term.modes.bracketedPasteMode) return "multiline";
  term.paste(text);
  return "ok";
}
