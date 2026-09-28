/**
 * 「待你处理」的选项（docs 13 §4.3）：reply 的 components + 正文里的行内按钮 → ask 的标题 / 背景 / 选项行；
 * 以及回投 wire（`[button:id]` / `[select:id:v1,v2]`，adapters.ts 的冻结合同）和选项的互认。纯函数，单测 tests/ask-options.test.ts。
 * select 的 id 允许带冒号（按钮 id 白名单 ^[\w:-]+$），所以 wire 不能先切再查，只能拿选项行去对前缀。
 */
import { parseInlineButtons, plainLabel } from "./inline-buttons.js";
import { markdownToPlain } from "./plain-text.js";

interface AskButton {
  id: string;
  label: string;
  style?: string;
  emoji?: string;
}
interface AskSelectOption {
  label: string;
  value: string;
  description?: string;
}
export type AskRow =
  | { type: "buttons"; buttons: AskButton[] }
  | { type: "select" | "multiselect"; id: string; placeholder?: string; options: AskSelectOption[]; min?: number; max?: number; submitLabel?: string };

const TITLE_MAX = 40;
const CONTEXT_MAX = 300;
/** 按钮 / 选单 id 带这些前缀：只提示「可能是授权」，不改 kind（docs 13 §4.3） */
const AUTHORIZE_HINT = /^(release|push|delete|tag|deploy|force)(_|-|:|$)/i;

const chars = (s: string, n: number): string => {
  const a = Array.from(s);
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};

function isRow(r: unknown): r is AskRow {
  const x = r as { type?: unknown; buttons?: unknown; options?: unknown; id?: unknown };
  if (x?.type === "buttons") return Array.isArray(x.buttons) && x.buttons.length > 0;
  return (x?.type === "select" || x?.type === "multiselect") && typeof x.id === "string" && Array.isArray(x.options) && x.options.length > 0;
}

/** components（agent 给的，形状不可信）与行内按钮合成选项行；行内按钮合成一行（卡片自己换行）。一个能点的都没有 → [] */
function askRows(text: string, components: unknown): AskRow[] {
  const rows = (Array.isArray(components) ? components : []).filter(isRow);
  const inline = parseInlineButtons(text).map((b) => ({ id: b.id, label: plainLabel(b.label).slice(0, 80) || b.id, style: b.style }));
  return inline.length ? [...rows, { type: "buttons", buttons: inline }] : rows;
}

/**
 * 作答分组：每一行各算一组——按钮行按行号（buttons:<行号>），单选 / 多选按 id。和聊天气泡的按行作答（bug ①，replyRowKey）一致：
 * 一条 reply 里几行按钮各答各的。每组答过一次就算这组答完；所有组都答完才结案。web 的 asks-model.rowGroup 同规则。
 */
export function answerGroups(rows: AskRow[]): string[] {
  return [...new Set(rows.map(rowGroupOf))];
}

const rowGroupOf = (r: AskRow, i: number): string => (r.type === "buttons" ? `buttons:${i}` : `select:${r.id}`);

export interface ReplyAskDraft {
  title: string;
  context: string;
  options: AskRow[];
  kindHint: string | null;
}

/** 带选项的 reply → ask 草稿；没有能点的选项 → null（不建 ask） */
export function draftFromReply(text: string, components: unknown): ReplyAskDraft | null {
  const options = askRows(text, components);
  if (!options.length) return null;
  const lines = markdownToPlain(text).replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean);
  const ids = componentIds(options);
  // 卡片上标题下面紧跟背景：背景从第二行起取，不重复标题（标题被截短时整段照给，免得丢掉被截的那半句）
  const first = lines[0] ?? "";
  const title = chars(first || firstLabel(options) || "待你处理", TITLE_MAX);
  return {
    title,
    context: chars((title === first ? lines.slice(1) : lines).join("\n"), CONTEXT_MAX),
    options,
    kindHint: ids.some((id) => AUTHORIZE_HINT.test(id)) ? "authorize" : null,
  };
}

function firstLabel(rows: AskRow[]): string {
  const r = rows[0];
  return r.type === "buttons" ? plainLabel(r.buttons[0].label) : (r.placeholder ?? "");
}

/** 行里所有能回投的 id：按钮 id、选单 id */
function componentIds(rows: AskRow[]): string[] {
  return rows.flatMap((r) => (r.type === "buttons" ? r.buttons.map((b) => b.id) : [r.id]));
}

/** 这些已答的 wire 之外还有几组没答（部分作答时告诉 agent「还有 N 项」） */
export function groupsLeft(rows: AskRow[], choices: string[]): number {
  const got = new Set(choices.map((w) => matchWire(rows, w)?.group));
  return answerGroups(rows).filter((g) => !got.has(g)).length;
}

export interface WireMatch {
  wire: string;
  /** 给人看的：按钮 label / 选中项 label 用「、」连 */
  label: string;
  /** 属于哪一组（answerGroups） */
  group: string;
}

/** 一行 wire 对上这组选项 → 规范化的 wire + label；对不上（id 不在、值不在选项里、多选数量越界）→ null */
export function matchWire(rows: AskRow[], line: string): WireMatch | null {
  const btn = /^\[button:([\w:-]+)\]$/.exec(line);
  if (btn) {
    for (const [i, r] of rows.entries()) {
      const b = r.type === "buttons" ? r.buttons.find((x) => x.id === btn[1]) : undefined;
      if (b) return { wire: line, label: plainLabel(b.label) || b.id, group: rowGroupOf(r, i) };
    }
    return null;
  }
  if (!line.startsWith("[select:") || !line.endsWith("]")) return null;
  for (const r of rows) {
    if (r.type === "buttons" || !line.startsWith(`[select:${r.id}:`)) continue;
    const values = line.slice(`[select:${r.id}:`.length, -1).split(",").map((v) => v.trim()).filter(Boolean);
    const picked = values.map((v) => r.options.find((o) => o.value === v));
    if (!values.length || picked.some((o) => !o) || new Set(values).size !== values.length) continue;
    if (r.type === "select" && values.length !== 1) continue;
    if (r.type === "multiselect" && (values.length < (r.min ?? 1) || (r.max !== undefined && values.length > r.max))) continue;
    return { wire: `[select:${r.id}:${values.join(",")}]`, label: picked.map((o) => o!.label).join("、"), group: `select:${r.id}` };
  }
  return null;
}

/** 看起来像 wire 的行（不管对不对得上）：`[button:…]` / `[select:…]` 单独成行 */
const WIRE_LINE = /^\[(button|select):[^\]\n]+\]$/;

/** 一条人类消息拆成 wire 行与其余文字；输入框里的表单同步发送会是「wire 行 + 补充」 */
export function splitWire(content: string): { wires: string[]; rest: string } {
  const wires: string[] = [];
  const rest: string[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (WIRE_LINE.test(t)) wires.push(t);
    else rest.push(line);
  }
  return { wires, rest: rest.join("\n").trim() };
}
