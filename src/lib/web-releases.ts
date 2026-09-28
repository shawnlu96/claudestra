/**
 * 网页静态包按版本发布：构建产物 web/out 复制进 <状态目录>/web-releases/<id>/，再把 current 符号链接一步换过去。
 * bridge 的 BRIDGE_STATIC_DIR 指向 current，而 bridge 每个请求才按路径读文件、不预先解析链接——所以切换立刻生效、不用重启，
 * `next build` 期间 web/out 被清空重建也不再让线上缺文件（以前构建的一两分钟里页面会打不开）。
 * 已经打开的旧页面还会按需加载旧 chunk：保留最近 KEEP_PREVIOUS 个旧版本，/_next/static/ 在 current 里找不到时
 * 去旧版本里找（fallbackStaticRoots，bridge/web-gateway.ts）；旧版本也是回滚的余地（rollbackWebRelease）。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { mergeEnvContent, readDotenvFileSync } from "./env-file.js";
import { statePath } from "./paths.js";
import { readBuildInfo } from "./static-site.js";

export const RELEASES_DIR = statePath("web-releases");
/** 除 current 之外保留的旧版本个数 */
const KEEP_PREVIOUS = 2;
const CURRENT = "current";
/** 版本目录名：时间戳在前（按名字排序就是时间顺序），webCommit 在后方便人看 */
const ID_RE = /^\d{4}-\d{2}-\d{2}T[\w-]+$/;

export interface PublishResult {
  ok: boolean;
  id?: string;
  error?: string;
  pruned?: string[];
}

export const currentLink = (dir = RELEASES_DIR): string => join(dir, CURRENT);

function releaseId(outDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const commit = readBuildInfo(outDir)?.webCommit;
  return commit && /^[0-9a-f]{7,40}$/i.test(commit) ? `${stamp}_${commit.slice(0, 12)}` : stamp;
}

/** 按时间从新到旧的版本目录名（不含 current 与半成品） */
export function listReleases(dir = RELEASES_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录还没建：没有任何版本
  }
  return names.filter((n) => ID_RE.test(n) && statSync(join(dir, n), { throwIfNoEntry: false })?.isDirectory()).sort().reverse();
}

/** current 指向的版本目录名；没有 current 或它不是符号链接 → null */
export function currentRelease(dir = RELEASES_DIR): string | null {
  const link = currentLink(dir);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return basename(readlinkSync(link));
  } catch {
    return null; // 还没发布过
  }
}

/** 把 current 一步换到 id：先建临时链接再 rename 覆盖（rename 替换符号链接是原子的，不存在「没有 current」的瞬间） */
function switchCurrent(id: string, dir = RELEASES_DIR): void {
  const link = currentLink(dir);
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) throw new Error(`${link} 不是符号链接，不覆盖（手动处理后再发布）`);
  const tmp = join(dir, `.current-${process.pid}-${Date.now()}`);
  symlinkSync(id, tmp); // 相对目标：整个 web-releases 目录搬走也不断
  renameSync(tmp, link);
}

/** 保留 current + 最新的 keep 个旧版本，其余删掉；顺带清理中断留下的半成品。返回删掉的目录名 */
function pruneReleases(dir = RELEASES_DIR, keep = KEEP_PREVIOUS): string[] {
  const cur = currentRelease(dir);
  const stale = listReleases(dir).filter((id) => id !== cur).slice(keep);
  for (const id of stale) rmSync(join(dir, id), { recursive: true, force: true });
  for (const n of readdirSync(dir)) if (n.startsWith(".staging-") || n.startsWith(".current-")) rmSync(join(dir, n), { recursive: true, force: true });
  return stale;
}

