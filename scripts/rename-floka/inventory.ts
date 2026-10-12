/**
 * Claudestra → Floka 改名的标识清点（只读）。拿 identifiers.json 对一棵目录树里每一处旧品牌字样归类：
 * 登记过的标识、三类允许表（历史 / 协议 / 品牌），都不是的算「未登记」，报告失败。
 * 开关 rename.inventory = off / observe / on（缺省 observe）：observe 只把报告写到标准输出；on 另外只写 --out 指定的
 * 那一个文件，而且它必须在被扫目录之外。被扫的文件一律不改；真实状态目录、运行时目录不读：扫描根过 assertScannable，
 * --config / --manifest 这两个输入文件过 checkedInputFile（按真实路径判断，软链指过去的也拒绝）。
 * 清单里的正则带着上文匹配（contextSegments），不逐行；「某个字段的值」这种语境不靠正则，按表达式认（valueOf，
 * 见 valueEnd）；注释只在转译器核对得了的 JS / TS 里认，别的代码文件里每一处都算调用点（callClassifier）。
 * 用法：bun scripts/rename-floka/inventory.ts --root <目录> [--mode off|observe|on] [--config <json>] [--manifest <json>] [--out <文件>]
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_RUNTIME_DIR } from "../../src/lib/paths.ts";
import { stateDirIn } from "../../src/lib/state-dir.ts";

type InventoryMode = "off" | "observe" | "on";
type AllowClass = "history" | "protocol" | "brand";
type Env = Record<string, string | undefined>;

interface Identifier {
  id: string;
  category: string;
  old: string;
  new: string;
  /** 匹配口径三选一：members（逐个字面量，后面不能再接标识符字符）、match（正则源码）、都不写就按 old 的字面量 */
  match?: string;
  members?: string[];
  /** 另外认领「名字匹配这个正则的字段」的值表达式里的命中（见 valueEnd）。别处已有专项认领的不抢 */
  valueOf?: string;
  /** 追加的正则标志，目前只用到 "i"（HTTP 头名大小写不敏感） */
  flags?: string;
  definition: string[];
  consumers: string[];
  compat: string;
  card: string;
  exitEvidence: string;
  /** mechanical = 可以按清单机械替换；manual = 要迁移步骤或 owner 拍板，不进机械替换名单 */
  replace: "mechanical" | "manual";
}
/** valueOf：字段语境的允许项。只把本来会落到机械替换 / 品牌兜底的命中改判过来，本来未登记的照样报失败 */
interface AllowEntry { id: string; class: AllowClass; match?: string; valueOf?: string; paths?: string[]; reason: string }
/**
 * 形状：命中 pattern（或落在 valueOf 字段的值里）的旧名必须由 categories 里某个类别的登记项认领。literal 里的类别也
 * 可以认领，但只认逐个点名的（members），正则通配不算——这样品牌兜底项吞不掉一个没登记的持久化 / 跨版本名字。
 */
interface Shape { id: string; pattern?: string; valueOf?: string; categories: string[]; literal?: string[] }
export interface Manifest {
  format: string;
  version: number;
  roots: string[];
  requiredCategories: string[];
  requiredUnchanged: string[];
  shapes: Shape[];
  identifiers: Identifier[];
  allow: AllowEntry[];
  unchanged: { id: string; value: string; reason: string }[];
  occupancy?: unknown[];
}

/** 同一种问题（kind + detail）合并成一条：file / line 是第一处，count 是总次数 */
interface Failure { kind: string; detail: string; file?: string; line?: number; count?: number }
interface IdentCount { id: string; category: string; replace: string; textOccurrences: number; callSites: number; files: number }
export interface InventoryReport {
  format: "claudestra.rename-inventory-report";
  mode: InventoryMode;
  ok: boolean;
  failures: Failure[];
  failureTotal: number;
  warnings: string[];
  totals: { files: number; textOccurrences: number; callSites: number; allowed: number; unregistered: number };
  identifiers: IdentCount[];
  allowed: Record<AllowClass, { occurrences: number; files: string[] }>;
  mechanical: { file: string; id: string; occurrences: number }[];
}

const MANIFEST_FORMAT = "claudestra.rename-inventory";
const REQUIRED_FIELDS = ["old", "new", "definition", "consumers", "compat", "card", "exitEvidence"] as const;
const ALLOW_CLASSES: AllowClass[] = ["history", "protocol", "brand"];
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "target", "Pods", "out", "dist", "build", "DerivedData"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FAILURES = 200;
/** JS / TS 的扩展名 → Bun 转译器的 loader（核对注释用，见 verifiedComments）。.js 也可能写 JSX，统一按 jsx 读 */
const JS_LOADER: Record<string, "ts" | "tsx" | "jsx"> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "jsx", ".jsx": "jsx", ".mjs": "jsx", ".cjs": "jsx" };
/** 文档 / 记录类的扩展名：里面的命中只算文本出现。不在这里、也不是 JS / TS 的一律当代码 / 配置，每一处都算调用点 */
const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".log", ".jsonl", ".csv", ".tsv"]);
/** 兜底类别：字段语境（valueOf）从它、以及没有形状的机械替换项手里改判，专项不动（见 scanText） */
const FALLBACK_CATEGORY = "brand";
/** 非 JS 文件里看着像注释的写法（块注释、前面是行首 / 空白 / 分隔符的 // 和 #、HTML 注释）。只用来给字段语境让路，不用来数调用点 */
const LOOSE_COMMENT = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<=^|[\s;,{})\]])(?:\/\/|#)[^\n]*/gm;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // 目录不存在时按字面路径比较就够：不存在的目录也读不到东西
  }
}

