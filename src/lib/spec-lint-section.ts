/** UI 必填节只认精确二级标题；渲染保留子标题，必填检查通过 contentOnly 排除仅有标题的空节。 */
export function uiSpecSection(text: string, name: string, contentOnly = false): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${name}`);
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= 2) break;
    if ((!contentOnly || !heading) && line.trim()) body.push(line.trimEnd());
  }
  return body;
}

/** CommonMark 围栏开 / 关（与 scheduler-post-verify-ledger.ts postVerifySection 同一认法）：围栏里的 `## …` 不是标题 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** 围栏外与 heading 整行（trimEnd）相同的行数：同名节重复时两边读取可能不一致，按出现次数拒 */
export function headingCount(text: string, heading: string): number {
  let fence: { ch: string; len: number } | null = null, n = 0;
  for (const l of text.split(/\r?\n/)) {
    const m = FENCE.exec(l);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) fence = null;
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { ch: m[1][0], len: m[1].length };
    else if (l.trimEnd() === heading) n++;
  }
  return n;
}
