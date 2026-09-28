/**
 * 「待你处理」的选项（docs 13 §4.3）：reply 的 components + 正文里的行内按钮 → ask 的标题 / 背景 / 选项行；
 * 以及回投 wire（`[button:id]` / `[select:id:v1,v2]`，adapters.ts 的冻结合同）和选项的互认。纯函数，单测 tests/ask-options.test.ts。
 * select 的 id 允许带冒号（按钮 id 白名单 ^[\w:-]+$），所以 wire 不能先切再查，只能拿选项行去对前缀。
 */
import { parseInlineButtons, plainLabel, toButtonRows } from "./inline-buttons.js";
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

/** components（agent 给的，形状不可信）与行内按钮合成选项行；一个能点的都没有 → [] */
function askRows(text: string, components: unknown): AskRow[] {
  const rows = (Array.isArray(components) ? components : []).filter(isRow);
  const inline = parseInlineButtons(text);
  return inline.length ? [...rows, ...toButtonRows(inline)] : rows;
}

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
  const plain = markdownToPlain(text).replace(/[ \t]+/g, " ").trim();
  const first = plain.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const ids = componentIds(options);
  return {
    title: chars(first || firstLabel(options) || "待你处理", TITLE_MAX),
    context: chars(plain.replace(/\n{2,}/g, "\n"), CONTEXT_MAX),
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

export interface WireMatch {
  wire: string;
  /** 给人看的：按钮 label / 选中项 label 用「、」连 */
  label: string;
}

/** 一行 wire 对上这组选项 → 规范化的 wire + label；对不上（id 不在、值不在选项里、多选数量越界）→ null */
export function matchWire(rows: AskRow[], line: string): WireMatch | null {
  const btn = /^\[button:([\w:-]+)\]$/.exec(line);
  if (btn) {
    for (const r of rows) {
      const b = r.type === "buttons" ? r.buttons.find((x) => x.id === btn[1]) : undefined;
      if (b) return { wire: line, label: plainLabel(b.label) || b.id };
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
    return { wire: `[select:${r.id}:${values.join(",")}]`, label: picked.map((o) => o!.label).join("、") };
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