/**
 * 真实状态目录和运行时目录（含环境变量指过去的）。扫描根是它们、或是它们的上级就拒绝；输入文件落在里面也拒绝。
 * 环境变量跟应用同一个口径取值：lib/state-dir 的 stateDir、lib/paths 的 envDir 都是先 trim、空串当没设——
 * 这里不 trim 的话，带首尾空格的 override 应用认、保护不认，就护错了目录。
 */
function protectedDirs(env: Env, home: string): string[] {
  const overrides = [env.CLAUDESTRA_STATE_DIR, env.CLAUDESTRA_RUNTIME_DIR].map((v) => (v || "").trim()).filter((v) => v !== "");
  return [stateDirIn(home), DEFAULT_RUNTIME_DIR, ...overrides].map(realOrSelf);
}

/**
 * 不读真实状态目录：根就是它、或包住它的一律拒绝；落在它里面的只认带 .git 的检出（出借 worker 的工作副本就在
 * 状态目录下面，它是仓库不是状态）。walk 另外不跟软链，所以检出里指向状态目录的链接也读不到。
 */
function assertScannable(root: string, env: Env, home: string): string {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`root_not_directory: ${root}`);
  const real = realpathSync(root);
  for (const dir of protectedDirs(env, home)) {
    if (inside(dir, real)) throw new Error(`refuse_state_dir: ${root} 是状态/运行时目录或它的上级`);
    if (inside(real, dir) && !existsSync(join(real, ".git"))) throw new Error(`refuse_state_dir: ${root} 在状态/运行时目录里且不是仓库检出`);
  }
  return real;
}

/** 状态目录下面的出借工作副本是仓库不是状态：file 的某一级上级目录带 .git，且那一级严格在 dir 里面才算（dir 自己带 .git 不算） */
function inCheckoutBelow(file: string, dir: string): boolean {
  for (let d = dirname(file); d !== dir && inside(d, dir); d = dirname(d)) if (existsSync(join(d, ".git"))) return true;
  return false;
}

/**
 * 输入文件（--config / --manifest）读之前统一过这里，返回真实路径供读取。按真实路径判断：文件本身在状态 / 运行时
 * 目录里、或是指向那里的软链，都拒绝；例外只有状态目录下面的仓库检出里的文件（出借工作副本自带的清单）。
 */
function checkedInputFile(path: string, what: string, cwd: string, env: Env, home: string): string {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new Error(`input_missing: ${what} ${path} 不存在`);
  const real = realpathSync(abs);
  if (!lstatSync(real).isFile()) throw new Error(`input_not_file: ${what} ${path} 不是普通文件`);
  for (const dir of protectedDirs(env, home)) {
    if (inside(real, dir) && !inCheckoutBelow(real, dir)) throw new Error(`refuse_state_input: ${what} ${path} 在状态/运行时目录里（或是指向那里的软链）`);
  }
  return real;
}

function* walk(root: string, dir: string, blocked: string[]): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || blocked.some((b) => inside(full, b))) continue;
      yield* walk(root, full, blocked);
    } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
      yield relative(root, full).split(sep).join("/");
    }
  }
}

function globMatch(patterns: string[], file: string): boolean {
  return patterns.some((p) => new Bun.Glob(p).match(file));
}

function compile(source: string, what: string, problems: Failure[], flags = ""): RegExp | null {
  try {
    return new RegExp(source, `g${flags}`);
  } catch (e) {
    problems.push({ kind: "manifest_invalid", detail: `${what}: 正则不合法（${(e as Error).message}）` });
    return null;
  }
}

