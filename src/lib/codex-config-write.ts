/**
 * 改 ~/.codex/config.toml 顶层（第一个 [表] 之前）的 `model` / `model_reasoning_effort`，给网页「Codex 全局默认」用。
 *
 * 只动这两行：别的表、注释、空行、顺序逐字保留（用户手写的 mcp_servers / profiles 都在这个文件里）。
 * 不用 TOML 库重写：解析再序列化会丢注释、改格式。这里是一个够用的行扫描——认得各种字符串（含多行）、带转义的
 * 引号键名、注释和跨行数组 / 内联表；认不出的写法一律拒写（CodexConfigError unsupported）。写盘前用 Bun.TOML.parse
 * 核对新文本「除这两项外结构不变」；提交之后不回滚（见 checkWritten）。纯函数单测：tests/codex-config-write.test.ts。
 */
import { copyFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeTextAtomicSync } from "./state-file.js";

export type CodexDefaultsPatch = { model?: string | null; effort?: string | null };
type Key = "model" | "effort";

const KEYS = { model: "model", effort: "model_reasoning_effort" } as const;

/** unsupported = 文件里有认不出 / 改不安全的写法（调用方回 4xx，文件不动）；conflict = 校验之后文件被别人改了 */
export class CodexConfigError extends Error {
  constructor(message: string, readonly code: "unsupported" | "conflict") {
    super(message);
    this.name = "CodexConfigError";
  }
}
const unsupported = (why: string) => new CodexConfigError(`config.toml ${why}，没有改动`, "unsupported");

/** TOML basic string：反斜杠、引号、控制字符都转义 */
export function tomlBasicString(s: string): string {
  const esc: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
  return `"${s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => esc[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** basic string 的转义（多行 basic 里行尾反斜杠连同后面的空白换行一起去掉）；从左到右一遍，`\\` 先被吃掉不会误判 */
function unescapeBasic(s: string): string {
  const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  return s.replace(/\\([ \t]*\r?\n\s*|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c: string) => {
    if (/^[ \t]*\r?\n/.test(c)) return "";
    if (c.length === 1) {
      if (!(c in map)) throw unsupported(`里有非法转义 \\${c}`);
      return map[c];
    }
    const n = parseInt(c.slice(1), 16);
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw unsupported(`里有非法 Unicode 转义 \\${c}`);
    return String.fromCodePoint(n);
  });
}

function isEscaped(s: string, at: number): boolean {
  let n = 0;
  for (let j = at - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/** 单行字符串的结束位置（闭合引号之后）；没闭合返回 -1 */
function stringEnd(s: string, start: number): number {
  const q = s[start];
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] === "\n") return -1;
    if (s[j] === q && (q === "'" || !isEscaped(s, j))) return j + 1;
  }
  return -1;
}

/** 多行字符串的结束位置（闭合 `"""` / `'''` 之后；结尾多出的一两个引号属于内容）；没闭合返回 -1 */
function multiEnd(s: string, start: number, q: '"""' | "'''"): number {
  let at = s.indexOf(q, start);
  while (at >= 0 && q === '"""' && isEscaped(s, at)) at = s.indexOf(q, at + 1);
  if (at < 0) return -1;
  let end = at + 3;
  for (let k = 0; k < 2 && s[end] === q[0]; k++) end++;
  return end;
}

/** depth = 未闭合的 [ / { 层数（跨行数组、内联表） */
type ScanState = { ml: '"""' | "'''" | null; depth: number };

/** 扫一行，更新跨行状态（多行字符串、数组深度）；返回这行的注释起点（没有为 -1）。字符串没闭合 = 认不出 */
function scanLine(line: string, st: ScanState): number {
  let i = 0;
  while (i < line.length) {
    if (st.ml) {
      const end = multiEnd(line, i, st.ml);
      if (end < 0) return -1;
      i = end;
      st.ml = null;
      continue;
    }
    const c = line[i];
    if (c === "#") return i;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { st.ml = line.slice(i, i + 3) as ScanState["ml"]; i += 3; continue; }
    if (c === '"' || c === "'") {
      i = stringEnd(line, i);
      if (i < 0) throw unsupported("里有没闭合的字符串");
      continue;
    }
    if (c === "[" || c === "{") st.depth++;
    else if (c === "]" || c === "}") st.depth = Math.max(0, st.depth - 1);
    i++;
  }
  return -1;
}

/** 键值对行开头的键：只认单段键（裸键 / 解码后的引号键）；点号键返回 dotted（首段是这两个键之一时改不安全） */
function keyAt(line: string): { name: string; dotted: boolean; valueAt: number } | null {
  const lead = line.length - line.trimStart().length;
  let i = lead;
  const segs: string[] = [];
  for (;;) {
    const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
    if (bare) { segs.push(bare[0]); i += bare[0].length; }
    else if (line[i] === '"' || line[i] === "'") {
      const end = stringEnd(line, i);
      if (end < 0) return null;
      segs.push(line[i] === '"' ? unescapeBasic(line.slice(i + 1, end - 1)) : line.slice(i + 1, end - 1));
      i = end;
    } else return null;
    while (line[i] === " " || line[i] === "\t") i++;
    if (line[i] === ".") { i++; while (line[i] === " " || line[i] === "\t") i++; continue; }
    if (line[i] !== "=") return null;
    return { name: segs[0], dotted: segs.length > 1, valueAt: i + 1 };
  }
}

