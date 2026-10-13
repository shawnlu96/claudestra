/**
 * merge-arch-SKIPAUTO1 · 效果点扫描与清单解析的纯函数（原在 scripts/skip-effects.ts，原样下沉：src/lib 不得依赖 scripts/）。
 * 只读字符串、不碰文件：scripts/skip-effects.ts 与 tests/shared-ledger-v2-stage2-skip-paths.test.ts 经 fs 喂源码，
 * skip-effects-auto-scope.ts 喂 PR head 的 Git 对象文本。规则一份；tests/skip-effects.test.ts。
 */
import { SCHEDULER_PASS_PATHS } from "./scheduler-v2-skip-paths.js";

/**
 * Blank `//` and `/* *\/` comments (JSDoc included) to spaces, keeping newlines. Quote-aware: `//` or `/*` inside a string, a
 * template literal (with `${}` nesting) or a regex literal is code, not a comment. A `/` starts a regex wherever an expression may
 * start: after an operator, `=>`, a keyword like `return` / `else`, a `)` that closes an `if` / `while` / `for` / `with` head, or a
 * `}` that closes a block. When unsure it reads a regex (copying code verbatim is safe; a missed regex could blank real code),
 * and an unterminated `/*` is left as code. The keyword look-back reads code with comments and whitespace collapsed, so no
 * comment or gap between `if` and `(` can push the keyword out of view.
 */
