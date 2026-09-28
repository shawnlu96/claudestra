/**
 * 非图片附件点开后怎么处理（纯逻辑，tests/web-attachment-open.test.ts）：
 * - 文本类在应用内预览（features/chat/components/attachment-preview.tsx）：iOS 壳不处理 WKDownload，下载那条路在手机上点了没反应；
 * - 其他类型在手机 / 壳里交给系统分享面板（能「用其他应用打开」「存储到文件」），桌面浏览器照旧下载。
 * html 按源码显示，绝不渲染；svg 走图片那条路（lib/chat/attachments.ts 的 IMG_EXT），不算文本。
 */

export type TextFlavor = "markdown" | "plain";
export type OpenMode = "preview" | "share" | "download";

const MD_EXT = new Set(["md", "markdown", "mdx"]);
const TEXT_EXT = new Set([
  "txt", "log", "json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml", "toml", "xml", "ini", "conf", "cfg", "env",
  "sh", "bash", "zsh", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift", "kt", "java", "c", "h",
  "cpp", "hpp", "cs", "php", "sql", "css", "scss", "html", "htm", "diff", "patch", "srt", "vtt", "tex", "rst", "org",
]);
/** MIME 不带 text/ 前缀、但确实是文本的几类（附件名没扩展名时靠取回来的 blob.type 判） */
const TEXT_MIME = /^(text\/|application\/(json|x-ndjson|xml|x-yaml|yaml|toml|x-sh|javascript|x-javascript|sql)\b)/;

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** 是文本类就给出渲染方式（md 用 domd，其余等宽），不是返回 null。先看扩展名，没认出来再看 MIME */
export function textFlavor(name: string, mime = ""): TextFlavor | null {
  const ext = extOf(name);
  if (MD_EXT.has(ext)) return "markdown";
  if (TEXT_EXT.has(ext)) return "plain";
  const m = mime.toLowerCase();
  if (m.startsWith("text/markdown")) return "markdown";
  return TEXT_MIME.test(m) ? "plain" : null;
}

/** 手机 / 壳里走系统分享（真正能不能分享文件，到时再用 navigator.canShare 判，不行退回下载） */
export function openMode(name: string, mime: string, env: { mobile: boolean }): OpenMode {
  if (textFlavor(name, mime)) return "preview";
  return env.mobile ? "share" : "download";
}

/** 预览只渲染开头这么多字节：md 整段交给 domd 解析，几 MB 的日志在手机上会卡死 */
export const PREVIEW_LIMIT = 1 << 20;

/**
 * 按 UTF-8 字节数截开头：不切断多字节字符和代理对（中文一个字 3 字节，按字符数截会超出三倍）。
 * truncated = 原文超过上限、显示的只是开头；复制 / 分享仍用全文。
 */
export function clipPreview(text: string, limit = PREVIEW_LIMIT): { shown: string; truncated: boolean } {
  if (text.length * 3 <= limit) return { shown: text, truncated: false }; // 最坏每个 UTF-16 单元 3 字节，肯定放得下
  let head = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1); // 截在代理对中间：半个字编码出来是 U+FFFD，丢掉
  const { read } = new TextEncoder().encodeInto(head, new Uint8Array(limit));
  if (read >= text.length) return { shown: text, truncated: false };
  return { shown: head.slice(0, read), truncated: true };
}
