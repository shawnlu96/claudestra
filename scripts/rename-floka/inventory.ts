/**
 * Claudestra → Floka 改名的标识清点（只读）。拿 identifiers.json 对一棵目录树里每一处旧品牌字样归类：
 * 登记过的标识、三类允许表（历史 / 协议 / 品牌），都不是的算「未登记」，报告失败。
 * 开关 rename.inventory = off / observe / on（缺省 observe）：observe 只把报告写到标准输出；on 另外只写 --out 指定的
 * 那一个文件，而且它必须在被扫目录之外。被扫的文件一律不改；真实状态目录、运行时目录不读：扫描根过 assertScannable，
 * --config / --manifest 这两个输入文件过 checkedInputFile（按真实路径判断，软链指过去的也拒绝）。
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
interface AllowEntry { id: string; class: AllowClass; match?: string; paths?: string[]; reason: string }
/**
 * 形状：命中 pattern 的旧名必须由 categories 里某个类别的登记项认领。literal 里的类别也可以认领，但只认逐个点名的
 * （members），正则通配不算——这样品牌兜底项吞不掉一个没登记的持久化 / 跨版本名字。
 */
interface Shape { id: string; pattern: string; categories: string[]; literal?: string[] }
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
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SLASH_COMMENT_EXT = new Set([...JS_EXT, ".rs", ".swift", ".kt", ".java", ".gradle", ".css", ".m", ".h"]);
/** 单引号是字符串定界符的语言；其余（Rust / Swift / Kotlin…）单引号只当字符字面量跳过，免得生命周期标注 'a 吃掉半行 */
const SINGLE_QUOTE_EXT = new Set([...JS_EXT, ".css", ".gradle"]);
const HASH_COMMENT_EXT = new Set([".sh", ".yml", ".yaml", ".toml", ".rb", ".py", ".command"]);
const DATA_CODE_EXT = new Set([".json", ".plist", ".pbxproj", ".xml", ".html", ".entitlements", ".xcconfig", ".webmanifest"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // 目录不存在时按字面路径比较就够：不存在的目录也读不到东西
  }
}

/** 真实状态目录和运行时目录（含环境变量指过去的）。扫描根是它们、或是它们的上级就拒绝；输入文件落在里面也拒绝 */
function protectedDirs(env: Env, home: string): string[] {
  const dirs = [stateDirIn(home), DEFAULT_RUNTIME_DIR, env.CLAUDESTRA_STATE_DIR, env.CLAUDESTRA_RUNTIME_DIR];
  return dirs.filter((d): d is string => !!d && d.trim() !== "").map(realOrSelf);
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
    if (!a.match && !a.paths?.length) out.push({ kind: "manifest_invalid", detail: `允许项 ${a.id} 既没有 match 也没有 paths` });
    if (!a.reason?.trim()) out.push({ kind: "field_missing", detail: `允许项 ${a.id} 缺 reason` });
  }
  for (const id of m.requiredUnchanged) {
    if (!m.unchanged.some((u) => u.id === id && u.reason?.trim())) out.push({ kind: "unchanged_missing", detail: `「不改」名单缺 ${id}` });
  }
  return out;
}

interface Claim { start: number; end: number; ident?: Identifier; allow?: AllowEntry }
interface Compiled {
  root: RegExp;
  idents: { it: Identifier; re: RegExp }[];
  allows: { a: AllowEntry; re: RegExp | null }[];
  shapes: { s: Shape; re: RegExp }[];
}

/** members 里以 - 结尾的是「前缀族」（如临时目录前缀 cstra-test-），后面可以再接名字；其余是完整字面量 */
function identSource(it: Identifier): string {
  const one = (m: string) => (m.endsWith("-") ? `${escapeRe(m)}[A-Za-z0-9-]*` : escapeRe(m));
  if (it.members?.length) return `(?:${[...it.members].sort((a, b) => b.length - a.length).map(one).join("|")})(?![A-Za-z0-9_])`;
  return it.match ?? escapeRe(it.old);
}

function compileManifest(m: Manifest, problems: Failure[]): Compiled | null {
  const root = compile(m.roots.join("|"), "roots", problems);
  const idents = m.identifiers.map((it) => ({ it, re: compile(identSource(it), it.id, problems, it.flags === "i" ? "i" : "") }));
  const allows = m.allow.map((a) => ({ a, re: a.match ? compile(a.match, a.id, problems) : null }));
  const shapes = m.shapes.map((s) => ({ s, re: compile(s.pattern, s.id, problems) }));
  if (!root || !m.roots.length || idents.some((x) => !x.re) || shapes.some((x) => !x.re) || allows.some((x) => x.a.match && !x.re)) return null;
  return { root, idents: idents as Compiled["idents"], allows, shapes: shapes as Compiled["shapes"] };
}

