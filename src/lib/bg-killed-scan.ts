/**
 * 首次挂上一个会话文件时，往回读到「某时刻之前」为止（BGW-1）：被杀通知在新鲜窗口内、但后面又写了几 MB 工具结果时，
 * 固定只看尾部 N 字节会把它永久跳过（PR1280-r1 notice-tail）。按块从末尾往前读，读到一块里出现早于 sinceMs 的记录就停，
 * 不会为了旧会话扫完整个文件。tests/bg-killed-notice.test.ts「notice-tail」
 */
import { open, type FileHandle } from "fs/promises";

const NL = 10;
const TS_RE = /"timestamp":"([^"]+)"/;

async function readAt(fh: FileHandle, from: number, to: number): Promise<Buffer> {
  const buf = Buffer.alloc(to - from);
  let used = 0;
  while (used < buf.length) {
    const r = await fh.read(buf, used, buf.length - used, from + used);
    if (!r.bytesRead) break;
    used += r.bytesRead;
  }
  return buf.subarray(0, used);
}

function tsOf(line: string): number | null {
  const m = TS_RE.exec(line);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** 末尾最后一个换行之后的位置：CC 可能正写到半行，半行留给之后的增量读 */
async function lastLineEnd(fh: FileHandle, size: number, chunk: number): Promise<number> {
  for (let pos = size; pos > 0;) {
    const from = Math.max(0, pos - chunk);
    const i = (await readAt(fh, from, pos)).lastIndexOf(NL);
    if (i >= 0) return from + i + 1;
    pos = from;
  }
  return 0;
}

/**
 * 从末尾往前按块读完整行，直到读到一块里有 timestamp 早于 sinceMs 的记录（或到文件头）。
 * 返回这些行（文件顺序）与 end（最后一个完整行之后的字节位置，之后的增量读从这里接）。
 */
export async function readRecentLines(path: string, sinceMs: number, chunk = 512_000): Promise<{ lines: string[]; end: number }> {
  const fh = await open(path, "r");
  try {
    const end = await lastLineEnd(fh, (await fh.stat()).size, chunk);
    const lines: string[] = [];
    let carry = Buffer.alloc(0); // 当前窗口开头那半行：属于更早的一行，拼到下一块末尾
    for (let pos = end; pos > 0;) {
      const from = Math.max(0, pos - chunk);
      const buf = Buffer.concat([await readAt(fh, from, pos), carry]);
      pos = from;
      const cut = from === 0 ? 0 : buf.indexOf(NL) + 1;
      if (from > 0 && cut === 0) {
        carry = buf; // 一整块都在同一行里：接着往前拼
        continue;
      }
      carry = buf.subarray(0, cut);
      const got = buf.subarray(cut).toString("utf8").split("\n").filter(Boolean);
      lines.unshift(...got);
      if (got.some((l) => (tsOf(l) ?? Infinity) < sinceMs)) break;
    }
    return { lines, end };
  } finally {
    await fh.close();
  }
}
