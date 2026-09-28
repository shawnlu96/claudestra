/**
 * 媒体索引的「文件在哪」：把历史里的附件引用解析成白名单目录里的一个具体文件，并在取文件时再核一遍。
 *
 * 存进索引的不是绝对路径，而是 `u:<日期>/<名>`（旧 web 上传目录）或 `i<k>:<名>`（第 k 个 inbox 目录）这种定位串；
 * 取文件时从固定目录重新拼、名字重新校验、拒符号链接、realpath 必须仍在该目录里——索引库被人改了也拼不出目录外的路径。
 * 出站附件在记录里只有 agent 本地路径，bridge 投递时拷进 inbox 成 `<毫秒>_<清洗名>`：按清洗名 + 消息时间窗找副本，
 * 窗内多于一个（内容不同）就标 ambiguous，调用方据此只给 manage 看（tests/media-store.test.ts）。
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentMime, type AttachmentDirs } from "./attachment-lookup.js";
import { sanitizeAttachmentBase } from "./attachment-name.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 出站副本相对消息时间的认领窗口：拷贝在 reply 调用后几秒内发生，往前留 10s 时钟误差，往后给 10 分钟慢投递 */
const OUT_WINDOW_BEFORE_MS = 10_000;
const OUT_WINDOW_AFTER_MS = 10 * 60_000;

export interface Resolved {
  loc: string;
  name: string;
  size: number;
  mime: string;
  ambiguous: boolean;
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
    const hit = DATE_RE.test(u[1]) ? regularFileIn(join(dirs.uploadDir, u[1]), u[2]) : null;
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

function resolved(loc: string, name: string, size: number, ambiguous = false): Resolved {
  return { loc, name, size, mime: attachmentMime(name), ambiguous };
}

/** 入站引用：记录里就是落盘路径。优先按原目录认，目录不在白名单（沙箱 / 旧版状态目录）再按名字在白名单里找。 */
export function resolveInbound(path: string, dirs: AttachmentDirs): Resolved | null {
  const name = safeName(basename(path));
  if (!name) return null;
  const parent = resolve(dirname(path));
  const day = /\/web\/uploads\/(\d{4}-\d{2}-\d{2})$/.exec(parent)?.[1];
  const tries: { loc: string; dir: string }[] = [];
  if (day) tries.push({ loc: `u:${day}/${name}`, dir: join(dirs.uploadDir, day) });
  dirs.inboxDirs.forEach((d, k) => tries.push({ loc: `i${k}:${name}`, dir: d }));
  // 原目录命中的排前面
  tries.sort((a, b) => Number(resolve(b.dir) === parent) - Number(resolve(a.dir) === parent));
  for (const t of tries) {
    const hit = regularFileIn(t.dir, name);
    if (hit) return resolved(t.loc, name, hit.size);
  }
  return null;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([Bun.file(a).bytes(), Bun.file(b).bytes()]);
  return x.length === y.length && Buffer.compare(x, y) === 0;
}

/** 出站引用：清洗名相同、毫秒前缀落在消息时间窗里的 inbox 副本。窗里只有一份（或几份字节相同）才算认准。 */
export async function resolveOutbound(path: string, ts: string | null, dirs: AttachmentDirs, cat: InboxCatalog): Promise<Resolved | null> {
  const all = cat.outByBase.get(sanitizeAttachmentBase(path)) ?? [];
  const t = ts ? Date.parse(ts) : NaN;
  const inWin = Number.isFinite(t) ? all.filter((c) => c.ms >= t - OUT_WINDOW_BEFORE_MS && c.ms <= t + OUT_WINDOW_AFTER_MS) : all;
  const files = inWin
    .map((c) => ({ c, hit: regularFileIn(dirs.inboxDirs[c.k], c.name) }))
    .filter((x): x is { c: (typeof inWin)[number]; hit: { abs: string; size: number } } => !!x.hit)
    .sort((a, b) => Math.abs(a.c.ms - t) - Math.abs(b.c.ms - t) || a.c.ms - b.c.ms);
  if (!files.length) return null;
  const first = files[0];
  let ambiguous = false;
  for (const other of files.slice(1)) {
    // 一次回复投到多个前端会各拷一份：字节相同的不算歧义
    if (other.hit.size !== first.hit.size || !(await sameBytes(first.hit.abs, other.hit.abs))) {
      ambiguous = true;
      break;
    }
  }
  return resolved(`i${first.c.k}:${first.c.name}`, first.c.name, first.hit.size, ambiguous);
}

/** 展示名：去掉落盘时加的前缀（毫秒 / 雪花 id / api_毫秒 / uuid8） */
export function displayName(stored: string): string {
  return stored.replace(/^api_\d+_/, "").replace(/^\d+_/, "").replace(/^[0-9a-f]{8}-/, "");
}