/** 清单自身的完整性：格式、七个登记字段、必备类别、三类允许表、明确不改的几项。与被扫目录无关 */
function validateManifest(m: Manifest): Failure[] {
  const out: Failure[] = [];
  if (m.format !== MANIFEST_FORMAT || m.version !== 1) out.push({ kind: "manifest_invalid", detail: `format/version 不是 ${MANIFEST_FORMAT} v1` });
  const seen = new Set<string>();
  for (const it of m.identifiers) {
    if (seen.has(it.id)) out.push({ kind: "manifest_invalid", detail: `标识 id 重复：${it.id}` });
    seen.add(it.id);
    for (const f of REQUIRED_FIELDS) {
      const v = (it as unknown as Record<string, unknown>)[f];
      const empty = Array.isArray(v) ? v.length === 0 || v.some((x) => typeof x !== "string" || !x.trim()) : typeof v !== "string" || !v.trim();
      if (empty) out.push({ kind: "field_missing", detail: `${it.id} 缺 ${f}` });
    }
    if (it.replace !== "mechanical" && it.replace !== "manual") out.push({ kind: "field_missing", detail: `${it.id} 缺 replace` });
  }
  for (const c of m.requiredCategories) {
    if (!m.identifiers.some((it) => it.category === c)) out.push({ kind: "category_missing", detail: `类别 ${c} 一项都没登记` });
  }
  for (const it of m.identifiers) {
    if (!m.requiredCategories.includes(it.category)) out.push({ kind: "manifest_invalid", detail: `${it.id} 的类别 ${it.category} 不在 requiredCategories 里` });
  }
  for (const cls of ALLOW_CLASSES) {
    if (!m.allow.some((a) => a.class === cls)) out.push({ kind: "allow_class_missing", detail: `允许表缺 ${cls} 类` });
  }
  for (const a of m.allow) {
    if (!ALLOW_CLASSES.includes(a.class)) out.push({ kind: "manifest_invalid", detail: `允许项 ${a.id} 的 class 不是 history/protocol/brand` });
    if (!a.match && !a.valueOf && !a.paths?.length) out.push({ kind: "manifest_invalid", detail: `允许项 ${a.id} 既没有 match / valueOf 也没有 paths` });
    if (!a.reason?.trim()) out.push({ kind: "field_missing", detail: `允许项 ${a.id} 缺 reason` });
  }
  for (const s of m.shapes) {
    if (!s.pattern && !s.valueOf) out.push({ kind: "manifest_invalid", detail: `形状 ${s.id} 既没有 pattern 也没有 valueOf` });
  }
  for (const id of m.requiredUnchanged) {
    if (!m.unchanged.some((u) => u.id === id && u.reason?.trim())) out.push({ kind: "unchanged_missing", detail: `「不改」名单缺 ${id}` });
  }
  return out;
}

/** ctx = 这条认领 / 形状来自字段语境（valueOf），不是来自对旧名本身的匹配 */
interface Claim { start: number; end: number; rank: number; ident?: Identifier; allow?: AllowEntry; ctx?: boolean }
/** re 匹配旧名本身，field 匹配 valueOf 的字段名；两个都可以没有（只按路径的允许项） */
interface Matcher { re: RegExp | null; field: RegExp | null }
interface Compiled {
  root: RegExp;
  idents: ({ it: Identifier } & Matcher)[];
  allows: ({ a: AllowEntry } & Matcher)[];
  shapes: ({ s: Shape } & Matcher)[];
}

/** members 里以 - 结尾的是「前缀族」（如临时目录前缀 cstra-test-），后面可以再接名字；其余是完整字面量 */
function identSource(it: Identifier): string {
  const one = (m: string) => (m.endsWith("-") ? `${escapeRe(m)}[A-Za-z0-9-]*` : escapeRe(m));
  if (it.members?.length) return `(?:${[...it.members].sort((a, b) => b.length - a.length).map(one).join("|")})(?![A-Za-z0-9_])`;
  return it.match ?? escapeRe(it.old);
}

function compileManifest(m: Manifest, problems: Failure[]): Compiled | null {
  const before = problems.length;
  const opt = (src: string | undefined, id: string, flags = "") => (src ? compile(src, id, problems, flags) : null);
  const field = (x: { id: string; valueOf?: string }) => opt(x.valueOf && `\\b(?:${x.valueOf})\\b`, `${x.id} 的 valueOf`);
  const root = compile(m.roots.join("|"), "roots", problems);
  const idents = m.identifiers.map((it) => ({ it, re: compile(identSource(it), it.id, problems, it.flags === "i" ? "i" : ""), field: field(it) }));
  const allows = m.allow.map((a) => ({ a, re: opt(a.match, a.id), field: field(a) }));
  const shapes = m.shapes.map((s) => ({ s, re: opt(s.pattern, s.id), field: field(s) }));
  return root && m.roots.length && problems.length === before ? { root, idents, allows, shapes } : null;
}

interface Range { start: number; end: number }
interface Segment { at: number; text: string }

