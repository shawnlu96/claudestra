/**
 * 会话 jsonl 流式字节 grep —— 从 session-history.ts 抽出的纯扫描层(searchSessionHistory
 * 的预筛)。只依赖 fs,不 import session-history,避免循环。
 */

import { open as fsOpen } from "fs/promises";

/** ASCII 大写折小写(字节级)。非 ASCII 字节(≥0x80)原样返回——UTF-8 自同步,子串搜索无误配。 */
function foldByte(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** 英文字母出现频率(%),用来挑锚点字节——锚点越稀有,memchr 给出的候选越少。
 *  非 ASCII 字节按 0.5 估(本语料以 ASCII 为主,CJK 字节相对稀有)。 */
const LETTER_FREQ: Record<string, number> = {
  e: 12, t: 9, a: 8, o: 7.5, i: 7, n: 6.7, s: 6.3, h: 6, r: 6, d: 4.3, l: 4,
  c: 2.8, u: 2.8, m: 2.4, w: 2.4, f: 2.2, g: 2, y: 2, p: 1.9, b: 1.5, v: 1,
  k: 0.8, j: 0.15, x: 0.15, q: 0.1, z: 0.07,
};

/** needle 里最稀有的那个字节的下标(见 LETTER_FREQ)。 */
export function anchorIndex(needle: Buffer): number {
  let best = 0;
  let bestFreq = Infinity;
  for (let i = 0; i < needle.length; i++) {
    const b = needle[i];
    const f = b > 127 ? 0.5 : LETTER_FREQ[String.fromCharCode(b)] ?? 0.3;
    if (f < bestFreq) {
      bestFreq = f;
      best = i;
    }
  }
  return best;
}

/**
 * 在 buf 里找 needle(已小写)的首个位置,ASCII 不区分大小写;没有返回 -1。
 * 锚点取 needle 里最稀有的字节(不是首字节):用 Buffer.indexOf(锚点的大小写两形)
 * 走 memchr 定位候选,再逐字节折叠校验。两个游标各自惰性推进——每个候选只付一次
 * indexOf,而不是每轮两次(2026-09-08 实测 255MB 文件搜 "aston" 709ms→227ms:
 * 首字节 'a' 太常见,换成 's' 且减半 indexOf 调用是这里的全部收益)。
 */
export function findFolded(buf: Buffer, needle: Buffer, ai: number, from = 0): number {
  const n = needle.length;
  const limit = buf.length - n;
  if (n === 0 || limit < 0 || from > limit) return -1;
  const lo = needle[ai];
  const hi = lo >= 97 && lo <= 122 ? lo - 32 : lo;
  let ia = buf.indexOf(lo, from + ai);
  let ib = hi === lo ? -1 : buf.indexOf(hi, from + ai);
  while (ia >= 0 || ib >= 0) {
    const useA = ib < 0 || (ia >= 0 && ia < ib);
    const at = useA ? ia : ib;
    const p = at - ai;
    if (p > limit) return -1;
    if (p >= from) {
      let k = 0;
      for (; k < n; k++) if (foldByte(buf[p + k]) !== needle[k]) break;
      if (k === n) return p;
    }
    if (useA) ia = buf.indexOf(lo, at + 1);
    else ib = buf.indexOf(hi, at + 1);
  }
  return -1;
}

/**
 * 流式 grep:按固定 chunk 读文件,只产出小写后含 q 的整行及其全文件行号
 * (见 searchSessionHistory 注释)。
 *
 * 两级都在字节上做(2026-09-08 二次优化,全库 764MB 一次搜索 6.2s→约 2s):
 * ① 块级预筛 findFolded,不含词的块只用 memchr 数换行,连字符串都不建;
 * ② 命中块也不整块解码——用 findFolded 逐个定位命中处,只把**命中所在的那一行**
 *    切出来解码,其余行连 toLowerCase 都不做(旧写法一命中就 split 整块 8MB
 *    再逐行小写,而一块里通常只有几行真的含词)。
 * 字节比较按 ASCII 折叠大小写:CJK / 数字 / 标点在大小写映射下不变,可安全走这条
 * 快路;查询里带**非 ASCII 且大小写会变**的字母(如 ö/Ö)时退回逐块 toLowerCase 的
 * 慢路,保证不漏。残留边角:İ(U+0130) 小写成 "i̇" 这类映射后才等于 ASCII 的字符,
 * 快路会漏——本语料里可忽略。
 */
export async function* grepJsonlLines(
  filePath: string,
  q: string,
  chunkBytes = 8 * 1024 * 1024,
): AsyncGenerator<{ line: string; idx: number }> {
  const size = Math.max(64, Math.floor(chunkBytes));
  const needle = Buffer.from(q, "utf8");
  const ai = anchorIndex(needle);
  // 非 ASCII 部分大小写不变 → 字节比较可靠
  const nonAscii = [...q].filter((ch) => ch.charCodeAt(0) > 127).join("");
  const byteFast = nonAscii === nonAscii.toUpperCase() && nonAscii === nonAscii.toLowerCase();
  const fh = await fsOpen(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    let pos = 0;
    let lineIdx = 0; // 已数过的行数 = body 首行的全文件行号
    let carry: Buffer = Buffer.alloc(0); // 上一块末尾的半行(字节,不切开 UTF-8)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, size, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      const work = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const lastNl = work.lastIndexOf(10);
      if (lastNl < 0) {
        carry = Buffer.from(work); // buf 会被下轮覆写,必须拷贝
        continue;
      }
      const body = work.subarray(0, lastNl + 1);
      carry = Buffer.from(work.subarray(lastNl + 1));

      if (!byteFast) {
        // 慢路:非 ASCII 变形词,整块解码后逐行判定(正确性优先)
        const text = body.toString("utf8");
        if (text.toLowerCase().includes(q)) {
          const lines = text.split("\n"); // 末尾恒为 ""(body 以 \n 结尾)
          for (let i = 0; i < lines.length - 1; i++) {
            const l = lines[i];
            if (l.trim() && l.toLowerCase().includes(q)) yield { line: l, idx: lineIdx + i };
          }
          lineIdx += lines.length - 1;
        } else {
          let at = -1;
          while ((at = body.indexOf(10, at + 1)) !== -1) lineIdx++;
        }
        continue;
      }

      // 快路:先看整块有没有;有才逐个命中处切行。nlCur 恒为「已数过的最后一个
      // 换行之后」= 当前行的起点,nlSeen 是块内已数过的换行数。
      let nlSeen = 0;
      let nlCur = 0;
      const countUpTo = (p: number) => {
        for (;;) {
          const at = body.indexOf(10, nlCur);
          if (at === -1 || at >= p) return;
          nlSeen++;
          nlCur = at + 1;
        }
      };
      let from = 0;
      for (;;) {
        const p = findFolded(body, needle, ai, from);
        if (p < 0) break;
        countUpTo(p);
        const nl = body.indexOf(10, p);
        const lineEnd = nl === -1 ? body.length : nl;
        const line = body.subarray(nlCur, lineEnd).toString("utf8");
        if (line.trim() && line.toLowerCase().includes(q)) yield { line, idx: lineIdx + nlSeen };
        from = lineEnd + 1;
        if (from > body.length - needle.length) break;
      }
      // 收尾:数完本块剩余换行(body 以 \n 结尾 ⇒ nlSeen = 本块完整行数)
      for (;;) {
        const at = body.indexOf(10, nlCur);
        if (at === -1) break;
        nlSeen++;
        nlCur = at + 1;
      }
      lineIdx += nlSeen;
    }
    const tail = carry.toString("utf8");
    if (tail.trim() && tail.toLowerCase().includes(q)) yield { line: tail, idx: lineIdx };
  } finally {
    await fh.close();
  }
}