interface Entry { key: Key; start: number; end: number; valueAt: number; comment: string }

const keyOf = (name: string): Key | null => (name === KEYS.model ? "model" : name === KEYS.effort ? "effort" : null);

/** 顶层结构：两个键各自占哪几行、最后一个顶层键值对结束在哪、第一个表头在哪 */
function scanTopLevel(lines: string[]): { entries: Entry[]; lastEntryEnd: number; header: number } {
  const st: ScanState = { ml: null, depth: 0 };
  const entries: Entry[] = [];
  let lastEntryEnd = -1;
  let open: { key: Key | null; start: number; valueAt: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open && !st.ml && st.depth === 0) {
      if (/^\s*\[/.test(line)) return { entries, lastEntryEnd, header: i };
      if (/^\s*[^\s#]/.test(line)) {
        const k = keyAt(line);
        if (!k) throw unsupported(`第 ${i + 1} 行认不出`);
        const key = keyOf(k.name);
        if (key && k.dotted) throw unsupported(`第 ${i + 1} 行把 ${k.name} 写成了点号键`);
        open = { key, start: i, valueAt: k.valueAt };
      }
    }
    const commentAt = scanLine(line, st);
    if (open && !st.ml && st.depth === 0) {
      if (open.key) entries.push({ key: open.key, start: open.start, end: i, valueAt: open.valueAt, comment: commentAt >= 0 ? line.slice(commentAt) : "" });
      lastEntryEnd = i;
      open = null;
    }
  }
  if (st.ml || st.depth) throw unsupported("结尾有没闭合的字符串或数组");
  return { entries, lastEntryEnd, header: -1 };
}

/** 一个值（`=` 之后到这一项结束的原文）解成字符串；不是字符串返回 undefined */
function decodeString(src: string): string | undefined {
  const s = src.trimStart();
  const strip1 = (b: string) => b.replace(/^\r?\n/, ""); // 多行字符串紧跟开头引号的换行不算内容
  if (s.startsWith('"""') || s.startsWith("'''")) {
    const q = s.slice(0, 3) as '"""' | "'''";
    const end = multiEnd(s, 3, q);
    if (end < 0) return undefined;
    const body = strip1(s.slice(3, end - 3));
    return q === '"""' ? unescapeBasic(body) : body;
  }
  if (s[0] === '"' || s[0] === "'") {
    const end = stringEnd(s, 0);
    if (end < 0) return undefined;
    return s[0] === '"' ? unescapeBasic(s.slice(1, end - 1)) : s.slice(1, end - 1);
  }
  return undefined;
}

/**
 * 读顶层两项：设置页和 codex-catalog（agent 列表 / 会话设置）共用这一个，两边读出来必须一致。
 * 键在但值不是字符串（Codex 自己也读不了）= 认不出，抛 unsupported。
 */
export function readCodexDefaultsToml(toml: string): { model: string | null; effort: string | null } {
  const lines = toml.split(/\r?\n/);
  const out = { model: null as string | null, effort: null as string | null };
  for (const e of scanTopLevel(lines).entries) {
    const v = decodeString(lines.slice(e.start, e.end + 1).join("\n").slice(e.valueAt));
    if (v === undefined) throw unsupported(`里 ${KEYS[e.key]} 的值不是字符串`);
    out[e.key] ??= v || null;
  }
  return out;
}

/**
 * 纯函数：按 patch 改顶层两行。undefined = 不动；null / "" = 删掉那行（回到 Codex 自己的默认）；其余 = 设成这个值。
 * 已有 → 原地替换（行尾注释保留；重复键本来就非法，只留第一处）；没有 → 加在最后一个顶层键值对后面
 * （都没有就加在文件开头），总之在第一个 [表] 之前；文件里没有任何表 → 追加到末尾。
 */
export function applyCodexDefaults(toml: string, patch: CodexDefaultsPatch): string {
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const lines = toml.split(eol);
  const { entries, lastEntryEnd, header } = scanTopLevel(lines);
  const replace = new Map<number, { end: number; text: string | null }>();
  const inserts: string[] = [];
  for (const key of ["model", "effort"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    const text = (comment: string) => `${KEYS[key]} = ${tomlBasicString(v as string)}${comment ? ` ${comment}` : ""}`;
    const mine = entries.filter((e) => e.key === key);
    mine.forEach((e, n) => replace.set(e.start, { end: e.end, text: v && n === 0 ? text(e.comment) : null }));
    if (v && !mine.length) inserts.push(text(""));
  }
  const out: string[] = [];
  const insertAt = header < 0 ? -1 : lastEntryEnd >= 0 ? lastEntryEnd + 1 : 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) out.push(...inserts);
    const r = replace.get(i);
    if (!r) { out.push(lines[i]); continue; }
    if (r.text !== null) out.push(r.text);
    i = r.end;
  }
  if (insertAt < 0 && inserts.length) {
    // 末尾追加：原文以换行结尾时 split 出来最后是空串，插在它前面保持「以换行结尾」
    const tail = out.length && out[out.length - 1] === "" ? out.pop() : undefined;
    out.push(...inserts);
    if (tail !== undefined || toml === "") out.push("");
  }
  return out.join(eol);
}

