/**
 * 记忆索引(auto-memory 目录下的 MEMORY.md)体积检查的纯逻辑(agents-MEMIDX1):只数字节和行号,
 * 不读配置、不碰磁盘。Claude Code 每个会话都会自动注入这份索引,膨胀了每轮都多付 token;
 * 这里只负责指出超了多少、哪几行最长,文件是用户的,改不改由用户定。
 * 读配置 / 落记录在 memory-index-check-run.ts,见 docs/architecture/memory-index-check.md。
 */

/** 缺省阈值(字节)。等于阈值不算超 */
export const MEMORY_INDEX_MAX_BYTES = 8192;
/** 提示和记录里最多列几行 */
const LONGEST_LINES = 3;

const LF = 0x0a;
const CR = 0x0d;

export interface MemoryIndexLine {
  /** 行号,从 1 起 */
  line: number;
  /** 该行 UTF-8 字节数,不含换行符(LF 或 CRLF) */
  bytes: number;
}

export interface MemoryIndexCheck {
  totalBytes: number;
  maxBytes: number;
  /** 超出阈值的字节数;没超是 0 */
  overBytes: number;
  /** 最长的几行:字节数降序,相同长度行号小的在前;文件不足三行就只有那么多 */
  longest: MemoryIndexLine[];
}

export function validMemoryIndexMaxBytes(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** 按原始字节切行:LF 结束一行,行尾的 CR 算换行符的一部分;末行没有换行也算一行,末尾的换行不多算一个空行 */
function lineSizes(raw: Uint8Array): number[] {
  const sizes: number[] = [];
  let start = 0;
  const push = (end: number) => sizes.push(end > start && raw[end - 1] === CR ? end - start - 1 : end - start);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== LF) continue;
    push(i);
    start = i + 1;
  }
  if (start < raw.length) sizes.push(raw.length - start);
  return sizes;
}

/** raw 是 MEMORY.md 的原始字节(不要先解码:总量按磁盘上的字节算,坏的 UTF-8 也不该让检查出错) */
export function checkMemoryIndex(raw: Uint8Array, maxBytes: number = MEMORY_INDEX_MAX_BYTES): MemoryIndexCheck {
  if (!validMemoryIndexMaxBytes(maxBytes)) throw new RangeError("maxBytes 必须是正整数");
  const longest = lineSizes(raw)
    .map((bytes, i): MemoryIndexLine => ({ line: i + 1, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.line - b.line)
    .slice(0, LONGEST_LINES);
  return { totalBytes: raw.length, maxBytes, overBytes: Math.max(0, raw.length - maxBytes), longest };
}

/** 超额时的一行中文提示;没超返回 null。只带数字和行号——复述行内容等于把长索引再注入一遍 */
export function memoryIndexNotice(check: MemoryIndexCheck): string | null {
  if (check.overBytes <= 0) return null;
  const lines = check.longest.map((l) => `第 ${l.line} 行(${l.bytes} 字节)`).join("、");
  return `⚠ 记忆索引 MEMORY.md 共 ${check.totalBytes} 字节,超过 ${check.maxBytes} 字节阈值 ${check.overBytes} 字节`
    + (lines ? `;最长行:${lines}` : "") + "。只是提示,不会自动改动;要精简请先让用户确认。";
}