/** web/out → 新版本目录 → 切换 current → 清理旧版本。失败时 current 原样不动 */
export function publishWebRelease(outDir: string, opts: { dir?: string; now?: Date } = {}): PublishResult {
  const dir = opts.dir ?? RELEASES_DIR;
  if (!existsSync(join(outDir, "index.html"))) return { ok: false, error: `${outDir} 里没有 index.html，不发布` };
  const id = releaseId(outDir, opts.now ?? new Date());
  const staging = join(dir, `.staging-${id}`);
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(outDir, staging, { recursive: true }); // 不保留 mtime：CSP / build-info 的缓存按 size+mtime 失效，新版本必须算新文件
    if (!existsSync(join(staging, "index.html"))) throw new Error("复制后没有 index.html");
    renameSync(staging, join(dir, id));
    switchCurrent(id, dir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `发布失败（线上仍是 ${currentRelease(dir) ?? "原来的目录"}）：${(e as Error).message}` };
  }
  return { ok: true, id, pruned: pruneReleases(dir) };
}

/** current 退回上一个（更旧的）版本；没有更旧的就不动 */
export function rollbackWebRelease(dir = RELEASES_DIR): { ok: boolean; from?: string | null; to?: string; error?: string } {
  const all = listReleases(dir);
  const from = currentRelease(dir);
  const older = all.slice(from ? all.indexOf(from) + 1 : 0).find((id) => id !== from);
  if (!older) return { ok: false, from, error: "没有更旧的版本可退" };
  switchCurrent(older, dir);
  return { ok: true, from, to: older };
}

/**
 * 静态托管的兜底根目录：rootDir 就是本模块管的 current 时，返回旧版本目录（新到旧）；别的目录（自定义路径、web/out）→ 空。
 * 只给 /_next/static/ 用——那里的文件名带内容哈希，旧页面要的旧 chunk 只可能在旧版本里，拿错版本的风险为零。
 */
export function fallbackStaticRoots(rootDir: string, dir = RELEASES_DIR): string[] {
  if (!rootDir || resolve(rootDir) !== resolve(currentLink(dir))) return [];
  const cur = currentRelease(dir);
  return listReleases(dir).filter((id) => id !== cur).slice(0, KEEP_PREVIOUS).map((id) => join(dir, id));
}

/** .env 的 BRIDGE_STATIC_DIR 已经指向 current（由本模块管）→ 构建成功后要发布 */
export function releasesManaged(envFile: string, dir = RELEASES_DIR): boolean {
  const v = (readDotenvFileSync(envFile)?.BRIDGE_STATIC_DIR ?? "").trim();
  return !!v && resolve(v) === resolve(currentLink(dir));
}

/**
 * install-cli 调（reload bridge 之前）：BRIDGE_STATIC_DIR 还直接指着仓库的 web/out → 先把 web/out 发布成第一个版本，
 * 再把 .env 改指 current；reload 后 bridge 就按版本托管。没托管、指向别处（自定义路径 / 已迁移）→ 不动。返回给用户看的说明
 */
export function migrateStaticDirToReleases(repoRoot: string, opts: { envFile?: string; dir?: string } = {}): string[] {
  const envFile = opts.envFile ?? join(repoRoot, ".env");
  const dir = opts.dir ?? RELEASES_DIR;
  const out = join(repoRoot, "web", "out");
  const v = (readDotenvFileSync(envFile)?.BRIDGE_STATIC_DIR ?? "").trim();
  if (!v || resolve(v) !== resolve(out)) return [];
  const r = publishWebRelease(out, { dir });
  if (!r.ok) return [`网页没改成按版本发布：${r.error}（仍直接托管 web/out，下次 install-cli 再试）`];
  try {
    writeFileSync(envFile, mergeEnvContent(readFileSync(envFile, "utf8"), { BRIDGE_STATIC_DIR: currentLink(dir) }, "# Claudestra"));
  } catch (e) {
    return [`网页没改成按版本发布：写 .env 失败（${(e as Error).message}），仍直接托管 web/out`];
  }
  return [`网页改为按版本发布：BRIDGE_STATIC_DIR 从 web/out 换成 ${currentLink(dir)}，构建期间线上不再缺文件（回滚：改回 ${out} 再重启 bridge）`];
}
