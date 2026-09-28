/**
 * 多选表单 ↔ 输入框文字（T10，owner 2026-09-28「每勾一个，就同步到我的聊天框里」）。
 *
 * 输入框里每个表单占一行：`【<标题>】✓ <label>；✓ <label>`，标题 = placeholder（没有就用
 * id，同一视图 placeholder 重名时 `placeholder · id`）。**输入框文字是唯一事实来源**：
 * 勾选框的状态每次都从这一行解析出来，不另存——owner 手改了这一行，勾选就跟着变，不会
 * 出现「框里写的和勾的不一样」。发送时这一行原位换成 `[select:<id>:<v1>,<v2>]`，与点
 * 「提交」的回投一致，老 agent 不用改。纯函数，单测见 tests/web-form-compose.test.ts。
 */
import type { WebComponentRow } from "./events";

export type MultiRow = Extract<WebComponentRow, { type: "multiselect" }>;

/** 一个可同步的表单：messageId/rowKey 定位到消息里的行（标已答用） */
export interface OpenForm {
  messageId: string;
  rowKey: string;
  row: MultiRow;
}

/** 每个表单 id 的显示标题。placeholder 在不同 id 之间重名时加 id 区分。 */
export function formTitles(rows: MultiRow[]): Map<string, string> {
  const idsByPh = new Map<string, Set<string>>();
  for (const r of rows) {
    const ph = r.placeholder?.trim();
    if (ph) idsByPh.set(ph, (idsByPh.get(ph) ?? new Set()).add(r.id));
  }
  const out = new Map<string, string>();
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const ph = r.placeholder?.trim();
    if (!ph) out.set(r.id, r.id);
    else out.set(r.id, (idsByPh.get(ph)?.size ?? 0) > 1 ? `${ph} · ${r.id}` : ph);
  }
  return out;
}

/** 行首锚点可以写成的几种样子（显示标题 / placeholder / id / placeholder · id），长的先试 */
function anchorsOf(row: MultiRow, title: string): string[] {
  const ph = row.placeholder?.trim();
  const all = [title, row.id, ...(ph ? [ph, `${ph} · ${row.id}`] : [])];
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

export function renderFormLine(row: MultiRow, title: string, values: string[]): string {
  const items = values
    .map((v) => row.options.find((o) => o.value === v)?.label)
    .filter((l): l is string => !!l)
    .map((l) => `✓ ${l}`);
  return items.length ? `【${title}】${items.join("；")}` : "";
}

export interface ParsedLine {
  /** 选中值，按行内出现顺序、去重 */
  values: string[];
  /** 同一行里跟在选项后面、不属于任何选项的文字（owner 在行尾接着打的补充） */
  rest: string;
}

/**
 * 解析一行是否是该表单的同步行。锚点按整段前缀匹配（不找第一个 `】`，placeholder 里带
 * `】` 也不切错）；选项按 label 最长匹配（label 里带 `；` 也不歧义），label 后面必须是
 * 行尾、`；` 或空白，免得 `A` 吃掉 `AB` 的前缀。
 */
export function parseFormLine(line: string, row: MultiRow, title: string): ParsedLine | null {
  const anchor = anchorsOf(row, title).find((a) => line.startsWith(`【${a}】`));
  if (anchor == null) return null;
  const labels = [...row.options].sort((a, b) => b.label.length - a.label.length);
  const values: string[] = [];
  let s = line.slice(anchor.length + 2);
  for (;;) {
    const m = /^\s*✓\s*/.exec(s);
    if (!m) break;
    const tail = s.slice(m[0].length);
    const hit = labels.find((o) => tail.startsWith(o.label) && /^(?:$|[；;\s])/.test(tail.slice(o.label.length)));
    if (!hit) break;
    if (!values.includes(hit.value)) values.push(hit.value);
    s = tail.slice(hit.label.length).replace(/^\s*[；;]/, "");
  }
  return { values, rest: s.trim() };
}

function findLine(lines: string[], row: MultiRow, title: string): { index: number; parsed: ParsedLine } | null {
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFormLine(lines[i], row, title);
    if (parsed) return { index: i, parsed };
  }
  return null;
}

