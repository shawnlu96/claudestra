// 粗粒度 JS/TS 词法遮罩：字符串 / 模板字面量的文字部分 / 正则字面量的内容换成 "_"，换行、长度、下标都不变。
// 注释默认原样保留（catch 规则要读注释），blankComments 时换成空格。deps 与 catch 规则在遮罩后的文本上匹配，
// 这样 fixture 字符串里的 `import … from "x"`、`"catch {}"` 不会被当成真代码；import 路径按下标回原文切片。
// 已知粗糙处：JSX 文本里的撇号会把本行余下部分当字符串（只影响本行）。

const REGEX_AFTER_CHAR = new Set([..."(,=:[!&|?{;+-*%~^"]);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|instanceof|new|throw)$/;

/** `/` 在这里开始的是正则字面量（而不是除号）吗：看它前面最后一个有意义的字符。 */
function regexCanStart(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  const ch = src[k];
  if (REGEX_AFTER_CHAR.has(ch)) return true;
  if (ch === ">") return src[k - 1] === "=";
  return REGEX_AFTER_WORD.test(src.slice(Math.max(0, k - 11), k + 1));
}

export function maskStrings(src: string, blankComments = false): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number, fill = "_") => {
    for (let k = a; k < Math.min(b, n); k++) if (out[k] !== "\n") out[k] = fill;
  };

  /** 单行字符串 / 正则：到同一种结束符或行尾为止，返回结束符之后的下标。 */
  const scanLine = (i: number, close: string, regex: boolean): number => {
    let j = i + 1;
    let inClass = false;
    while (j < n && src[j] !== "\n") {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === close && !inClass) break;
      if (regex && (c === "[" || c === "]")) inClass = c === "[";
      j++;
    }
    blank(i + 1, j);
    return j + 1;
  };

  /** 代码段：从 i 扫到文件尾，或（depth 模式下）扫到与之配对的 `}`，返回其后的下标。 */
  const scanCode = (i: number, untilBrace: boolean): number => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && (d === "/" || d === "*")) {
        const e = d === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
        const end = e < 0 ? n : d === "/" ? e : e + 2;
        if (blankComments) blank(i, end, " ");
        i = end;
      } else if (c === '"' || c === "'") i = scanLine(i, c, false);
      else if (c === "`") i = scanTemplate(i);
      else if (c === "/" && regexCanStart(src, i)) i = scanLine(i, "/", true);
      else {
        if (untilBrace && c === "{") depth++;
        if (untilBrace && c === "}" && depth-- === 0) return i + 1;
        i++;
      }
    }
    return n;
  };

  /** 模板字面量：文字部分遮罩，`${…}` 里是代码，递归处理。 */
  const scanTemplate = (i: number): number => {
    let j = i + 1;
    let litStart = j;
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "{") {
        blank(litStart, j);
        j = scanCode(j + 2, true);
        litStart = j;
      } else j++;
    }
    blank(litStart, j);
    return j + 1;
  };

  scanCode(0, false);
  return out.join("");
}
