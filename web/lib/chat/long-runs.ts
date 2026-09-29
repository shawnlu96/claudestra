/** 超过这个长度的无空白串每隔这么多字断一次 */
export const RUN_CHUNK = 200;
/** 只把 ASCII 空白当断点：全角空格隔开的一长串（`　x　x…`）Chromium 同样排得很慢 */
const LONG_RUN = new RegExp(`[^ \\t\\r\\n]{${RUN_CHUNK + 1},}`, "g");

/**
 * 把纯文本切成若干段，段与段之间由调用方插 <wbr>（components/domd/long-runs.tsx）。
 * 超长无空白串（`"` 连一行、混排字体回退的一长串）Chromium 排版是平方级：19 万字要 20 s；每 RUN_CHUNK 字给一个断行点
 * 就降到 0.3 s 内。正常文字不切：短串本来不会被拆，更长的本来就按 break-words 在任意处断。
 */
export function longRunSegments(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(LONG_RUN)) {
    const end = m.index + m[0].length;
    for (let i = m.index + RUN_CHUNK; i < end; i += RUN_CHUNK) {
      out.push(text.slice(last, i));
      last = i;
    }
  }
  out.push(text.slice(last));
  return out;
}
