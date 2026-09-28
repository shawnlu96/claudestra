/**
 * 多选表单 ↔ 输入框同步行 `【标题】✓ label；✓ label`。输入框文字是唯一事实来源：勾选框显示、
 * 勾 / 取消、发送转换都经 lineOwners 这一条规则认行，三处不会对不上。发送时同步行换成
 * `[select:<id>:<v1>,<v2>]`，与点「提交」一致。agent 给的 label / placeholder 先单行化，
 * 选项不合格（空、重名、带 ✓【】、value 会破坏 wire）的表单整组不同步——否则能伪造出别的表单的回投。
 * 单测：tests/web-form-compose.test.ts。
 */
import type { WebComponentRow } from "./events";

export type MultiRow = Extract<WebComponentRow, { type: "multiselect" }>;

/** 参与同步的表单：messageId/rowKey 定位到消息里的行（发送后标已答用） */
export interface SyncForm {
  row: MultiRow;
  title: string;
  messageId?: string;
  rowKey?: string;
  /** 行在消息 replyComponents 里的下标：同一回合前后两段复用 id 时，两行 rowKey 相同，靠它区分 */
  rowIndex?: number;
}

/** 去掉零宽 / 双向控制字符，换行、控制字符、连续空白压成一个空格再 trim——agent 给的文字进输入框前一律过这里 */
export function oneLine(s: string | undefined): string {
  return (s ?? "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ")
    .trim();
}

const BAD_VALUE = /[\u0000-\u001f\u007f\u2028\u2029,\]]/;

/**
 * 能否同步进输入框：id 合法；label 单行化后非空、不重名、不含 ✓【】；placeholder 不含【】（锚点边界靠它们，
 * 带了就能伪造成别的表单的行）；value 非空、不重复、不含破坏 wire 的字符
 */
export function syncable(row: MultiRow): boolean {
  if (!/^[\w-]+$/.test(row.id) || row.options.length === 0 || /[【】]/.test(oneLine(row.placeholder))) return false;
  const labels = row.options.map((o) => oneLine(o.label));
  const values = row.options.map((o) => o.value);
  return (
    labels.every((l) => l && !/[✓【】]/.test(l)) &&
    new Set(labels).size === labels.length &&
    values.every((v) => v && !BAD_VALUE.test(v)) &&
    new Set(values).size === values.length
  );
}

/** 勾选退回本地（不进输入框）的原因码：写进 client.log，线上不用再猜是哪一条不满足 */
export type SyncBlock = "no-composer" | "not-open" | "unsyncable" | "superseded";

/**
 * 这一行表单能否走输入框同步；不能就给原因。输入框里的歧义行（lineScan 的 ambiguous）要看文字，另算。
 * 顺序即优先级：没有输入框 → 不在可作答表单里 → 选项不合格 → 同 id 有更新的一条（它才同步）。
 */
export function syncBlock(row: MultiRow, form: SyncForm | undefined, forms: SyncForm[], present: boolean): SyncBlock | null {
  if (!present) return "no-composer";
  if (!form) return "not-open";
  if (!syncable(row)) return "unsyncable";
  return forms.find((f) => f.row.id === row.id) === form ? null : "superseded";
}

/** 每个表单 id 的显示标题：placeholder（单行化）；不同表单 placeholder 重名时 `placeholder · id`；没有 placeholder 用 id */
export function formTitles(rows: MultiRow[]): Map<string, string> {
  const idsByPh = new Map<string, Set<string>>();
  for (const r of rows) {
    const ph = oneLine(r.placeholder);
    if (ph) idsByPh.set(ph, (idsByPh.get(ph) ?? new Set()).add(r.id));
  }
  const out = new Map<string, string>();
  for (const r of rows) {
    const ph = oneLine(r.placeholder);
    if (!out.has(r.id)) out.set(r.id, !ph ? r.id : (idsByPh.get(ph)?.size ?? 0) > 1 ? `${ph} · ${r.id}` : ph);
  }
  return out;
}

