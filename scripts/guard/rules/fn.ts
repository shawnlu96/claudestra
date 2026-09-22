// 函数长度：fn:overflow = 全仓Σ(函数行数 − 100)（总量棘轮，允许把超长函数原样搬出大文件）；
// fnLong:<名字> = 叫这个名字的超长函数个数（新写的超长函数不在 baseline 里 → 失败）。
// 名字取 AST 标识符（声明名 / 变量名 / 方法名 / 属性名 / 赋值目标 / 所在调用），与文件和签名行无关，
// 所以加参数、改返回类型、把函数搬到别的文件都不会变 key；真匿名（IIFE 等）才回退到 `<anon> 签名行`。
// 解析器按顺序找：oxc-parser（devDependency）→ web/node_modules/typescript（5.x 有 JS API）；
// 都没有就跳过本规则（根目录的 TS 7 是原生版，没有 JS API）。两种解析器的命名规则逐条对齐。
import { createRequire } from "module";
import { join } from "path";
import { FN_CAP } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";

interface FnSpan {
  start: number;
  end: number;
  /** AST 里的名字；null = 匿名，调用方回退到签名行。 */
  name: string | null;
}
export type SpanParser = (file: string, src: string) => FnSpan[];

function lineIndex(src: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (starts[m] <= pos) lo = m;
      else hi = m - 1;
    }
    return lo + 1;
  };
}

/** 名字文本统一去空白、截到 60 字符，两种解析器切出来的源码片段才能逐字相等。 */
const tidy = (s: string) => s.replace(/\s+/g, "").slice(0, 60);

const OXC_FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
type OxcNode = Record<string, any>;

/** oxc：函数自身没有名字时，看父节点（调用参数再看一层：`const x = useCallback(() => …)` 取 x）。 */
function oxcName(src: string, fn: OxcNode, parents: OxcNode[]): string | null {
  const text = (n: OxcNode) => tidy(src.slice(n.start, n.end));
  if (fn.id?.name) return fn.id.name;
  const p = parents[parents.length - 1];
  const g = parents[parents.length - 2];
  if (!p) return null;
  const key = (n: OxcNode) => (n.computed ? `[${text(n.key)}]` : text(n.key));
  const bindingName = (id: OxcNode) => (id.type === "Identifier" ? id.name : text(id));
  switch (p.type) {
    case "MethodDefinition":
    case "Property":
    case "PropertyDefinition":
      return key(p);
    case "VariableDeclarator":
      return bindingName(p.id);
    case "AssignmentExpression":
      return text(p.left);
    case "ExportDefaultDeclaration":
      return "default";
    case "CallExpression":
    case "NewExpression":
      return g?.type === "VariableDeclarator" ? bindingName(g.id) : `${text(p.callee)}(…)`;
  }
  return null;
}

function oxcParser(mod: { parseSync: (f: string, s: string) => { program: unknown } }): SpanParser {
  return (file, src) => {
    const lineOf = lineIndex(src);
    const out: FnSpan[] = [];
    const parents: OxcNode[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as OxcNode;
      const bodyType = node.body?.type;
      if (OXC_FN.has(node.type) && (bodyType === "BlockStatement" || bodyType === "FunctionBody")) {
        out.push({ start: lineOf(node.start), end: lineOf(node.end), name: oxcName(src, node, parents) });
      }
      parents.push(node);
      for (const k in node) if (k !== "parent") walk(node[k]);
      parents.pop();
    };
    walk(mod.parseSync(file, src).program);
    return out;
  };
}

/** TS：与 oxcName 同一套规则（TS 的方法/访问器自己带 name，oxc 要看父节点 MethodDefinition）。 */
function tsName(ts: any, sf: any, n: any): string | null {
  const text = (x: any) => tidy(x.getText(sf));
  if (ts.isConstructorDeclaration(n)) return "constructor";
  if (n.name) return ts.isComputedPropertyName(n.name) ? `[${text(n.name.expression)}]` : text(n.name);
  const p = n.parent;
  if (!p) return null;
  if (ts.isFunctionDeclaration(n) && n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) {
    return ts.isComputedPropertyName(p.name) ? `[${text(p.name.expression)}]` : text(p.name);
  }
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return text(p.left);
  if (ts.isExportAssignment(p)) return "default";
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    return ts.isVariableDeclaration(p.parent) ? text(p.parent.name) : `${text(p.expression)}(…)`;
  }
  return null;
}

function tsParser(ts: any): SpanParser {
  const isFn = (n: any) =>
    ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  return (file, src) => {
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
    const out: FnSpan[] = [];
    const visit = (n: any) => {
      if (isFn(n) && n.body && ts.isBlock(n.body)) {
        const a = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
        out.push({ start: a, end: b, name: tsName(ts, sf, n) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
}

/** 找一个可用的解析器；都不可用返回 null（规则降级跳过）。 */
export async function loadParser(root: string): Promise<{ name: string; parse: SpanParser } | null> {
  const oxcSpec = process.env.GUARD_OXC || "oxc-parser";
  try {
    const mod = await import(oxcSpec);
    if (typeof mod.parseSync === "function") return { name: "oxc-parser", parse: oxcParser(mod) };
  } catch {
    // oxc-parser 是可选的 devDependency，缺席时往下试 web 的 typescript
  }
  try {
    const ts = createRequire(join(root, "web", "package.json"))("typescript");
    if (typeof ts.createSourceFile === "function") return { name: `typescript ${ts.version}`, parse: tsParser(ts) };
  } catch {
    // web 依赖没装（CI 的 check job 就是这样），交给调用方打印跳过提示
  }
  return null;
}

const fnScope = (f: string) => /^(src|web|scripts)\//.test(f) && /\.(ts|tsx)$/.test(f);

function signatureOf(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 120);
}

function fnKey(s: FnSpan, lines: string[]): string {
  return s.name ? `fnLong:${s.name}` : `fnLong:<anon> ${signatureOf(lines[s.start - 1] ?? "")}`;
}

export function measureFn(files: Files, parse: SpanParser, cap = FN_CAP): RuleResult {
  const counts: Counts = { "fn:overflow": 0 };
  const per: [string, number][] = [];
  for (const [f, src] of files) {
    if (!fnScope(f)) continue;
    const lines = src.split("\n");
    let over = 0;
    for (const s of parse(f, src)) {
      const len = s.end - s.start + 1;
      if (len <= cap) continue;
      over += len - cap;
      const key = fnKey(s, lines);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (over) per.push([f, over]);
    counts["fn:overflow"] += over;
  }
  const detail = per.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `fn ${f}: 超出 ${n} 行`);
  return { counts, detail };
}
