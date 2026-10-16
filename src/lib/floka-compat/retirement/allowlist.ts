/**
 * 兼容允许表（scripts/rename-floka/codemod/compat-allowlist.json）：还在认旧名的入口逐条登记，每条归一个退出项。
 * `retain` 是永不退出的保护名单（身份、peer、token、pin、撤销记录、历史 transcript），按状态目录内的相对 glob 写；
 * 任何可退出条目的文件落进保护名单就整张表作废——收兼容永远不能顺手删到身份和历史。
 * `retired` 是已收掉的条目原样搬过去的位置：留着它，回到旧格式只要把条目搬回 entries。
 */
import { isRetireItem, type RetireItem } from "./items.js";

export class AllowlistError extends Error {}

interface CompatEntry { id: string; item: RetireItem; files: string[]; match: string; reason: string }
interface RetiredEntry extends CompatEntry { retiredAt: number }
export interface RetainEntry { id: string; protects: string[]; reason: string }
export interface CompatAllowlist { format: typeof FORMAT; version: 1; entries: CompatEntry[]; retired: RetiredEntry[]; retain: RetainEntry[] }

const FORMAT = "floka.compat-allowlist";
const ID_RE = /^[a-z][a-z0-9.-]{1,63}$/;
/** 仓库内相对路径：不许绝对路径、.. 段、通配符——一条兼容入口要指到具体文件，不能写成全仓清理 */
const FILE_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function strict(v: unknown, path: string, keys: readonly string[]): Obj {
  if (!isObj(v)) throw new AllowlistError(`${path}: 要是对象`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length) throw new AllowlistError(`${path}: 多余字段 ${extra.join(", ")}`);
  return v;
}

function text(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new AllowlistError(`${path}: 要是非空字符串`);
  return v;
}

function strings(v: unknown, path: string, re?: RegExp): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new AllowlistError(`${path}: 要是非空数组`);
  return v.map((s, i) => {
    const t = text(s, `${path}[${i}]`);
    if (re && !re.test(t)) throw new AllowlistError(`${path}[${i}]: 不是仓库内具体文件路径`);
    return t;
  });
}

function entry(v: unknown, path: string, retired: boolean): CompatEntry | RetiredEntry {
  const keys = ["id", "item", "files", "match", "reason", ...(retired ? ["retiredAt"] : [])];
  const o = strict(v, path, keys);
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new AllowlistError(`${path}.id: 只许 [a-z0-9.-]`);
  if (!isRetireItem(o.item)) throw new AllowlistError(`${path}.item: 不是已知退出项`);
  const match = text(o.match, `${path}.match`);
  try { new RegExp(match); } catch { throw new AllowlistError(`${path}.match: 不是合法正则`); }
  const out: CompatEntry = { id: o.id, item: o.item, files: strings(o.files, `${path}.files`, FILE_RE), match, reason: text(o.reason, `${path}.reason`) };
  if (!retired) return out;
  if (typeof o.retiredAt !== "number" || !Number.isSafeInteger(o.retiredAt) || o.retiredAt <= 0) throw new AllowlistError(`${path}.retiredAt: 要是毫秒时间戳`);
  return { ...out, retiredAt: o.retiredAt };
}

function retain(v: unknown, path: string): RetainEntry {
  const o = strict(v, path, ["id", "protects", "reason"]);
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new AllowlistError(`${path}.id: 只许 [a-z0-9.-]`);
  return { id: o.id, protects: strings(o.protects, `${path}.protects`), reason: text(o.reason, `${path}.reason`) };
}

/** 文件路径（或其中任一段之后的尾部）落进保护 glob：`**\/peers.json` 也挡住 `src/x/peers.json` */
export function protectedBy(file: string, list: readonly RetainEntry[]): string | null {
  for (const r of list) for (const p of r.protects) {
    const g = new Bun.Glob(p);
    if (g.match(file) || (p.startsWith("**/") && new Bun.Glob(p.slice(3)).match(file))) return r.id;
  }
  return null;
}

export function parseAllowlist(textIn: string): CompatAllowlist {
  let raw: unknown;
  try { raw = JSON.parse(textIn); } catch { throw new AllowlistError("允许表不是合法 JSON"); }
  const o = strict(raw, "allowlist", ["format", "version", "entries", "retired", "retain"]);
  if (o.format !== FORMAT || o.version !== 1) throw new AllowlistError(`allowlist: format 要是 ${FORMAT}、version 要是 1`);
  const list = (v: unknown, p: string): unknown[] => { if (!Array.isArray(v)) throw new AllowlistError(`${p}: 要是数组`); return v; };
  const entries = list(o.entries, "entries").map((e, i) => entry(e, `entries[${i}]`, false));
  const retired = list(o.retired ?? [], "retired").map((e, i) => entry(e, `retired[${i}]`, true) as RetiredEntry);
  const keep = list(o.retain, "retain").map((r, i) => retain(r, `retain[${i}]`));
  if (keep.length === 0) throw new AllowlistError("retain: 保护名单不能为空");
  const seen = new Set<string>();
  for (const { id } of [...entries, ...retired, ...keep]) {
    if (seen.has(id)) throw new AllowlistError(`id 重复：${id}`);
    seen.add(id);
  }
  for (const e of [...entries, ...retired]) for (const f of e.files) {
    const hit = protectedBy(f, keep);
    if (hit) throw new AllowlistError(`${e.id}: 文件 ${f} 受 ${hit} 保护，不能归到可退出项`);
  }
  return { format: FORMAT, version: 1, entries, retired, retain: keep };
}

/** 收掉若干项：条目原样搬进 retired（带时刻），保护名单与其他项一字不动 */
export function retireItems(list: CompatAllowlist, items: ReadonlySet<RetireItem>, at: number): CompatAllowlist {
  const moving = list.entries.filter((e) => items.has(e.item));
  return {
    ...list,
    entries: list.entries.filter((e) => !items.has(e.item)),
    retired: [...list.retired, ...moving.map((e) => ({ ...e, retiredAt: at }))],
  };
}
