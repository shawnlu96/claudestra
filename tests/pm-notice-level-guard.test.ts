/**
 * 验收线 4（agents-NOTICETYPE1）：扫 src 下对 PM 通知入口的调用，不许用 `level: undefined` / `pmLevel: undefined`，
 * 也不许用 `as any` / `as never` 绕过必填级别（类型检查管不住这两种写法）。
 * 走 oxc 语法树：正文字符串、模板字符串、注释里的括号和字样都不会干扰配对或误报。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";

const ENTRY = new Set(["notifyProjectPm", "sendLedgerNotice", "sendToPm", "notifyTaskPm", "notifyPm"]);
const LEVEL_KEYS = new Set(["level", "pmLevel"]);
type Node = { type: string; [k: string]: unknown };

const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";
function children(n: Node): Node[] {
  return Object.entries(n).flatMap(([k, v]) => k === "parent" ? [] : Array.isArray(v) ? v.filter(isNode) : isNode(v) ? [v] : []);
}
/** 被调用的函数名：notifyPm(...) / deps.notifyPm(...) / deps.notifyPm!(...) / d?.notifyPm(...) */
function calleeName(c: Node | undefined): string | null {
  if (!c) return null;
  if (c.type === "TSNonNullExpression" || c.type === "ParenthesizedExpression") return calleeName(c.expression as Node);
  if (c.type === "Identifier") return c.name as string;
  if (c.type === "MemberExpression" || c.type === "StaticMemberExpression") return c.computed ? null : (c.property as Node).name as string;
  return null;
}
/** 实参子树里有没有绕过：级别键取 undefined、或任何 as any / as never */
function bypassed(n: Node): boolean {
  if (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression") {
    const t = (n.typeAnnotation as Node).type;
    if (n.type === "TSAsExpression" && (t === "TSAnyKeyword" || t === "TSNeverKeyword")) return true;
  }
  if (n.type === "Property" && !n.computed && LEVEL_KEYS.has(((n.key as Node).name ?? (n.key as Node).value) as string)) {
    let v = n.value as Node;
    while (v.type === "TSAsExpression" || v.type === "TSNonNullExpression" || v.type === "ParenthesizedExpression") v = v.expression as Node;
    if (v.type === "Identifier" && v.name === "undefined") return true;
    if (v.type === "UnaryExpression" && v.operator === "void") return true;
  }
  return children(n).some(bypassed);
}

/** 只解析正文里出现入口名的文件（整树 1000+ 文件全解析太慢）；入口名本身不会藏在字符串里调用 */
const MENTIONS = /\b(?:notifyProjectPm|sendLedgerNotice|sendToPm|notifyTaskPm|notifyPm)\b/;

/** 文件里对通知入口的全部调用（首行原文 + 是否绕过） */
function entryCalls(src: string, file: string): { text: string; bypass: boolean }[] {
  if (!MENTIONS.test(src)) return [];
  const { program, errors } = parseSync(file, src);
  if (errors.length) return [{ text: `parse error: ${errors[0].message}`, bypass: true }];
  const out: { text: string; bypass: boolean }[] = [];
  const visit = (n: Node) => {
    if (n.type === "CallExpression") {
      const name = calleeName(n.callee as Node);
      if (name && ENTRY.has(name)) out.push({ text: src.slice(n.start as number, n.end as number).split("\n")[0], bypass: (n.arguments as Node[]).some(bypassed) });
    }
    children(n).forEach(visit);
  };
  visit(program as unknown as Node);
  return out;
}

export const levelBypasses = (src: string, file = "x.ts"): string[] => entryCalls(src, file).filter((c) => c.bypass).map((c) => c.text);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? tsFiles(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []);
}

test("the guard catches level: undefined and as any / as never at a notice entry", () => {
  expect(levelBypasses(`await notifyProjectPm(db, p, t, { fromName: "scheduler", level: undefined });`)).toHaveLength(1);
  expect(levelBypasses(`void sendLedgerNotice({ to, text, messageId, pmLevel: undefined });`)).toHaveLength(1);
  expect(levelBypasses(`await deps.notifyPm(task, text, undefined as any);`)).toHaveLength(1);
  expect(levelBypasses(`await sendToPm(env, p, to, text, null as never);`)).toHaveLength(1);
  expect(levelBypasses(`await notifyProjectPm(db, p, t, { fromName: "x" } as any);`)).toHaveLength(1);
  expect(levelBypasses(`await deps.notifyPm!(a, text, "action"); await notifyProjectPm(db, p, t, { fromName: "x", level });`)).toEqual([]);
});

test("brackets and words inside strings, templates and comments neither end the scan nor count as a bypass", () => {
  // 审查反例：正文里一个右括号曾让扫描提前收尾，后面的 level: undefined as any 漏过
  expect(levelBypasses(`notifyProjectPm(db, p, "done)", {fromName: "scheduler", level: undefined as any});`)).toHaveLength(1);
  expect(levelBypasses("notifyProjectPm(db, p, `x) ${a(b)} (`, { fromName: \"s\", /* ) */ level: void 0 });")).toHaveLength(1);
  expect(levelBypasses(`d.notifyPm(t, "(" + ")))", x as any);`)).toHaveLength(1);
  expect(levelBypasses(`d.notifyPm(t, "level: undefined as any )", "info"); // notifyPm(a, b as never)`)).toEqual([]);
});

test("no call to a PM notice entry under src bypasses the required level", () => {
  const calls = tsFiles("src").flatMap((f) => entryCalls(readFileSync(f, "utf8"), f).map((c) => ({ ...c, text: `${f}: ${c.text}` })));
  expect(calls.length).toBeGreaterThan(60); // 扫描真的找到了入口调用（不是全空放行）
  expect(calls.filter((c) => c.bypass).map((c) => c.text)).toEqual([]);
});