function parseToml(text: string, what: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw unsupported(`${what}解析不了（${(e as Error).message}）`);
  }
}

/**
 * 用 Bun.TOML.parse 核对改动：除这两个键外结构完全一样，这两个键是 patch 要的值（没给的不变）。
 * 扫描器有没认出来的写法（比如漏认了一个同名键）会在这里变成解析失败或结构不同，拒写。
 * Bun.TOML 对非法转义宽松（"\q" 读成 q），所以两边先过一遍本模块的严格解码。
 */
export function verifyCodexDefaults(before: string, after: string, patch: CodexDefaultsPatch): void {
  readCodexDefaultsToml(before);
  readCodexDefaultsToml(after);
  const b = parseToml(before, "");
  const a = parseToml(after, "改完后");
  const rest = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== KEYS.model && k !== KEYS.effort));
  for (const key of ["model", "effort"] as const) {
    const want = patch[key] === undefined ? b[KEYS[key]] : patch[key] || undefined;
    if (!Bun.deepEquals(a[KEYS[key]], want)) throw unsupported(`改完后 ${KEYS[key]} 对不上`);
  }
  if (!Bun.deepEquals(rest(a), rest(b))) throw unsupported("改完后其它内容变了");
}

export const codexConfigPath = (home: string) => join(home, ".codex", "config.toml");
const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

const KEEP_BACKUPS = 5;
export type CodexConfigWriter = typeof writeTextAtomicSync;

/**
 * 读 → 改 → 核对（只对内存里的新文本）→ 备份 → 原子写（tmp + rename，保留原权限）→ 读回，提交之后不回滚。
 * opts.before = 调用方校验时用的那份原文（null = 文件不存在）：磁盘上的和它不一样就 conflict，rename 前再核一次——
 * 校验和提交必须基于同一份快照，否则两个请求交错会写出目录不支持的组合（tests/codex-defaults.test.ts 并发用例）。
 */
export function writeCodexDefaults(
  home: string,
  patch: CodexDefaultsPatch,
  opts: { before?: string | null; now?: Date; write?: CodexConfigWriter } = {},
): { text: string; backup: string | null; changed: boolean } {
  const path = codexConfigPath(home);
  const before = opts.before === undefined ? readOrNull(path) : opts.before;
  const conflict = () => new CodexConfigError("config.toml 刚被别处改过，没有改动，请刷新后重试", "conflict");
  if (readOrNull(path) !== before) throw conflict();
  const text = applyCodexDefaults(before ?? "", patch);
  if (text === (before ?? "")) return { text, backup: null, changed: false };
  verifyCodexDefaults(before ?? "", text, patch);
  let backup: string | null = null;
  if (before !== null) {
    backup = `${path}.bak-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    chmodSync(backup, statSync(path).mode & 0o777);
    pruneBackups(path);
  }
  const write = opts.write ?? writeTextAtomicSync;
  let raced = false;
  try {
    write(path, text, { preserveMode: true, mode: 0o600, commitIf: () => !(raced = readOrNull(path) !== before) });
  } catch (e) {
    throw raced ? conflict() : e;
  }
  checkWritten(path, text);
  return { text, backup, changed: true };
}

/**
 * 写后读回：和刚写的不一样 = rename 之后有别人（Codex 自己会写 [projects.*]）合法地改了它。磁盘上的内容一律保留——
 * 不回滚、不删、不再覆盖（回滚会把别人的改动冲掉），报 conflict 让页面刷新重试。tests/codex-defaults.test.ts「rename 之后」用例。
 */
function checkWritten(path: string, text: string): void {
  if (readOrNull(path) !== text) throw new CodexConfigError("config.toml 写入后又被别处改过，已保留磁盘上的内容，请刷新后核对", "conflict");
}

/** 每次保存都备份一份，只留最近 KEEP_BACKUPS 份（文件名带 ISO 时间，字典序即时间序） */
function pruneBackups(path: string): void {
  const prefix = `${basename(path)}.bak-`;
  const dir = dirname(path);
  const olds = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().slice(0, -KEEP_BACKUPS);
  for (const f of olds) {
    try { unlinkSync(join(dir, f)); } catch (e) { console.warn(`[codex-config] 清理旧备份失败 ${f}: ${(e as Error).message}`); }
  }
}