function spans(re: RegExp, line: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0].length === 0) re.lastIndex++;
    else out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 一行里所有认领：标识和带 match 的允许项。包住同一处时取最长的，等长时允许项优先、其余按清单顺序 */
function claimsOn(line: string, file: string, c: Compiled): Claim[] {
  const out: Claim[] = [];
  for (const { a, re } of c.allows) {
    if (!re || (a.paths?.length && !globMatch(a.paths, file))) continue;
    for (const s of spans(re, line)) out.push({ ...s, allow: a });
  }
  for (const { it, re } of c.idents) for (const s of spans(re, line)) out.push({ ...s, ident: it });
  return out;
}

function pickClaim(claims: Claim[], start: number, end: number): Claim | null {
  let best: Claim | null = null;
  for (const cl of claims) {
    if (cl.start > start || cl.end < end) continue;
    if (!best || cl.end - cl.start > best.end - best.start) best = cl;
  }
  return best;
}

interface Lang { js: boolean; lineComment: boolean; singleQuote: boolean }
/** 跨行状态：block = 在块注释里；tpl = 模板字符串栈，-1 是模板正文，≥0 是 ${ } 里还没配上的花括号数 */
interface LexState { block: boolean; tpl: number[] }
type Span = [start: number, end: number];

function skipString(line: string, i: number): number {
  const q = line[i];
  for (let j = i + 1; j < line.length; j++) {
    if (line[j] === "\\") j++;
    else if (line[j] === q) return j + 1;
  }
  return line.length; // 没闭合就到行尾为止：状态不带到下一行，一处看错不会污染后面
}

/** / 开头的是不是正则字面量：看它前面那个非空白字符。认成正则后在本行找不到结尾就还当除号 */
function regexEnd(line: string, i: number): number {
  const before = line.slice(0, i).trimEnd();
  if (before && !/[(,=:[!&|?{};+*%>~^-]$/.test(before) && !/\b(?:return|typeof|case|in|of|void|delete|throw|else|do|yield|await)$/.test(before)) return -1;
  let cls = false;
  for (let j = i + 1; j < line.length; j++) {
    const ch = line[j];
    if (ch === "\\") j++;
    else if (cls) cls = ch !== "]";
    else if (ch === "[") cls = true;
    else if (ch === "/") return j + 1;
  }
  return -1;
}

/** 代码态下的一个记号（字符串 / 字符字面量 / 模板 / 正则 / 花括号）往后跳多少列；注释不归这里管 */
function skipToken(line: string, i: number, st: LexState, lang: Lang): number {
  const ch = line[i];
  if (ch === '"' || (ch === "'" && lang.singleQuote)) return skipString(line, i);
  if (ch === "'") return line[i + 1] === "\\" && line[i + 3] === "'" ? i + 4 : line[i + 2] === "'" ? i + 3 : i + 1;
  if (!lang.js) return i + 1;
  if (ch === "`") st.tpl.push(-1);
  else if (ch === "/") return Math.max(regexEnd(line, i), i + 1);
  else if (st.tpl.length && ch === "{") st.tpl[st.tpl.length - 1]!++;
  else if (st.tpl.length && ch === "}" && st.tpl[st.tpl.length - 1]!-- === 0) st.tpl.pop();
  return i + 1;
}

/**
 * 一行里是注释的列区间。逐字符走：字符串、模板字符串、正则字面量里的 // 和 /* 不是注释；块注释可以在行中间
 * 开始和结束，状态带到下一行。只求分清注释与代码，不是完整的词法分析。
 */
function commentSpans(line: string, st: LexState, lang: Lang): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf("*/", i);
      out.push([i, end < 0 ? line.length : end + 2]);
      if (end < 0) break;
      st.block = false;
      i = end + 2;
    } else if (st.tpl[st.tpl.length - 1] === -1) {
      const expr = line.startsWith("${", i);
      if (line[i] === "`") st.tpl.pop();
      else if (expr) st.tpl.push(0);
      i += expr || line[i] === "\\" ? 2 : 1;
    } else if (line.startsWith("/*", i)) {
      out.push([i, i + 2]);
      st.block = true;
      i += 2;
    } else if (lang.lineComment && line.startsWith("//", i)) {
      out.push([i, line.length]);
      break;
    } else {
      i = skipToken(line, i, st, lang);
    }
  }
  return out;
}

