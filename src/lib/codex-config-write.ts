/**
 * 改 ~/.codex/config.toml 顶层（第一个 [表] 之前）的 `model` / `model_reasoning_effort`，给网页「Codex 全局默认」用。
 *
 * 只动这两行：别的表、注释、空行、顺序逐字保留（用户手写的 mcp_servers / profiles 都在这个文件里）。
 * 不引 TOML 库：解析再序列化会丢注释、改格式。这里只做一个够用的行扫描——认得字符串（含多行）、
 * 注释和跨行数组，免得把多行字符串 / 嵌套数组里以 `[` 开头的行当成表头。纯函数单测：tests/codex-config-write.test.ts。
 */
import { copyFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeTextAtomicSync } from "./state-file.js";

export type CodexDefaultsPatch = { model?: string | null; effort?: string | null };

const KEYS = { model: "model", effort: "model_reasoning_effort" } as const;
const KEY_RE = /^\s*(?:(model|model_reasoning_effort)|"(model|model_reasoning_effort)"|'(model|model_reasoning_effort)')\s*=/;

/** TOML basic string：反斜杠、引号、控制字符都转义 */
export function tomlBasicString(s: string): string {
  const esc: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
  return `"${s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => esc[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** depth = 未闭合的 [ / { 层数（跨行数组、内联表） */
type ScanState = { ml: '"""' | "'''" | null; depth: number };

/** 扫一行，更新跨行状态（多行字符串、数组深度）；返回这行的注释起点（没有为 -1） */
function scanLine(line: string, st: ScanState): number {
  let i = 0;
  while (i < line.length) {
    if (st.ml) {
      const end = line.indexOf(st.ml, i);
      if (end < 0) return -1;
      // 多行 basic 字符串里 \""" 不算结束
      if (st.ml === '"""' && isEscaped(line, end)) { i = end + 1; continue; }
      i = end + 3;
      while (line[i] === st.ml[0]) i++; // """" 结尾时多出来的引号属于内容
      st.ml = null;
      continue;
    }
    const c = line[i];
    if (c === "#") return i;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { st.ml = line.slice(i, i + 3) as ScanState["ml"]; i += 3; continue; }
    if (c === '"' || c === "'") { i = skipString(line, i); continue; }
    if (c === "[" || c === "{") st.depth++;
    else if (c === "]" || c === "}") st.depth = Math.max(0, st.depth - 1);
    i++;
  }
  return -1;
}

function isEscaped(line: string, at: number): boolean {
  let n = 0;
  for (let j = at - 1; j >= 0 && line[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

function skipString(line: string, start: number): number {
  const q = line[start];
  for (let j = start + 1; j < line.length; j++) {
    if (line[j] === q && (q === "'" || !isEscaped(line, j))) return j + 1;
  }
  return line.length;
}

interface Entry { key: "model" | "effort"; start: number; end: number; comment: string }

/** 顶层结构：两个键各自占哪几行、最后一个顶层键值对结束在哪、第一个表头在哪 */
function scanTopLevel(lines: string[]): { entries: Entry[]; lastEntryEnd: number; header: number } {
  const st: ScanState = { ml: null, depth: 0 };
  const entries: Entry[] = [];
  let lastEntryEnd = -1;
  let open: { key: Entry["key"] | null; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const neutral = !st.ml && st.depth === 0;
    if (neutral && /^\s*\[/.test(line)) return { entries, lastEntryEnd, header: i };
    if (neutral && /^\s*[^\s#]/.test(line)) {
      const m = KEY_RE.exec(line);
      const name = m ? (m[1] ?? m[2] ?? m[3]) : null;
      open = { key: name === KEYS.model ? "model" : name === KEYS.effort ? "effort" : null, start: i };
    }
    const commentAt = scanLine(line, st);
    if (open && !st.ml && st.depth === 0) {
      if (open.key) entries.push({ key: open.key, start: open.start, end: i, comment: commentAt >= 0 ? line.slice(commentAt) : "" });
      lastEntryEnd = i;
      open = null;
    }
  }
  return { entries, lastEntryEnd, header: -1 };
}

/**
 * 读顶层两项（与 applyCodexDefaults 同一个扫描器）。catalog 的 parseCodexConfigDefaults 遇到多行字符串里以 [ 开头的行
 * 会提前停，设置页读写要对得上，所以这里另读一份。值不是字符串（写坏了）按没写算。
 */
export function readCodexDefaultsToml(toml: string): { model: string | null; effort: string | null } {
  const lines = toml.split(/\r?\n/);
  const out = { model: null as string | null, effort: null as string | null };
  for (const e of scanTopLevel(lines).entries) {
    if (out[e.key] !== null) continue;
    const rhs = lines[e.start].slice(lines[e.start].indexOf("=") + 1).trimStart();
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rhs);
    const literal = /^'([^']*)'/.exec(rhs);
    const v = basic ? unescapeBasic(basic[1]) : literal ? literal[1] : null;
    out[e.key] = v || null;
  }
  return out;
}

function unescapeBasic(s: string): string {
  const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c: string) => {
    if (c.length === 1) return map[c] ?? c;
    const n = parseInt(c.slice(1), 16);
    return n <= 0x10ffff ? String.fromCodePoint(n) : c; // 超出 Unicode 的码点 fromCodePoint 会抛
  });
}

/**
 * 纯函数：按 patch 改顶层两行。undefined = 不动；null / "" = 删掉那行（回到 Codex 自己的默认）；其余 = 设成这个值。
 * 已有 → 原地替换（行尾注释保留）；没有 → 加在最后一个顶层键值对后面（都没有就加在文件开头），总之在第一个 [表] 之前；
 * 文件里没有任何表 → 追加到末尾。
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
    mine.forEach((e, n) => replace.set(e.start, { end: e.end, text: v && n === 0 ? text(e.comment) : null })); // 重复键（本来就非法）只留第一处
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

export const codexConfigPath = (home: string) => join(home, ".codex", "config.toml");

const KEEP_BACKUPS = 5;
export type CodexConfigWriter = typeof writeTextAtomicSync;

/**
 * 读 → 改 → 备份 → 原子写（tmp + rename，保留原权限）。返回写后的文本和备份路径（文件原来不存在 / 没变化时没有备份）。
 * rename 前再读一次原文件：这中间被别人（Codex 自己会往里写 [projects.*]）改过就不提交，抛错让调用方重试，免得盖掉别人的改动。
 */
export function writeCodexDefaults(
  home: string,
  patch: CodexDefaultsPatch,
  opts: { now?: Date; write?: CodexConfigWriter } = {},
): { text: string; backup: string | null; changed: boolean } {
  const path = codexConfigPath(home);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const text = applyCodexDefaults(before ?? "", patch);
  if (text === (before ?? "")) return { text, backup: null, changed: false };
  let backup: string | null = null;
  if (before !== null) {
    backup = `${path}.bak-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    chmodSync(backup, statSync(path).mode & 0o777);
    pruneBackups(path);
  }
  (opts.write ?? writeTextAtomicSync)(path, text, {
    preserveMode: true,
    mode: 0o600,
    commitIf: () => (existsSync(path) ? readFileSync(path, "utf8") : null) === before,
  });
  return { text, backup, changed: true };
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
