/**
 * 媒体索引的「文件在哪」：把历史里的附件引用解析成白名单目录里的一个具体文件，并在取文件时再核一遍。
 *
 * 存进索引的不是绝对路径，而是 `u:<日期>/<名>`（旧 web 上传目录）或 `i<k>:<名>`（第 k 个 inbox 目录）这种定位串；
 * 取文件时从固定目录重新拼、名字重新校验、拒符号链接、realpath 必须仍在该目录里——索引库被人改了也拼不出目录外的路径。
 * 入站只认记录里写明的目录（必须正好是白名单目录），不按名字到别处兜底：否则正文里手写一个别人文件的名字就能认领它。
 * 出站先查副本账本（media-outbound.ts）；没账的老副本按清洗名 + 时间窗猜，猜出来的一律 trusted=false（tests/media-store.test.ts）。
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentMime, uploadDayDir, type AttachmentDirs } from "./attachment-lookup.js";
import { sanitizeAttachmentBase } from "./attachment-name.js";
import { OUT_WINDOW_AFTER_MS, OUT_WINDOW_BEFORE_MS } from "./media-outbound.js";

export interface Resolved {
  loc: string;
  name: string;
  size: number;
  mime: string;
  ambiguous: boolean;
  /** 绑定可信：入站来自 bridge 写的头属性且目录对得上；出站有账。不可信的只给 manage */
  trusted: boolean;
}