/**
 * 文本出现 vs 调用点：调用点只算代码 / 配置文件里不在注释中的那些；文档、对话记录、注释里的只算文本出现。
 * 每一行都要喂进来（块注释、模板字符串的状态跨行），返回的函数回答这一行某一列是不是调用点。
 */
function makeLineClassifier(file: string): (line: string) => (col: number) => boolean {
  const ext = extname(file).toLowerCase();
  const slash = SLASH_COMMENT_EXT.has(ext);
  const hash = HASH_COMMENT_EXT.has(ext) || !file.split("/").pop()!.includes(".");
  if (!slash && !hash && !DATA_CODE_EXT.has(ext)) return () => () => false;
  if (!slash) {
    return (line) => {
      const code = !hash || !line.trimStart().startsWith("#") || line.startsWith("#!");
      return () => code;
    };
  }
  const lang: Lang = { js: JS_EXT.has(ext), lineComment: ext !== ".css", singleQuote: SINGLE_QUOTE_EXT.has(ext) };
  const st: LexState = { block: false, tpl: [] };
  return (line) => {
    const comments = commentSpans(line, st, lang);
    return (col) => !comments.some(([a, b]) => col >= a && col < b);
  };
}

interface Tally {
  byIdent: Map<string, { text: number; calls: number; files: Set<string> }>;
  allowed: Record<AllowClass, { occurrences: number; files: Set<string> }>;
  mechanical: Map<string, number>;
  failures: Failure[];
  unregistered: number;
  files: number;
}

function tokenAround(line: string, start: number, end: number): string {
  const ok = /[A-Za-z0-9_.:+@/-]/;
  let a = start;
  let b = end;
  while (a > 0 && ok.test(line[a - 1]!)) a--;
  while (b < line.length && ok.test(line[b]!)) b++;
  return line.slice(a, b).slice(0, 120);
}

function scanLine(line: string, lineNo: number, file: string, c: Compiled, fileAllow: AllowEntry | null, isCall: (col: number) => boolean, t: Tally) {
  const hits = spans(c.root, line);
  if (!hits.length) return;
  if (fileAllow) {
    t.allowed[fileAllow.class].occurrences += hits.length;
    t.allowed[fileAllow.class].files.add(file);
    return;
  }
  const claims = claimsOn(line, file, c);
  for (const h of hits) {
    const cl = pickClaim(claims, h.start, h.end);
    const shapes = c.shapes.filter(({ re }) => spans(re, line).some((s) => s.start <= h.start && s.end >= h.end)).map((x) => x.s);
    if (!cl) {
      t.unregistered++;
      const hint = shapes[0] ? `（形状 ${shapes[0].id}，应登记到 ${shapes[0].categories.join(" / ")}）` : "";
      t.failures.push({ kind: "unregistered", detail: `${tokenAround(line, h.start, h.end)}${hint}`, file, line: lineNo });
      continue;
    }
    if (cl.allow) {
      t.allowed[cl.allow.class].occurrences++;
      t.allowed[cl.allow.class].files.add(file);
      continue;
    }
    const it = cl.ident!;
    // 盖住这一处的每条形状都要满足：认领项的类别在 categories 里，或在 literal 里且是逐个点名（members）认领的
    const shape = shapes.find((s) => !s.categories.includes(it.category) && !(s.literal?.includes(it.category) && it.members?.length));
    if (shape) {
      t.unregistered++;
      const detail = `${tokenAround(line, h.start, h.end)} 只被 ${it.id}（${it.category}）兜住，形状 ${shape.id} 要登记到 ${shape.categories.join(" / ")}`;
      t.failures.push({ kind: "shape_unregistered", detail, file, line: lineNo });
      continue;
    }
    const row = t.byIdent.get(it.id) ?? { text: 0, calls: 0, files: new Set<string>() };
    row.text++;
    if (isCall(h.start)) row.calls++;
    row.files.add(file);
    t.byIdent.set(it.id, row);
    if (it.replace === "mechanical") t.mechanical.set(`${file}\n${it.id}`, (t.mechanical.get(`${file}\n${it.id}`) ?? 0) + 1);
  }
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
    scanLine(file, 0, file, c, fileAllow, () => false, t);
    const text = buf.toString("utf8");
    c.root.lastIndex = 0;
    if (!c.root.test(text)) continue;
    const classify = makeLineClassifier(file);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) scanLine(lines[i]!, i + 1, file, c, fileAllow, classify(lines[i]!), t);
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
  const mechanical = [...(t?.mechanical ?? [])].map(([key, occurrences]) => {
    const [file, id] = key.split("\n") as [string, string];
    return { file, id, occurrences };
  });
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