/** 行首锚点的合法写法：标题 / id / `placeholder · id`。裸 placeholder 只有在它就是标题（视图里唯一）时才认 */
function anchorsOf(row: MultiRow, title: string): string[] {
  const ph = oneLine(row.placeholder);
  return [...new Set([title, row.id, ...(ph ? [`${ph} · ${row.id}`] : [])])].sort((a, b) => b.length - a.length);
}

export function renderFormLine(row: MultiRow, title: string, values: string[]): string {
  const items = values
    .map((v) => row.options.find((o) => o.value === v))
    .filter((o): o is MultiRow["options"][number] => !!o)
    .map((o) => `✓ ${oneLine(o.label)}`);
  return items.length ? `【${title}】${items.join("；")}` : "";
}

export interface ParsedLine {
  /** 选中值，按行内出现顺序、去重 */
  values: string[];
  /** 同一行里跟在选项后面、不属于任何选项的文字（owner 在行尾接着打的补充） */
  rest: string;
}

/**
 * 解析一行是否是该表单的同步行。锚点按整段前缀匹配（placeholder 里带 `】` 也不切错）；选项按
 * label 最长匹配，label 后面必须是行尾、`；` 或空白，免得 `A` 吃掉 `AB` 的前缀。
 */
export function parseFormLine(line: string, row: MultiRow, title: string): ParsedLine | null {
  const anchor = anchorsOf(row, title).find((a) => line.startsWith(`【${a}】`));
  if (anchor == null) return null;
  const opts = row.options.map((o) => ({ value: o.value, label: oneLine(o.label) })).sort((a, b) => b.label.length - a.label.length);
  const values: string[] = [];
  let s = line.slice(anchor.length + 2);
  for (;;) {
    const m = /^\s*✓\s*/.exec(s);
    if (!m) break;
    const tail = s.slice(m[0].length);
    const hit = opts.find((o) => tail.startsWith(o.label) && /^(?:$|[；;\s])/.test(tail.slice(o.label.length)));
    if (!hit) break;
    if (!values.includes(hit.value)) values.push(hit.value);
    s = tail.slice(hit.label.length).replace(/^\s*[；;]/, "");
  }
  return { values, rest: s.trim() };
}

export interface LineOwner {
  index: number;
  parsed: ParsedLine;
  /** 勾的项超过 max：不转 wire，按普通文字发 */
  over: boolean;
}

/**
 * 认行规则（勾选显示、勾 / 取消、发送共用）：代码块里的行不算；一行只有恰好一个可同步表单能从中
 * 解析出 ≥1 个选项才归它（两个以上 = 歧义：按普通文字发，这几个表单退回本地勾选）；同一表单只认第一行。
 * forms 按 id 去重，先到先得。
 */