/** 输入框文字里该表单当前勾了哪些（勾选框的显示状态就是它） */
export function pickedFromText(text: string, row: MultiRow, title: string): string[] {
  return findLine(text.split("\n"), row, title)?.parsed.values ?? [];
}

/** 用新的选中集合就地改写该表单那一行；没有这一行就在末尾另起一行追加，空集合删行 */
export function setFormValues(text: string, row: MultiRow, title: string, values: string[]): string {
  const lines = text.split("\n");
  const found = findLine(lines, row, title);
  const body = renderFormLine(row, title, values);
  if (found) {
    const next = [body, found.parsed.rest].filter(Boolean).join(" ");
    if (next) lines[found.index] = next;
    else lines.splice(found.index, 1);
    const out = lines.join("\n");
    return out.trim() ? out : "";
  }
  if (!body) return text;
  // 末尾补换行：光标点到输入框尾就落在下一行，owner 接着打的字不会粘进同步行
  if (!text.trim()) return `${body}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${body}\n`;
}

/** 勾 / 取消一项；超过 max 的勾选不生效（与提交按钮的约束一致） */
export function toggleFormValue(text: string, row: MultiRow, title: string, value: string): string {
  const cur = pickedFromText(text, row, title);
  const max = Number(row.max) || row.options.length;
  if (cur.includes(value)) return setFormValues(text, row, title, cur.filter((v) => v !== value));
  if (cur.length >= max) return text;
  return setFormValues(text, row, title, [...cur, value]);
}

export interface ComposedSend {
  /** 发给 agent 的原文：同步行换成 [select:…]，其余原样 */
  wire: string;
  /** 本次一并作答的表单（发出后标已答） */
  answered: { messageId: string; rowKey: string; choiceValue: string }[];
}

/**
 * 发送前转换。forms = 仍可作答的表单，**新的在前**：同一 id 出现在多条消息里时对应最新
 * 一条未作答的。一行只转一次、一个表单只认第一行；没勾任何项的行、已作答 / 不在视图里的
 * 表单的行都按普通文字发（映射不回 value 就不能冒充结构化选择）。
 */
export function composeFormSend(text: string, forms: OpenForm[], titles: Map<string, string>): ComposedSend {
  const answered: ComposedSend["answered"] = [];
  const used = new Set<string>(); // 已转过的表单 id
  const lines = text.split("\n").map((line) => {
    for (const f of forms) {
      if (used.has(f.row.id)) continue;
      const p = parseFormLine(line, f.row, titles.get(f.row.id) ?? f.row.id);
      if (!p || p.values.length === 0) continue;
      used.add(f.row.id);
      const v = p.values.join(",");
      answered.push({ messageId: f.messageId, rowKey: f.rowKey, choiceValue: `${f.row.id}:${v}` });
      return p.rest ? `[select:${f.row.id}:${v}]\n${p.rest}` : `[select:${f.row.id}:${v}]`;
    }
    return line;
  });
  return { wire: lines.join("\n").trim(), answered };
}

const SELECT_LINE = /^\[select:([\w-]+):(.+)\]$/;

/**
 * 历史还原（composeFormSend 的反向）：多行消息里的 `[select:id:v]` 行还原成同步行的可读
 * 写法。resolve 返回该 id 所属的行与标题（找不到 = 原样保留）。没有任何 select 行 → null。
 */
export function wireToDisplay(
  text: string,
  resolve: (id: string, values: string[]) => { row: MultiRow; title: string } | null,
): string | null {
  let hit = false;
  const lines = text.split("\n").map((line) => {
    const m = SELECT_LINE.exec(line.trim());
    if (!m) return line;
    const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
    const r = resolve(m[1], values);
    const body = r ? renderFormLine(r.row, r.title, values) : "";
    if (!body) return line;
    hit = true;
    return body;
  });
  return hit ? lines.join("\n") : null;
}