function spans(re: RegExp, text: string): Range[] {
  const out: Range[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex++;
    else out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 升序数组里最后一个起点 ≤ off 的下标，没有就是 -1 */
function lastAtOrBefore<T>(sorted: T[], startOf: (x: T) => number, off: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (startOf(sorted[mid]!) <= off) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * 每个命中被哪些区间整个包住。命中按位置升序、互不重叠，区间按起点排好后顺着扫一遍：
 * 起点已到、终点还够得着的留在 active 里，够不着这个命中的也一定够不着后面的，直接丢掉。
 */
function coverers<T extends Range>(items: T[], hits: Range[]): T[][] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  let next = 0;
  let active: T[] = [];
  return hits.map((h) => {
    while (next < sorted.length && sorted[next]!.start <= h.start) active.push(sorted[next++]!);
    active = active.filter((x) => x.end >= h.end);
    return [...active];
  });
}

/** 语境往上带几个非空行。清单里的正则约定：一处匹配本身不跨行，回看的语境（lookbehind）最多隔着空白够到前面的非空行 */
const CONTEXT_LINES = 2;

/**
 * 要过清单正则的文本段：每个命中所在的行，往上带到前面 CONTEXT_LINES 个非空行（中间的空行一并带上）。字段名和值
 * 分在两行的写法（`slug:` 换行 `"…"`）因此看得见语境；又不必拿上百条正则去扫没有命中的大段文本。
 */
function contextSegments(text: string, hits: Range[]): Segment[] {
  const ranges: Range[] = [];
  for (const h of hits) {
    let start = text.lastIndexOf("\n", h.start - 1) + 1;
    for (let seen = 0; seen < CONTEXT_LINES && start > 0; ) {
      const prev = start < 2 ? 0 : text.lastIndexOf("\n", start - 2) + 1;
      if (text.slice(prev, start).trim()) seen++;
      start = prev;
    }
    const nl = text.indexOf("\n", h.end);
    const end = nl < 0 ? text.length : nl;
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map((r) => ({ at: r.start, text: text.slice(r.start, r.end) }));
}

function spansIn(re: RegExp, segments: Segment[]): Range[] {
  return segments.flatMap((seg) => spans(re, seg.text).map((s) => ({ start: s.start + seg.at, end: s.end + seg.at })));
}

/** 字符串收尾后的偏移。反斜杠转义整个跳过（行尾续行也在内）；没闭合时 multiline 决定到行尾为止还是一直找下去 */
function skipString(text: string, i: number, multiline: boolean): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === q) return j + 1;
    else if (text[j] === "\n" && !multiline) return j;
  }
  return text.length;
}

