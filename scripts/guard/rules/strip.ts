// 去注释的共用小工具（粗粒度：不理解字符串里的 `//`，但保留 `://` 这种 URL）。

/** 把块注释替换成等长空白（保留换行，行号不变），再去掉行注释。 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** 去注释 + 去空行 + 每行 trim：twin 比对的底座。 */
export function codeLines(src: string): string[] {
  return stripComments(src)
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}
