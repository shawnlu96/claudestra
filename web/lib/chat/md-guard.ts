/**
 * markdown 渲染的护栏（tests/web-md-guard.test.ts）：聊天消息与附件预览共用（components/domd）。
 * - mdTooHeavy：do-md 的行内解析按「段」（空行分隔）算，段内定界符一多耗时急剧上涨、还会栈溢出，与总大小关系不大。
 *   实测（headless chromium）：单段 `[` `](` 20 KB 0.56 s、50 KB 4.1 s；`*a _b ` 单段 50 KB 起栈溢出；3000 层缩进列表 1.4～2 s 且溢出。
 *   真实文档（仓库 / 台账 / 记忆 300 多份）单段定界符最多 1454、约 40 个/KB。阈值内的最坏构造 ≤ 0.43 s。
 * - 链接只放行 http / https / mailto；图片分本机附件 / 内联 / 外链 / 其他，外链点了才加载（防追踪信标）。
 */

export const MD_MAX_BYTES = 200 * 1024;
export const MD_MAX_BLOCK_DELIMS = 2000;
export const MD_MAX_TOTAL_DELIMS = 16000;
export const MD_MAX_INDENT = 80;

const DELIM = /[[\]()*_`~<!=\\]/g;
const FENCE = /^\s{0,3}(```|~~~)/;

function utf8Over(s: string, limit: number): boolean {
  if (s.length > limit) return true; // 每个 UTF-16 单元至少 1 字节
  if (s.length * 3 <= limit) return false;
  return new TextEncoder().encode(s).length > limit;
}

/** 行首缩进的列数（tab 按 4 列） */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** 交给 do-md 会卡住或栈溢出 → 调用方按纯文本显示 */
export function mdTooHeavy(md: string): boolean {
  if (utf8Over(md, MD_MAX_BYTES)) return true;
  let inFence = false;
  let block = 0;
  let total = 0;
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence; // 代码块里不做行内解析，不计数
      block = 0;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      block = 0;
      continue;
    }
    if (indentOf(line) > MD_MAX_INDENT) return true;
    const n = line.match(DELIM)?.length ?? 0;
    block += n;
    total += n;
    if (block > MD_MAX_BLOCK_DELIMS || total > MD_MAX_TOTAL_DELIMS) return true;
  }
  return false;
}

/** 链接只放行这三种协议；javascript: / data: / file: / 相对路径都按纯文本显示 */
export function safeLinkHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export type ImageSrcKind = "attachment" | "inline" | "external" | "blocked";

/** 本机附件（带凭据取）/ data: blob:（照常显示）/ http(s) 外链（点了才加载）/ 其他（只显示 alt） */
export function imageSrcKind(src: unknown): ImageSrcKind {
  if (typeof src !== "string") return "blocked";
  const s = src.trim();
  if (s.startsWith("/api/v1/attachments/")) return "attachment";
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return "inline";
  if (/^https?:\/\//i.test(s)) return "external";
  return "blocked";
}

/** 占位上显示的来源域名；解析不了给空串 */
export function imageHost(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return ""; // imageSrcKind 已判过是 http(s)，这里失败只是地址本身不合法：占位不显示域名
  }
}