/** 换行处表达式还没完：上一行以运算符 / 开括号收尾，下一行以运算符开头，或者下一行比字段所在行缩进更深（YAML 的列表、折行） */
function continuesAcross(text: string, nl: number, indent: number): boolean {
  let a = nl - 1;
  while (a >= 0 && /\s/.test(text[a]!)) a--;
  let b = nl + 1;
  while (b < text.length && /\s/.test(text[b]!)) b++;
  if (/[:=?|&+([{,\\]/.test(text[a] ?? "") || /[?:|&.=]/.test(text[b] ?? "")) return true;
  return b < text.length && b - (text.lastIndexOf("\n", b - 1) + 1) > indent;
}

/**
 * 字段名后面的值表达式到哪儿为止（返回 from 表示后面不是值）。不靠正则数空白：字段名后面隔着空白接 : = ? | ! & ( [
 * 或 .成员 才算，然后配着括号、跳着字符串往后走，到本层的 , ; 或多出来的右括号为止——所以值外面套括号、套函数调用、
 * 写成数组或三元、字段名和值分在几行，都还在语境里。注释先抹成空白再进来（见 fieldSpans）。
 * 只看得见写在字段后面的值；先赋给变量、再把变量填进字段的，这里看不出来（迁移说明里记了这条边界）。
 */
function valueEnd(text: string, from: number): number {
  const lead = /(?:["'`]\]?)?\??\s*(?=[:=?|!&([]|\.[A-Za-z_$])/y; // 键名自己的收尾引号（"slug": 、["slug"]: ）先跳过
  lead.lastIndex = from;
  if (!lead.test(text)) return from;
  let j = lead.lastIndex;
  let indent = 0;
  for (let ls = text.lastIndexOf("\n", from - 1) + 1; text[ls + indent] === " " || text[ls + indent] === "\t"; ) indent++;
  let depth = 0;
  let seen = false; // 已经有值的一部分了：这之后的换行、本层的 { 才可能是表达式的结尾
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      j = skipString(text, j, ch === "`");
      seen = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (ch === "{" && depth === 0 && seen) return j;
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth-- === 0) return j;
    } else if (depth === 0 && (ch === ";" || ch === ",")) {
      return j;
    } else if (ch === "\n") {
      if (depth === 0 && seen && !continuesAcross(text, j, indent)) return j;
    } else if (!/[\s:=?|!&]/.test(ch)) {
      seen = true;
    }
    j++;
  }
  return j;
}

/** 字段语境的区间：每个字段名后面的值表达式。原文和抹掉注释的两份都算，取并集（注释里写的字段照样有语境） */
function fieldSpans(field: RegExp, views: string[]): Range[] {
  return views.flatMap((v) => spans(field, v).map((f) => ({ start: f.end, end: valueEnd(v, f.end) })).filter((r) => r.end > r.start));
}

/** 所有认领：标识和带 match / valueOf 的允许项。rank 是清单里的先后（允许项在前），等长时用来定谁优先 */
function claimsOn(segments: Segment[], views: string[], file: string, c: Compiled): Claim[] {
  const out: Claim[] = [];
  const add = (m: Matcher, who: { ident?: Identifier; allow?: AllowEntry }) => {
    if (m.re) for (const s of spansIn(m.re, segments)) out.push({ ...s, rank: out.length, ...who });
    if (m.field) for (const s of fieldSpans(m.field, views)) out.push({ ...s, rank: out.length, ...who, ctx: true });
  };
  for (const x of c.allows) if (!x.a.paths?.length || globMatch(x.a.paths, file)) add(x, { allow: x.a });
  for (const x of c.idents) add(x, { ident: x.it });
  return out;
}

/** 包住同一处的认领里取最长的；等长时允许项优先、其余按清单顺序 */
function pickClaim(covering: Claim[]): Claim | null {
  let best: Claim | null = null;
  for (const cl of covering) {
    const d = best ? cl.end - cl.start - (best.end - best.start) : 1;
    if (d > 0 || (d === 0 && cl.rank < best!.rank)) best = cl;
  }
  return best;
}

type Span = [start: number, end: number];

/**
 * / 开头的是不是正则字面量：看它前面那个记号（跨行往回看）。右括号后面只有 if / while / for / with 的条件括号
 * （ctlClose 记着最近一个这种括号的位置）才接正则，别的右括号、a++ 后面是除号。认成正则后在本行找不到结尾就还当除号。
 */
function regexEnd(text: string, i: number, ctlClose: number): number {
  const from = Math.max(0, i - 64);
  const before = text.slice(from, i).trimEnd();
  if (before.endsWith(")")) {
    if (from + before.length - 1 !== ctlClose) return -1;
  } else if (before && (/(?:\+\+|--)$/.test(before) || (!/[(,=:[!&|?{};+*%>~^-]$/.test(before) && !/\b(?:return|typeof|case|in|of|void|delete|throw|else|do|yield|await)$/.test(before)))) {
    return -1;
  }
  let cls = false;
  for (let j = i + 1; j < text.length && text[j] !== "\n"; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (cls) cls = ch !== "]";
    else if (ch === "[") cls = true;
    else if (ch === "/") return j + 1;
  }
  return -1;
}

/**
 * JS / TS 文件里是注释的区间。逐字符走：字符串、模板字符串、正则字面量里的 // 和 /* 不是注释。
 * 只求分清注释与代码，不是完整的词法分析——所以数调用点时结果不直接用，还要过 verifiedComments 的核对。
 */
function jsCommentSpans(text: string): Span[] {
  const out: Span[] = [];
  const tpl: number[] = []; // 模板字符串栈：-1 是模板正文，≥0 是 ${ } 里还没配上的花括号数
  const parens: boolean[] = []; // 每个还没配上的 ( 是不是 if / while / for / with 的条件括号
  let ctlClose = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (tpl[tpl.length - 1] === -1) {
      const expr = text.startsWith("${", i);
      if (ch === "`") tpl.pop();
      else if (expr) tpl.push(0);
      i += expr || ch === "\\" ? 2 : 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      // 合法源码里块注释一定收尾：收不了尾就是认错了，这两个字符当代码跳过
      if (end >= 0) out.push([i, end + 2]);
      i = end < 0 ? i + 2 : end + 2;
    } else if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      out.push([i, nl < 0 ? text.length : nl]);
      i = nl < 0 ? text.length : nl;
    } else if (ch === '"' || ch === "'") {
      i = skipString(text, i, false);
    } else if (ch === "/") {
      i = Math.max(regexEnd(text, i, ctlClose), i + 1);
    } else {
      if (ch === "`") tpl.push(-1);
      else if (ch === "(") parens.push(/\b(?:if|while|for|with)(?:\s+await)?\s*$/.test(text.slice(Math.max(0, i - 24), i)));
      else if (ch === ")") ctlClose = parens.pop() ? i : -1;
      else if (tpl.length && ch === "{") tpl[tpl.length - 1]!++;
      else if (tpl.length && ch === "}" && tpl[tpl.length - 1]!-- === 0) tpl.pop();
      i++;
    }
  }
  return out;
}

/** 把这些区间抹成等长的空白（换行留着，偏移不变） */
function blank(text: string, cut: Span[]): string {
  let pos = 0;
  let s = "";
  for (const [a, b] of cut) {
    s += text.slice(pos, a) + text.slice(a, b).replace(/[^\n]/g, " ");
    pos = b;
  }
  return s + text.slice(pos);
}

/**
 * JS / TS 的注释区间拿 Bun 的转译器再核一遍（只核里面有命中的）：把区间抹成空白，转译结果应该一字不差——注释
 * 本来就不进产物。结果变了，或者原文根本转译不了，说明手写扫描把代码错认成了注释：这种区间不认，里面的命中照算调用点。
 */
function verifiedComments(text: string, found: Span[], loader: "ts" | "tsx" | "jsx", hits: number[]): Span[] {
  const suspects = found.filter(([a, b]) => hits.some((h) => h >= a && h < b));
  if (!suspects.length) return [];
  const transpiler = new Bun.Transpiler({ loader, deadCodeElimination: false, trimUnusedImports: false });
  const emit = (src: string) => {
    try {
      return transpiler.transformSync(src);
    } catch {
      return null;
    }
  };
  const base = emit(text);
  if (base === null) return [];
  if (emit(blank(text, suspects)) === base) return suspects;
  return suspects.filter((s) => emit(blank(text, [s])) === base);
}

/** 看着像注释的区间：JS / TS 用逐字符的扫描，别的文件用 LOOSE_COMMENT。没核对过，只能拿去给字段语境让路 */
function looseComments(file: string, text: string): Span[] {
  if (extname(file).toLowerCase() in JS_LOADER) return jsCommentSpans(text);
  return spans(LOOSE_COMMENT, text).map((r): Span => [r.start, r.end]);
}

/**
 * 文本出现 vs 调用点：调用点是代码 / 配置文件里不在注释中的那些；文档、对话记录、注释里的只算文本出现。退出证据看的是
 * 「调用点为 0」，所以只在核对得了的地方认注释：JS / TS 的注释区间要过转译器（verifiedComments）。别的语言没有现成的
 * 解析器——原始字符串、字符串插值、heredoc、嵌套注释，手写扫描总有认错的写法，认错一次就可能把后面的真定义算没——
 * 所以那些文件里不认注释，每一处都算调用点（多算，不少算）。
 */
function callClassifier(file: string, text: string, comments: Span[], hits: number[]): (offset: number) => boolean {
  const ext = extname(file).toLowerCase();
  if (!(ext in JS_LOADER)) return () => !TEXT_EXT.has(ext);
  const verified = verifiedComments(text, comments, JS_LOADER[ext]!, hits);
  return (off) => {
    const at = verified[lastAtOrBefore(verified, (s) => s[0], off)];
    return !at || off >= at[1];
  };
}

interface Tally {
  byIdent: Map<string, { text: number; calls: number; files: Set<string> }>;
  allowed: Record<AllowClass, { occurrences: number; files: Set<string> }>;
  /** 文件 → 登记项 → 次数 */
  mechanical: Map<string, Map<string, number>>;
  failures: Failure[];
  unregistered: number;
  files: number;
}

function tokenAround(text: string, start: number, end: number): string {
  const ok = /[A-Za-z0-9_.:+@/-]/;
  let a = start;
  let b = end;
  while (a > 0 && ok.test(text[a - 1]!)) a--;
  while (b < text.length && ok.test(text[b]!)) b++;
  return text.slice(a, b).slice(0, 120);
}

function tallyIdent(it: Identifier, file: string, isCall: boolean, t: Tally) {
  const row = t.byIdent.get(it.id) ?? { text: 0, calls: 0, files: new Set<string>() };
  row.text++;
  if (isCall) row.calls++;
  row.files.add(file);
  t.byIdent.set(it.id, row);
  if (it.replace !== "mechanical") return;
  const perFile = t.mechanical.get(file) ?? new Map<string, number>();
  perFile.set(it.id, (perFile.get(it.id) ?? 0) + 1);
  t.mechanical.set(file, perFile);
}

/**
 * 清点一段文本（一份文件的全文，或者一个文件名）。认领和形状不按单行匹配，带着上文（见 contextSegments），字段语境
 * 和注释在全文上认。isCode = false 时（文件名）一处都不算调用点。
 *
 * 字段语境（ctx）怎么定谁认领：先按对旧名本身的匹配定出 base。base 是允许项，或是没毛病的专项（不是品牌兜底类，
 * 且是手工项、或这个名字自带形状——环境变量、cookie、签名用途这种），就归 base：语境不抢专项的调用点。否则归语境里
 * 的认领；只有一种例外：语境是允许项而 base 本来就该报失败，那就照样报失败，允许表不替没登记的名字打掩护。
 * 语境形状（「tag 字段的值要由浏览器存储类认领」）在 base 不是专项时一并要求。
 */
function scanText(text: string, file: string, c: Compiled, fileAllow: AllowEntry | null, isCode: boolean, t: Tally) {
  const hits = spans(c.root, text);
  if (!hits.length) return;
  if (fileAllow) {
    t.allowed[fileAllow.class].occurrences += hits.length;
    t.allowed[fileAllow.class].files.add(file);
    return;
  }
  const comments = isCode ? looseComments(file, text) : [];
  const views = comments.length ? [text, blank(text, comments)] : [text];
  const segments = contextSegments(text, hits);
  const claims = coverers(claimsOn(segments, views, file, c), hits);
  const shapeSpans = c.shapes.flatMap(({ s, re, field }) => [
    ...(re ? spansIn(re, segments).map((x) => ({ ...x, shape: s, ctx: false })) : []),
    ...(field ? fieldSpans(field, views).map((x) => ({ ...x, shape: s, ctx: true })) : []),
  ]);
  const shapesAt = coverers(shapeSpans, hits);
  const isCall = isCode ? callClassifier(file, text, comments, hits.map((h) => h.start)) : () => false;
  let lineStarts: number[] | null = null;
  const fail = (kind: string, detail: string, at: number) => {
    lineStarts ??= [0, ...spans(/\n/g, text).map((nl) => nl.end)];
    t.unregistered++;
    t.failures.push({ kind, detail, file, line: isCode ? lastAtOrBefore(lineStarts, (s) => s, at) + 1 : 0 });
  };
  // 盖住这一处的每条形状都要满足：认领项的类别在 categories 里，或在 literal 里且是逐个点名（members）认领的
  const unmet = (it: Identifier, shapes: Shape[]) => shapes.find((s) => !s.categories.includes(it.category) && !(s.literal?.includes(it.category) && it.members?.length));
  hits.forEach((h, i) => {
    const base = pickClaim(claims[i]!.filter((x) => !x.ctx));
    const ctx = pickClaim(claims[i]!.filter((x) => x.ctx));
    const own = shapesAt[i]!.filter((x) => !x.ctx).map((x) => x.shape);
    const baseBad = !base || (!!base.ident && !!unmet(base.ident, own));
    const special = !!base?.ident && !baseBad && base.ident.category !== FALLBACK_CATEGORY && (base.ident.replace === "manual" || own.length > 0);
    const cl = base?.allow || special || !ctx || (ctx.allow && baseBad) ? base : ctx;
    const shapes = special ? own : shapesAt[i]!.map((x) => x.shape);
    const token = tokenAround(text, h.start, h.end);
    if (!cl) {
      const hint = shapes[0] ? `（形状 ${shapes[0].id}，应登记到 ${shapes[0].categories.join(" / ")}）` : "";
      fail("unregistered", `${token}${hint}`, h.start);
    } else if (cl.allow) {
      t.allowed[cl.allow.class].occurrences++;
      t.allowed[cl.allow.class].files.add(file);
    } else {
      const it = cl.ident!;
      const shape = unmet(it, shapes);
      if (shape) fail("shape_unregistered", `${token} 只被 ${it.id}（${it.category}）兜住，形状 ${shape.id} 要登记到 ${shape.categories.join(" / ")}`, h.start);
      else tallyIdent(it, file, isCall(h.start), t);
    }
  });
}

function scanTree(root: string, m: Manifest, c: Compiled, blocked: string[]): Tally {
  const t: Tally = {
    byIdent: new Map(),
    allowed: { history: { occurrences: 0, files: new Set() }, protocol: { occurrences: 0, files: new Set() }, brand: { occurrences: 0, files: new Set() } },
    mechanical: new Map(),
    failures: [],
    unregistered: 0,
    files: 0,
  };
  const wholeFile = m.allow.filter((a) => !a.match && a.paths?.length);
  for (const file of walk(root, root, blocked)) {
    const buf = readFileSync(join(root, file));
    if (buf.includes(0)) continue;
    t.files++;
    const fileAllow = wholeFile.find((a) => globMatch(a.paths!, file)) ?? null;
    // 文件名本身也是一处文本出现（行号记 0，不算调用点）：带旧名的路径同样要有登记项认领
    scanText(file, file, c, fileAllow, false, t);
    scanText(buf.toString("utf8"), file, c, fileAllow, true, t);
  }
  return t;
}

function buildReport(mode: InventoryMode, m: Manifest, manifestFailures: Failure[], t: Tally | null): InventoryReport {
  const merged = new Map<string, Failure>();
  for (const f of [...manifestFailures, ...(t?.failures ?? [])]) {
    const prev = merged.get(`${f.kind}\n${f.detail}`);
    if (prev) prev.count = (prev.count ?? 1) + 1;
    else merged.set(`${f.kind}\n${f.detail}`, { ...f, count: 1 });
  }
  const failures = [...merged.values()];
  const identifiers: IdentCount[] = m.identifiers.map((it) => {
    const row = t?.byIdent.get(it.id);
    return { id: it.id, category: it.category, replace: it.replace, textOccurrences: row?.text ?? 0, callSites: row?.calls ?? 0, files: row?.files.size ?? 0 };
  });
  const allowed = Object.fromEntries(ALLOW_CLASSES.map((cls) => {
    const row = t?.allowed[cls];
    return [cls, { occurrences: row?.occurrences ?? 0, files: [...(row?.files ?? [])].sort() }];
  })) as InventoryReport["allowed"];
  const mechanical = [...(t?.mechanical ?? [])].flatMap(([file, ids]) => [...ids].map(([id, occurrences]) => ({ file, id, occurrences })));
  const sum = (f: (r: IdentCount) => number) => identifiers.reduce((n, r) => n + f(r), 0);
  return {
    format: "claudestra.rename-inventory-report",
    mode,
    ok: failures.length === 0,
    failures: failures.slice(0, MAX_LISTED_FAILURES),
    failureTotal: failures.length,
    warnings: t ? identifiers.filter((r) => r.textOccurrences === 0).map((r) => `stale: ${r.id} 在被扫目录里没有出现`) : [],
    totals: {
      files: t?.files ?? 0,
      textOccurrences: sum((r) => r.textOccurrences),
      callSites: sum((r) => r.callSites),
      allowed: ALLOW_CLASSES.reduce((n, cls) => n + allowed[cls].occurrences, 0),
      unregistered: t?.unregistered ?? 0,
    },
    identifiers,
    allowed,
    mechanical,
  };
}

interface ScanOptions { mode?: InventoryMode; env?: Env; home?: string }

/** 清点一棵目录树。只读：不写任何文件，不跟软链，不进状态目录 */
export function runInventory(root: string, manifest: Manifest, opts: ScanOptions = {}): InventoryReport {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const real = assertScannable(root, env, home);
  const problems = validateManifest(manifest);
  const compiled = compileManifest(manifest, problems);
  // 根本身落在状态目录里的检出（已过 assertScannable）不能再按「在状态目录里」跳过它自己的子目录
  const blocked = protectedDirs(env, home).filter((d) => !inside(real, d));
  const tally = compiled ? scanTree(real, manifest, compiled, blocked) : null;
  return buildReport(opts.mode ?? "observe", manifest, problems, tally);
}

function parseMode(v: unknown, where: string): InventoryMode {
  if (v === "off" || v === "observe" || v === "on") return v;
  throw new Error(`invalid_mode: ${where} 的 rename.inventory 只能是 off / observe / on`);
}

/** --mode 优先，其次 --config 文件里的 rename.inventory（嵌套或点号键都认），都没有就是 observe。configPath 是 checkedInputFile 核过的真实路径 */
function resolveMode(flag: string | undefined, configPath: string | null): InventoryMode {
  if (flag !== undefined) return parseMode(flag, "--mode");
  if (!configPath) return "observe";
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const nested = (raw.rename as Record<string, unknown> | undefined)?.inventory;
  const v = nested ?? raw["rename.inventory"];
  return v === undefined ? "observe" : parseMode(v, configPath);
}

function parseArgs(argv: string[]): Record<string, string> {
  const allowed = new Set(["root", "mode", "config", "manifest", "out"]);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "") ?? "";
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !allowed.has(key) || value === undefined || key in out) throw new Error(`invalid_arguments: ${argv[i] ?? ""}`);
    out[key] = value;
  }
  return out;
}

