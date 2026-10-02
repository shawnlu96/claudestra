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
