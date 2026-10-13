/**
 * 一处旧名落在什么词法位置。JS / TS 交给 oxc-parser（仓库的 devDependency，guard 也用它）：注释、字符串 / 模板
 * 字符串正文、JSX 文本各有区间，其余算 code。解析报错的文件不猜——位置返回 null，brand 规则因此认领不了里面任何一处。
 * 别的文件没有现成的解析器：文档类扩展名整份算 text，其余整份算 data。
 */
import { extname } from "node:path";
import { parseSync } from "oxc-parser";
import type { Position } from "./rules.ts";

type Lang = "ts" | "tsx" | "jsx";
/** .js 里也可能写 JSX，统一按 jsx 读 */
const JS_LANG: Record<string, Lang> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "jsx", ".jsx": "jsx", ".mjs": "jsx", ".cjs": "jsx" };
const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);

interface Mark { start: number; end: number; pos: Position }
interface Node { type?: unknown; start?: unknown; end?: unknown; value?: unknown }

function literalPosition(n: Node): Position | null {
  if (n.type === "JSXText") return "jsx-text";
  if (n.type === "TemplateElement") return "string";
  return n.type === "Literal" && typeof n.value === "string" ? "string" : null;
}

/** 语法树里所有字符串性质的叶子。树是纯数据（没有父指针），按值递归就行 */
function collect(node: unknown, out: Mark[]) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  const pos = literalPosition(n);
  if (pos && typeof n.start === "number" && typeof n.end === "number") {
    out.push({ start: n.start, end: n.end, pos });
    return;
  }
  for (const child of Object.values(node)) collect(child, out);
}

function jsMarks(file: string, text: string, lang: Lang): Mark[] | null {
  try {
    const parsed = parseSync(file, text, { lang, sourceType: "module" });
    if (parsed.errors.length) return null;
    const marks: Mark[] = parsed.comments.map((c) => ({ start: c.start, end: c.end, pos: "comment" as const }));
    collect(parsed.program, marks);
    return marks.sort((a, b) => a.start - b.start);
  } catch {
    return null; // 解析器自己抛了和报语法错同样处理：位置未知，这份文件里的旧名不进 brand
  }
}

/** 返回「偏移 → 词法位置」。null = 这份文件解析不了，位置未知 */
export function lexFile(file: string, text: string): (offset: number) => Position | null {
  const ext = extname(file).toLowerCase();
  const lang = JS_LANG[ext];
  if (!lang) return () => (TEXT_EXT.has(ext) ? "text" : "data");
  const marks = jsMarks(file, text, lang);
  if (!marks) return () => null;
  return (offset) => {
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid]!.start <= offset) lo = mid + 1;
      else hi = mid;
    }
    const at = marks[lo - 1];
    return at && offset < at.end ? at.pos : "code";
  };
}