export function lineScan(text: string, forms: SyncForm[]): { owners: Map<string, LineOwner>; ambiguous: Set<string> } {
  const uniq: SyncForm[] = [];
  for (const f of forms) if (syncable(f.row) && !uniq.some((u) => u.row.id === f.row.id)) uniq.push(f);
  const out = new Map<string, LineOwner>();
  const ambiguous = new Set<string>();
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || /^\s*```/.test(line)) return;
    const hits = uniq.flatMap((f) => {
      const parsed = parseFormLine(line, f.row, f.title);
      return parsed && parsed.values.length > 0 ? [{ f, parsed }] : [];
    });
    if (hits.length > 1) hits.forEach((h) => ambiguous.add(h.f.row.id));
    if (hits.length !== 1 || out.has(hits[0].f.row.id)) return;
    const { f, parsed } = hits[0];
    out.set(f.row.id, { index, parsed, over: parsed.values.length > (Number(f.row.max) || f.row.options.length) });
  });
  return { owners: out, ambiguous };
}

export function lineOwners(text: string, forms: SyncForm[]): Map<string, LineOwner> {
  return lineScan(text, forms).owners;
}

/** 输入框里该表单当前勾了哪些（勾选框的显示状态就是它） */
export function pickedFromText(text: string, form: SyncForm, forms: SyncForm[]): LineOwner | null {
  return lineOwners(text, forms).get(form.row.id) ?? null;
}

/** 用新的选中集合就地改写该表单那一行；没有就在末尾另起一行追加；空集合删行（行尾补充留下） */
export function setFormValues(text: string, form: SyncForm, forms: SyncForm[], values: string[]): string {
  const lines = text.split("\n");
  const found = lineOwners(text, forms).get(form.row.id);
  const body = renderFormLine(form.row, form.title, values);
  if (found) {
    const next = [body, found.parsed.rest].filter(Boolean).join(" ");
    if (next) lines[found.index] = next;
    else {
      lines.splice(found.index, 1);
      // 删的是末尾追加的那行：连同追加时补的换行一起撤，勾了又取消输入框回到原样
      if (found.index > 0 && found.index === lines.length - 1 && lines[found.index] === "") lines.pop();
    }
    const out = lines.join("\n");
    return out.trim() ? out : "";
  }
  if (!body) return text;
  // 末尾补换行：光标点到输入框尾就落在下一行，owner 接着打的字不会粘进同步行
  if (!text.trim()) return `${body}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${body}\n`;
}

/** 勾 / 取消一项；已到 max 时再勾不生效（与提交按钮的约束一致） */
export function toggleFormValue(text: string, form: SyncForm, forms: SyncForm[], value: string): string {
  const cur = pickedFromText(text, form, forms)?.parsed.values ?? [];
  const max = Number(form.row.max) || form.row.options.length;
  if (cur.includes(value)) return setFormValues(text, form, forms, cur.filter((v) => v !== value));
  if (cur.length >= max) return text;
  return setFormValues(text, form, forms, [...cur, value]);
}

export interface ComposedSend {
  /** 发给 agent 的原文：同步行换成 [select:…]，其余原样 */
  wire: string;
  /** 本次一并作答的表单（发出后标已答） */
  answered: { messageId: string; rowKey: string; choiceValue: string }[];
}

/** 发送前转换。forms = 仍可作答的表单，新的在前（同一 id 复用时对应最新一条）；超过 max 的行按普通文字发 */
export function composeFormSend(text: string, forms: SyncForm[]): ComposedSend {
  const lines = text.split("\n");
  const answered: ComposedSend["answered"] = [];
  for (const [id, o] of lineOwners(text, forms)) {
    const f = forms.find((x) => x.row.id === id)!;
    if (o.over || !f.messageId || !f.rowKey) continue;
    const v = o.parsed.values.join(",");
    answered.push({ messageId: f.messageId, rowKey: f.rowKey, choiceValue: `${id}:${v}` });
    lines[o.index] = o.parsed.rest ? `[select:${id}:${v}]\n${o.parsed.rest}` : `[select:${id}:${v}]`;
  }
  return { wire: lines.join("\n").trim(), answered };
}

const SELECT_LINE = /^\[select:([\w-]+):(.+)\]$/;

export interface ResolvedForm {
  row: MultiRow;
  title: string;
  /** 确认能还原成可读行之后才调：回填已答 */
  commit: (values: string[]) => void;
}

/**
 * composeFormSend 的反向（历史 / 他端实时）：`[select:id:v]` 行还原成同步行的写法。值必须全都
 * 对得上选项才还原并回填已答——讨论里随手写的 `[select:x:bogus]`、代码块里的行原样保留。
 * 没有任何行被还原 → null。
 */
export function wireToDisplay(text: string, resolve: (id: string) => ResolvedForm | null): string | null {
  let hit = false;
  let fenced = false;
  const lines = text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : SELECT_LINE.exec(line.trim());
    if (!m) return line;
    const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
    const r = resolve(m[1]);
    if (!r || !values.length || !values.every((v) => r.row.options.some((o) => o.value === v))) return line;
    r.commit(values);
    hit = true;
    return renderFormLine(r.row, r.title, values);
  });
  return hit ? lines.join("\n") : null;
}
