// 函数长度：fn:overflow = 全仓Σ(函数行数 − 100)（总量棘轮，允许把超长函数原样搬出大文件）；
// fnLong:<签名行> = 该签名的超长函数个数（新写的超长函数签名不在 baseline 里 → 失败）。
// 解析器按顺序找：oxc-parser（devDependency）→ web/node_modules/typescript（5.x 有 JS API）；
// 都没有就跳过本规则（根目录的 TS 7 是原生版，没有 JS API）。
import { createRequire } from "module";
import { join } from "path";
import { FN_CAP } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";

interface FnSpan {
  start: number;
  end: number;
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

const OXC_FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function oxcParser(mod: { parseSync: (f: string, s: string) => { program: unknown } }): SpanParser {
  return (file, src) => {
    const lineOf = lineIndex(src);
    const out: FnSpan[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as Record<string, any>;
      const bodyType = node.body?.type;
      if (OXC_FN.has(node.type) && (bodyType === "BlockStatement" || bodyType === "FunctionBody")) {
        out.push({ start: lineOf(node.start), end: lineOf(node.end) });
      }
      for (const k in node) if (k !== "parent") walk(node[k]);
    };
    walk(mod.parseSync(file, src).program);
    return out;
  };
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
        out.push({ start: a, end: b });
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
      const key = `fnLong:${signatureOf(lines[s.start - 1] ?? "")}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (over) per.push([f, over]);
    counts["fn:overflow"] += over;
  }
  const detail = per.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `fn ${f}: 超出 ${n} 行`);
  return { counts, detail };
}