/** on 只写 --out 这一个文件：必须显式给、在被扫目录之外、不在状态目录里、目录已存在、不覆盖已有文件 */
function checkedOutPath(out: string | undefined, root: string, env: Env, home: string): string {
  if (!out) throw new Error("out_required: on 模式必须用 --out 指定临时输出文件");
  const dir = realOrSelf(dirname(resolve(out)));
  const target = join(dir, resolve(out).split(sep).pop()!);
  if (inside(target, realOrSelf(root))) throw new Error("out_inside_root: 输出不能落在被扫目录里");
  if (protectedDirs(env, home).some((d) => inside(target, d))) throw new Error("out_inside_state: 输出不能落在状态/运行时目录里");
  if (!existsSync(dir)) throw new Error("out_dir_missing: 输出目录不存在（不代建目录）");
  if (existsSync(target)) throw new Error("out_exists: 输出文件已存在（不覆盖）");
  return target;
}

interface CliIo { env?: Env; home?: string; cwd?: string }
export interface CliResult { code: number; stdout: string; stderr: string; wrote: string | null }

/** 命令行入口的纯函数形态（测试直接调）。observe 永远退出 0，失败写在报告的 ok 里；on 在报告失败时退出 1 */
export function runCli(argv: string[], io: CliIo = {}): CliResult {
  const env = io.env ?? process.env;
  const home = io.home ?? homedir();
  try {
    const a = parseArgs(argv);
    const cwd = io.cwd ?? process.cwd();
    // 输入文件先核真实路径再读：给了 --config 就核，哪怕 --mode 已经定了开关
    const mode = resolveMode(a.mode, a.config === undefined ? null : checkedInputFile(a.config, "--config", cwd, env, home));
    if (mode === "off") return { code: 0, stdout: `${JSON.stringify({ mode, skipped: true })}\n`, stderr: "", wrote: null };
    const root = resolve(cwd, a.root ?? ".");
    const manifestPath = checkedInputFile(a.manifest ?? join(import.meta.dir, "identifiers.json"), "--manifest", cwd, env, home);
    const target = mode === "on" ? checkedOutPath(a.out, root, env, home) : null;
    if (mode !== "on" && a.out) throw new Error("out_needs_on: --out 只在 on 模式下生效");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const report = runInventory(root, manifest, { mode, env, home });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (target) writeFileSync(target, body, { flag: "wx" });
    return { code: mode === "on" && !report.ok ? 1 : 0, stdout: body, stderr: "", wrote: target };
  } catch (e) {
    return { code: 2, stdout: "", stderr: `${(e as Error).message}\n`, wrote: null };
  }
}

if (import.meta.main) {
  const r = runCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  // 不调 process.exit：报告有几百 KB，接管道时立刻退出会把没写完的输出截断
  process.exitCode = r.code;
}
