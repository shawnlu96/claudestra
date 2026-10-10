// 效果点清单（src/lib/scheduler-v2-skip-effects.ts）的计数自动更新。合并后某个已登记文件的计数变了时用：
//   bun run skip-effects           扫一次，已登记文件的计数原位改成扫描值、不再有效果点的条目删掉；未登记的新文件只列出来，由人定组
//   bun run skip-effects --check   只打印将要做的改动，不写文件
// 退出码：有未登记文件为 1（--check 下有任何改动也为 1），清单原文和 SKIP_EFFECT_FILES 对不上为 2（什么都不写），否则 0。
// 扫描规则和 tests/shared-ledger-v2-stage2-skip-paths.test.ts 共用这一份。tests/skip-effects.test.ts。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKIP_EFFECT_FILES } from "../src/lib/scheduler-v2-skip-effects.ts";
import { SCHEDULER_PASS_PATHS } from "../src/lib/scheduler-v2-skip-paths.ts";

const LIB = join(import.meta.dir, "..", "src", "lib");
const source = (file: string) => readFileSync(join(LIB, file), "utf8");

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

/** Files reachable from schedulerPass and its injected steps through value imports (`import type` carries no code). */
export function passGraph(read: (f: string) => string = source, exists = (f: string) => existsSync(join(LIB, f))): Src[] {
  const seen = new Map<string, string>(), queue = ["scheduler-pass.ts", ...SCHEDULER_PASS_PATHS.map((p) => p.file)];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    const text = stripComments(read(f));
    seen.set(f, text);
    const deps = [...text.matchAll(/(?:^|;)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+"\.\/([\w.-]+)\.js"/gm)].filter((m) => !m[1]).map((m) => m[2]!)
      .concat([...text.matchAll(/\bimport\(\s*"\.\/([\w.-]+)\.js"\s*\)/g)].map((m) => m[1]!));
    for (const d of deps) if (exists(`${d}.ts`)) queue.push(`${d}.ts`);
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

/** 折行上限，和 guard 的 LONG_LINE 一致。 */
const MAX_LINE = 200;
const ENTRY = /"([^"\n]+)": "([^"\n]*)",?( ?)/g;

export type SkipEffectsRewrite = {
  text: string;
  changed: { file: string; from: string; to: string }[];
  removed: { file: string; was: string }[];
  unregistered: { file: string; sites: string }[];
  /** 改了或删了的文件在清单 `//` 注释里被提到的行（1 起），注释不自动改，只提醒人工核。 */
  comments: { file: string; line: number }[];
};

/** SKIP_EFFECT_FILES 字面量所在的行区间 [start, end)；只认这里面不以注释开头的条目行。 */
function inventoryLines(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.startsWith("export const SKIP_EFFECT_FILES"));
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith("};"));
  if (start < 0 || end < 0) throw new Error("清单原文里找不到 SKIP_EFFECT_FILES 字面量");
  return { start: start + 1, end };
}
const isEntryLine = (l: string) => l.trimStart().startsWith('"');
const isComment = (l: string) => l.trimStart().startsWith("//");

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

/** 超过 MAX_LINE 的条目行在条目之间折开，缩进和原行一样。 */
function fold(indent: string, entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const last = out.length ? out[out.length - 1]! : null;
    if (last !== null && `${last} ${e}`.length <= MAX_LINE) out[out.length - 1] = `${last} ${e}`;
    else out.push(`${indent}${e}`);
  }
  return out;
}

/** 纯函数：清单原文 + 扫描结果 → 新原文和改了 / 删了 / 未登记的表。组、顺序、注释和其余字节都不动。 */
export function rewriteInventory(text: string, scan: Map<string, string>): SkipEffectsRewrite {
  const lines = text.split("\n"), { start, end } = inventoryLines(lines), registered = parseInventory(text);
  const changed: SkipEffectsRewrite["changed"] = [], removed: SkipEffectsRewrite["removed"] = [];
  const body: string[] = [];
  for (const l of lines.slice(start, end)) {
    if (!isEntryLine(l)) { body.push(l); continue; }
    let touched = false;
    const next = l.replace(ENTRY, (all, file: string, was: string, space: string) => {
      const now = scan.get(file);
      if (now === undefined) { removed.push({ file, was }); touched = true; return ""; }
      if (now === was) return all;
      changed.push({ file, from: was, to: now }); touched = true;
      return `"${file}": "${now}",${space}`;
    }).trimEnd();
    if (!touched) body.push(l);
    else if (next.trim() && next.length <= MAX_LINE) body.push(next);
    else if (next.trim()) body.push(...fold(/^\s*/.exec(next)![0], [...next.matchAll(ENTRY)].map((m) => m[0].trimEnd())));
  }
  const unregistered = [...scan].filter(([f]) => !registered.has(f)).sort(([a], [b]) => a.localeCompare(b)).map(([file, sites]) => ({ file, sites }));
  const touchedFiles = [...changed, ...removed].map((c) => c.file);
  const comments = touchedFiles.flatMap((file) => {
    const word = new RegExp(`(?<![\\w.-])${file.replace(/\.ts$/, "").replace(/[.-]/g, "\\$&")}(?![\\w-])`);
    return lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i >= start && i < end && isComment(l) && word.test(l)).map(({ i }) => ({ file, line: i + 1 }));
  });
  return { text: [...lines.slice(0, start), ...body, ...lines.slice(end)].join("\n"), changed, removed, unregistered, comments };
}

export type SkipEffectsIo = {
  /** 清单文件路径（测试指向临时副本） */
  inventory?: string;
  read?: (f: string) => string;
  exists?: (f: string) => boolean;
  log?: (line: string) => void;
};

/** 脚本入口：只管读写文件和打印，返回退出码。 */
export function runSkipEffects(argv: string[], io: SkipEffectsIo = {}): number {
  const log = io.log ?? ((l: string) => console.log(l)), check = argv.includes("--check");
  const path = io.inventory ?? join(LIB, "scheduler-v2-skip-effects.ts");
  const text = readFileSync(path, "utf8");
  const parsed = parseInventory(text), imported = new Map(Object.values(SKIP_EFFECT_FILES).flatMap((byFile) => Object.entries(byFile)));
  const drift = [...new Set([...parsed.keys(), ...imported.keys()])].filter((f) => parsed.get(f) !== imported.get(f));
  if (drift.length) {
    log(`✗ 清单原文和 SKIP_EFFECT_FILES 对不上（${drift.join(", ")}），什么都没写`);
    return 2;
  }
  const r = rewriteInventory(text, effectSites(passGraph(io.read, io.exists)));
  for (const c of r.changed) log(`改 ${c.file}: "${c.from}" → "${c.to}"`);
  for (const c of r.removed) log(`删 ${c.file}: "${c.was}"（扫描里没有了）`);
  for (const c of r.comments) log(`⚠ ${c.file} 在清单第 ${c.line} 行的注释里被提到，请人工核那段注释`);
  for (const u of r.unregistered) log(`未登记 ${u.file}: "${u.sites}" —— 要人定放哪一组 gate`);
  const edits = r.changed.length + r.removed.length;
  if (!check && r.text !== text) writeFileSync(path, r.text);
  log(edits || r.unregistered.length ? `${check ? "将" : "已"}改 ${r.changed.length} 条、删 ${r.removed.length} 条；未登记 ${r.unregistered.length} 个` : "效果点清单和代码一致");
  return r.unregistered.length || (check && edits) ? 1 : 0;
}

if (import.meta.main) process.exit(runSkipEffects(process.argv.slice(2)));