/** 目录里的普通文件名（安全的 basename）；非法名返回 null */
export function safeName(name: string): string | null {
  if (!name || name !== basename(name) || name.startsWith(".") || /[\\/\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

/** 目录下这个名字是普通文件（不是链接、没跑出目录）→ { abs, size }；否则 null */
function regularFileIn(dir: string, name: string): { abs: string; size: number } | null {
  if (!safeName(name)) return null;
  const abs = join(dir, name);
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return null; // 符号链接 lstat 出来不是 file，一并拒掉
    const realDir = realpathSync(dir);
    if (realpathSync(abs) !== join(realDir, name)) return null;
    return { abs, size: st.size };
  } catch {
    return null; // 不存在 / 无权限：当作找不到
  }
}

/** 定位串 → 绝对路径（取文件时用）；格式不对、目录外、不是普通文件 → null */
export function openLoc(loc: string, dirs: AttachmentDirs): { abs: string; size: number; name: string } | null {
  const u = /^u:(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(loc);
  if (u) {
    const day = uploadDayDir(dirs.uploadDir, u[1]);
    const hit = day ? regularFileIn(day, u[2]) : null;
    return hit ? { ...hit, name: u[2] } : null;
  }
  const i = /^i(\d{1,2}):([^/]+)$/.exec(loc);
  const dir = i ? dirs.inboxDirs[Number(i[1])] : undefined;
  const hit = i && dir ? regularFileIn(dir, i[2]) : null;
  return hit && i ? { ...hit, name: i[2] } : null;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // 目录还没建 = 没有文件
  }
}

/** 一次刷新用的 inbox 快照：出站副本按清洗名分组，免得每个引用都 readdir 一遍 */
export interface InboxCatalog {
  outByBase: Map<string, { k: number; name: string; ms: number }[]>;
}

export function buildInboxCatalog(dirs: AttachmentDirs): InboxCatalog {
  const outByBase = new Map<string, { k: number; name: string; ms: number }[]>();
  dirs.inboxDirs.forEach((dir, k) => {
    for (const name of listDir(dir)) {
      // 13 位毫秒前缀才是出站副本；Discord 下载是 17~20 位雪花 id，web 上传是 api_ 前缀，都不参与
      const m = /^(\d{13})_(.+)$/.exec(name);
      if (!m) continue;
      const arr = outByBase.get(m[2]) ?? [];
      arr.push({ k, name, ms: Number(m[1]) });
      outByBase.set(m[2], arr);
    }
  });
  return { outByBase };
}

function resolved(loc: string, name: string, size: number, trusted: boolean, ambiguous = false): Resolved {
  return { loc, name, size, mime: attachmentMime(name), ambiguous, trusted };
}

function realDir(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null; // 目录不存在：不可能是白名单目录
  }
}

/** 入站引用：记录里就是落盘路径，它的父目录必须正好是某个白名单目录（realpath 比），名字只在那一个目录里找 */
export function resolveInbound(path: string, dirs: AttachmentDirs, trusted: boolean): Resolved | null {
  const name = safeName(basename(path));
  const parent = name ? realDir(dirname(resolve(path))) : null;
  if (!name || !parent) return null;
  const day = basename(parent);
  if (parent === uploadDayDir(dirs.uploadDir, day)) {
    const hit = regularFileIn(parent, name);
    return hit ? resolved(`u:${day}/${name}`, name, hit.size, trusted) : null;
  }
  const k = dirs.inboxDirs.findIndex((d) => realDir(d) === parent);
  const hit = k >= 0 ? regularFileIn(dirs.inboxDirs[k], name) : null;
  return hit ? resolved(`i${k}:${name}`, name, hit.size, trusted) : null;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([Bun.file(a).bytes(), Bun.file(b).bytes()]);
  return x.length === y.length && Buffer.compare(x, y) === 0;
}

/** 出站副本的账本查询（media-outbound.ts 的 ledgerCopy / ownedByOther 绑上库与 agent） */
export interface OutboundLedger {
  copyFor(src: string, tsMs: number): string | null;
  ownedByOther(dest: string): boolean;
  /** 别的 agent 在这个时间窗里也发过同名文件（按名字猜会猜串） */
  othersSentSameName(base: string, tsMs: number): boolean;
}

/**
 * 出站引用：先查账（同 agent、同原路径、时间对得上 → 可信）；没账按清洗名 + 时间窗猜：
 * 只要消息之后（留时钟误差）拷进来的、不在别人账上的副本；窗里内容不同的多份、或别的 agent 同窗发过同名 → ambiguous。
 */
export async function resolveOutbound(path: string, ts: string | null, dirs: AttachmentDirs, cat: InboxCatalog, ledger: OutboundLedger): Promise<Resolved | null> {
  const t = ts ? Date.parse(ts) : NaN;
  const booked = Number.isFinite(t) ? ledger.copyFor(path, t) : null;
  const bookedHit = booked ? regularFileIn(dirs.inboxDirs[0], booked) : null;
  if (booked && bookedHit) return resolved(`i0:${booked}`, booked, bookedHit.size, true);
  if (!Number.isFinite(t)) return null; // 没时间就没法猜
  const base = sanitizeAttachmentBase(path);
  const inWin = (cat.outByBase.get(base) ?? []).filter((c) => c.ms >= t - OUT_WINDOW_BEFORE_MS && c.ms <= t + OUT_WINDOW_AFTER_MS && !(c.k === 0 && ledger.ownedByOther(c.name)));
  const files = inWin
    .map((c) => ({ c, hit: regularFileIn(dirs.inboxDirs[c.k], c.name) }))
    .filter((x): x is { c: (typeof inWin)[number]; hit: { abs: string; size: number } } => !!x.hit)
    .sort((a, b) => a.c.ms - b.c.ms);
  if (!files.length) return null;
  const first = files[0];
  let ambiguous = ledger.othersSentSameName(base, t);
  for (const other of files.slice(1)) {
    if (ambiguous) break;
    // 一次回复投到多个前端会各拷一份：字节相同的不算歧义
    ambiguous = other.hit.size !== first.hit.size || !(await sameBytes(first.hit.abs, other.hit.abs));
  }
  return resolved(`i${first.c.k}:${first.c.name}`, first.c.name, first.hit.size, false, ambiguous);
}

/**
 * 展示名：去掉落盘时加的前缀，只剥一层（api_毫秒_ / 毫秒或雪花 id_ / 旧上传目录的 uuid8-）。
 * uuid 规则只对旧上传目录用，否则 20240928- 这种日期前缀会被当成 uuid 吃掉。
 */
export function displayName(stored: string, fromUploads: boolean): string {
  return fromUploads ? stored.replace(/^[0-9a-f]{8}-/, "") : stored.replace(/^(?:api_)?\d+_/, "");
}
