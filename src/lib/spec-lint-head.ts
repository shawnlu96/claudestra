/** 卡首扫描只有一份：调度模板选择和 UI 必填检查必须认同一段声明，标题前的文字不参与。 */
const TEMPLATE_LINE = /^模板\s*[:：]\s*(.*)$/;

export function scanSpecHead(text: string): { head: string[]; decls: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const title = lines.findIndex((l) => /^#\s/.test(l));
  const head: string[] = [];
  for (const l of lines.slice(title + 1)) {
    if (/^##\s/.test(l)) break;
    head.push(l);
  }
  const decls = head.map((l) => l.match(TEMPLATE_LINE)?.[1]?.trim()).filter((v): v is string => v !== undefined);
  return { head, decls };
}