export function stripComments(src: string): string {
  let out = "", i = 0, prev = ""; // prev: last significant code token, to tell a regex `/` from a division
  let sig = ""; // recent code with each comment / whitespace run collapsed to one space, for the keyword look-back
  const parens: boolean[] = []; // per open `(`: whether it is a control-flow head
  const braces: ("block" | "expr" | "tmpl")[] = []; // per open `{` / `${`
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const tail = () => sig.trimEnd(); // the keyword checks only need the last word
  const put = (s: string, code = true) => { out += code ? s : blank(s); sig = (sig + (code ? s : " ")).replace(/\s+/g, " ").slice(-64); };
  const keyword = () => /(?:^|[^\w$.])(?:return|typeof|case|of|in|instanceof|new|delete|void|yield|await|throw|else|do)$/.test(tail());
  const exprStart = () => prev === "" || prev === "=>" || /^[(,=:[!&|?{;+\-*%<>~^]$/.test(prev) || keyword();
  const quoted = (q: string) => { // copy a string from its opening quote through the closing one
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    put(src.slice(i, j + 1)); i = j + 1;
  };
  const template = () => { // from after a backtick or a closing `}` of `${`, to the closing backtick or the next `${`
    let j = i;
    while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    if (src[j] === "$") { put(src.slice(i, j + 2)); i = j + 2; braces.push("tmpl"); prev = "{"; }
    else { put(src.slice(i, j + 1)); i = j + 1; prev = "`"; }
  };
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; put(src.slice(i, end), false); i = end; }
    else if (c === "/" && n === "*" && src.includes("*/", i + 2)) { const end = src.indexOf("*/", i + 2) + 2; put(src.slice(i, end), false); i = end; }
    else if (c === "'" || c === '"') { quoted(c); prev = c; }
    else if (c === "`") { put(c); i++; template(); }
    else if (c === "/" && exprStart()) {
      let j = i + 1, cls = false; // regex literal: skip escapes and `[...]` classes
      while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      put(src.slice(i, j + 1)); i = j + 1; prev = "/re";
    } else if (c === "}" && braces[braces.length - 1] === "tmpl") { braces.pop(); put(c); i++; template(); }
    else {
      if (c === "(") parens.push(/(?:^|[^\w$.])(?:if|while|for|with)$/.test(tail()));
      // an object literal follows an operator or keyword; a block follows `)`, `=>`, `;`, `{`, `}`, `else`, a name, ...
      if (c === "{") braces.push(/^[(,=:[!&|?+\-*%<>~^]$/.test(prev) || (prev === "w" && keyword() && !/(?:else|do)$/.test(tail())) ? "expr" : "block");
      const closed = c === ")" ? parens.pop() : c === "}" ? braces.pop() === "block" : false;
      put(c); i++;
      if (closed) prev = ";";
      else if (c === ">" && prev === "=" && src[i - 2] === "=") prev = "=>";
      else if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? "w" : c;
    }
  }
  return out;
}
// the gate and its inventories name commands and effects as data; they send nothing
export const isGate = (f: string) => f.startsWith("scheduler-v2-skip");
export type Src = { name: string; text: string };

/** Where the walk starts: schedulerPass and its injected steps. */
export const passRoots = (): string[] => ["scheduler-pass.ts", ...SCHEDULER_PASS_PATHS.map((p) => p.file)];

/** Value-import targets (`./x.js` → `x.ts`) of comment-stripped source; `import type` carries no code. */
export function valueImports(stripped: string): string[] {
  return [...stripped.matchAll(/(?:^|;)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+"\.\/([\w.-]+)\.js"/gm)].filter((m) => !m[1]).map((m) => `${m[2]!}.ts`)
    .concat([...stripped.matchAll(/\bimport\(\s*"\.\/([\w.-]+)\.js"\s*\)/g)].map((m) => `${m[1]!}.ts`));
}


/** Files reachable from schedulerPass and its injected steps through value imports (`import type` carries no code). */
export function passGraph(read: (f: string) => string, exists: (f: string) => boolean): Src[] {
  const seen = new Map<string, string>(), queue = passRoots();
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    const text = stripComments(read(f));
    seen.set(f, text);
    for (const d of valueImports(text)) if (exists(d)) queue.push(d);
  }
  return [...seen].map(([name, text]) => ({ name, text })).filter((f) => !isGate(f.name));
}

export const EFFECTS: Record<string, RegExp> = {
  ledger: /(?:\[\s*"ledger"\s*,|(?<!\b(?:statePath|join|resolve))\(\s*"ledger"\s*,|\b(?:recoveryWrite|ledgerWrite)\()/g,
  // SQL is case-insensitive; `stmt` counts the execution API (bun:sqlite `.run(`, `db.exec(`) whatever the SQL text looks like
  sql: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:OR\s+\w+\s+)?\S+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\b/gi,
  stmt: /\.run\s*\(|\b\w*(?:[dD]b|[dD]atabase)\s*\.exec\s*\(/g,
  proc: /\b(?:Bun\.spawn|Bun\.spawnSync|spawnSync|spawn|execFile|execFileSync|execSync|runBounded|runManagerProcess|tmuxRaw|tmuxFire|tmuxInterrupt)\s*\(/g,
  fs: /\b(?:writeFileSync|writeFile|renameSync|rename|rmSync|rm|unlinkSync|unlink|appendFileSync|mkdirSync|copyFileSync|symlinkSync)\s*\(/g,
  // an effect API imported or destructured under another name (`unlink as drop`, `{ spawn: run }`)
  alias: new RegExp(`\\b(?:${["writeFileSync", "writeFile", "renameSync", "rename", "rmSync", "rm", "unlinkSync", "unlink", "appendFileSync", "mkdirSync",
    "copyFileSync", "symlinkSync", "spawnSync", "spawn", "execFileSync", "execFile", "execSync"].join("|")})(?:\\s+as|\\s*:)\\s+[A-Za-z_$][\\w$]*\\s*[,}]`, "g"),
  notice: /\b(?:notifyProjectPm|bridgeSend|notify)\s*\(/g,
  vcs: /\[\s*"(?:git|gh)"\s*,|\b(?:git|gh)\(\s*\[/g,
};

/** file → site counts, only files with at least one site. */
export function effectSites(files: Src[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { name, text } of files) {
    const sig = Object.entries(EFFECTS).map(([k, r]) => [k, [...text.matchAll(r)].length] as const).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(" ");
    if (sig) out.set(name, sig);
  }
  return out;
}

export const ENTRY = /"([^"\n]+)": "([^"\n]*)",?( ?)/g;

/** SKIP_EFFECT_FILES 字面量所在的行区间 [start, end)；只认这里面不以注释开头的条目行。 */
export function inventoryLines(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.startsWith("export const SKIP_EFFECT_FILES"));
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith("};"));
  if (start < 0 || end < 0) throw new Error("清单原文里找不到 SKIP_EFFECT_FILES 字面量");
  return { start: start + 1, end };
}
export const isEntryLine = (l: string) => l.trimStart().startsWith('"');

/** 清单原文里登记的 文件 → 计数（按条目解析，和 import 到的 SKIP_EFFECT_FILES 应逐条相等）。 */
export function parseInventory(text: string): Map<string, string> {
  const lines = text.split("\n"), { start, end } = inventoryLines(lines), out = new Map<string, string>();
  for (const l of lines.slice(start, end).filter(isEntryLine)) {
    for (const m of l.matchAll(ENTRY)) {
      if (out.has(m[1]!)) throw new Error(`清单里 ${m[1]} 登记了两次`);
      out.set(m[1]!, m[2]!);
    }
  }
  return out;
}

/** 清单字面量里每条登记所在的 gate（`  pace: {` 这样的组头之下）。 */
export function inventoryGates(text: string): Map<string, string> {
  const lines = text.split("\n"), { start, end } = inventoryLines(lines), out = new Map<string, string>();
  let gate = "";
  for (const l of lines.slice(start, end)) {
    const head = /^\s*(\w+)\s*:\s*\{/.exec(l);
    if (head) gate = head[1]!;
    else if (isEntryLine(l)) for (const m of l.matchAll(ENTRY)) out.set(m[1]!, gate);
  }
  return out;
}

/** 条目行里的计数字符串抹成空串；剩下的是文件名、组、顺序、注释和其余全部字节。 */
function maskCounts(text: string): string {
  const lines = text.split("\n"), { start, end } = inventoryLines(lines);
  return lines.map((l, i) => i < start || i >= end || !isEntryLine(l) ? l
    : l.replace(ENTRY, (all, file: string, was: string) => `"${file}": ""${all.slice(file.length + was.length + 6)}`)).join("\n");
}

export type CountOnlyChange = { file: string; gate: string; from: string; to: string };

/**
 * 纯函数：两版清单原文之间是不是「只改了既有条目的计数字符串」。计数抹掉后两版须逐字节相同（增删条目、移组、换序、改注释、
 * 混进一行代码都过不了），且至少改了一条。不看扫描结果——计数对不对由调用方拿扫描值另核。
 */
export function countOnlyChanges(base: string, head: string): { ok: true; changed: CountOnlyChange[] } | { ok: false; reason: string } {
  let from: Map<string, string>, to: Map<string, string>, gates: Map<string, string>;
  try { from = parseInventory(base); to = parseInventory(head); gates = inventoryGates(base); }
  catch (e) { return { ok: false, reason: `清单解析失败：${(e as Error).message}` }; }
  if (maskCounts(base) !== maskCounts(head)) return { ok: false, reason: "除既有条目的计数外还有改动（增删 / 移组 / 换序 / 注释 / 代码）" };
  const changed = [...from].filter(([f, c]) => to.get(f) !== c).map(([file, c]) => ({ file, gate: gates.get(file) ?? "", from: c, to: to.get(file)! }));
  return changed.length ? { ok: true, changed } : { ok: false, reason: "清单没有计数改动" };
}
