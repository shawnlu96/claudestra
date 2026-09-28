/**
 * 网页静态包按版本发布：构建产物 web/out 复制进 <状态目录>/web-releases/<id>/，再把 current 符号链接一步换过去。
 * bridge 的 BRIDGE_STATIC_DIR 指向 current，`next build` 期间 web/out 被清空重建也不再让线上缺文件。
 * 每个请求先把 current 钉成具体版本目录（pinnedStaticRoot）：路径解析、CSP、正文都读同一份不可变目录——否则
 * CSP 按旧 HTML 算、正文延后读到新 HTML，页面脚本被自己的 CSP 拦掉（codex 复核实测）。
 * 保留 current + KEEP_PREVIOUS 个旧版本：已打开的旧页面要的旧 chunk 去旧版本找（fallbackStaticRoots），也是回滚余地；
 * 一个页面开着期间又连发了 KEEP_PREVIOUS+1 次，它的旧 chunk 就没了（刷新即可），这是有意的保留窗口。
 * 这里的函数都不加锁：调用方必须持有 web 构建锁（web-build.ts 的构建流程 / publishWebOut / rollbackWebOut）。那把锁按持有者
 * pid 判死活、不按年龄接管，发布、回滚、清理、待发布标记和构建本身都在它下面串行——不会复制到半套产物，也不会互相删版本。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  /** 已经切换成功、只是清理旧版本失败：线上是新版本，单独报 */
  pruneError?: string;
  /** 没做（例如补发布时待发布标记已被回滚取消） */
  skipped?: string;
  /** 没拿到构建锁：别人正在构建 / 发布（不是锁本身出错） */
  busy?: boolean;
}

export const currentLink = (dir = RELEASES_DIR): string => join(dir, CURRENT);
const pendingPath = (dir: string) => join(dir, ".pending.json");

function releaseId(outDir: string, now: Date, dir: string): string {
  const commit = readBuildInfo(outDir)?.webCommit;
  const suffix = commit && /^[0-9a-f]{7,40}$/i.test(commit) ? `_${commit.slice(0, 12)}` : "";
  // 同一毫秒发布两次（CI 上连发的测试）会撞名，rename 到非空目录失败 → 顺延 1ms 直到空位，排序仍按时间
  for (let t = now.getTime(); ; t++) {
    const id = `${new Date(t).toISOString().replace(/[:.]/g, "-")}${suffix}`;
    if (!existsSync(join(dir, id))) return id;
  }
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
  try {
    const link = currentLink(dir);
    return lstatSync(link).isSymbolicLink() ? basename(readlinkSync(link)) : null;
  } catch {
    return null; // 还没发布过
  }
}

/** 把 current 一步换到 id：先建临时链接再 rename 覆盖（rename 替换符号链接是原子的，不存在「没有 current」的瞬间） */
function switchCurrent(id: string, dir: string): void {
  const link = currentLink(dir);
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) throw new Error(`${link} 不是符号链接，不覆盖（手动处理后再发布）`);
  const tmp = join(dir, `.current-${process.pid}-${Date.now()}`);
  symlinkSync(id, tmp); // 相对目标：整个 web-releases 目录搬走也不断
  renameSync(tmp, link);
}

/** 保留 current + 最新的 keep 个旧版本，其余删掉；顺带清理中断留下的半成品（持有构建锁时调，别人不可能正在写） */
function pruneReleases(dir: string, keep = KEEP_PREVIOUS): string[] {
  const cur = currentRelease(dir);
  const stale = listReleases(dir).filter((id) => id !== cur).slice(keep);
  for (const id of stale) rmSync(join(dir, id), { recursive: true, force: true });
  for (const n of readdirSync(dir)) if (n.startsWith(".staging-") || n.startsWith(".current-")) rmSync(join(dir, n), { recursive: true, force: true });
  return stale;
}

/** outDir → 新版本目录 → 切换 current → 清理旧版本。失败时 current 原样不动 */
export function publishWebRelease(outDir: string, opts: { dir?: string; now?: Date } = {}): PublishResult {
  const dir = opts.dir ?? RELEASES_DIR;
  const now = opts.now ?? new Date();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(outDir, "index.html"))) return { ok: false, error: `${outDir} 里没有 index.html，不发布` };
  const id = releaseId(outDir, now, dir);
  const staging = join(dir, `.staging-${id}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(outDir, staging, { recursive: true }); // 不保留 mtime：CSP / build-info 的缓存按 size+mtime 失效
    if (!existsSync(join(staging, "index.html"))) throw new Error("复制后没有 index.html");
    renameSync(staging, join(dir, id));
    switchCurrent(id, dir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `发布失败（线上仍是 ${currentRelease(dir) ?? "原来的目录"}）：${(e as Error).message}` };
  }
  try {
    return { ok: true, id, pruned: pruneReleases(dir) };
  } catch (e) {
    return { ok: true, id, pruneError: (e as Error).message };
  }
}

export type RollbackResult = { ok: boolean; from?: string | null; to?: string; error?: string };

/** current 退回上一个（更旧的）版本；没有更旧的就不动。调用方（rollbackWebOut）在同一把锁下清掉待发布标记 */
export function rollbackWebRelease(dir = RELEASES_DIR): RollbackResult {
  const all = listReleases(dir);
  const from = currentRelease(dir);
  const older = all.slice(from ? all.indexOf(from) + 1 : 0).find((id) => id !== from);
  if (!older) return { ok: false, from, error: "没有更旧的版本可退" };
  switchCurrent(older, dir);
  return { ok: true, from, to: older };
}

/**
 * 请求开始时把 current 钉成具体版本目录（rootDir 不是本模块管的 current 就原样返回）。版本目录发布后不再改动，
 * 所以同一请求的 CSP 与正文一定来自同一份；它要在之后第 KEEP_PREVIOUS+1 次发布才会被清掉，单个请求撞不上。
 */
export function pinnedStaticRoot(rootDir: string, dir = RELEASES_DIR): string {
  if (!rootDir || resolve(rootDir) !== resolve(currentLink(dir))) return rootDir;
  const id = currentRelease(dir);
  return id ? join(dir, id) : rootDir;
}

/**
 * 旧 chunk 的兜底目录：pinned 是本模块的某个版本目录时，返回除它以外保留的版本（新到旧）；别的目录 → 空。
 * 只给 /_next/static/ 用：那里的文件名带内容哈希，新版本不会有同名文件，旧页面要的旧 chunk 只会在旧版本里。
 */
export function fallbackStaticRoots(pinned: string, dir = RELEASES_DIR): string[] {
  const own = resolve(pinned);
  if (!own.startsWith(`${resolve(dir)}/`)) return [];
  return listReleases(dir).map((id) => join(dir, id)).filter((p) => resolve(p) !== own).slice(0, KEEP_PREVIOUS);
}

/** .env 里的 BRIDGE_STATIC_DIR，相对路径按 .env 所在目录（= 仓库根，bridge 的 WorkingDirectory）解释，不按调用者的 cwd */
function staticDirIn(envFile: string): string {
  const v = (readDotenvFileSync(envFile)?.BRIDGE_STATIC_DIR ?? "").trim();
  return v ? resolve(dirname(envFile), v) : "";
}

/** .env 的 BRIDGE_STATIC_DIR 已经指向 current（由本模块管）→ 构建成功后要发布 */
export function releasesManaged(envFile: string, dir = RELEASES_DIR): boolean {
  const v = staticDirIn(envFile);
  return !!v && v === resolve(currentLink(dir));
}

/** 构建成功但发布失败 → 记一笔；下次 update 即使不用重建也会重试（构建状态与上线状态分开记） */
export function markPendingPublish(error: string, dir = RELEASES_DIR): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pendingPath(dir), JSON.stringify({ at: new Date().toISOString(), error }));
  } catch (e) {
    console.error(`[web-releases] 记待发布失败（下次构建时才会再发布）: ${(e as Error).message}`);
  }
}

export function hasPendingPublish(dir = RELEASES_DIR): boolean {
  return existsSync(pendingPath(dir));
}

export function clearPendingPublish(dir = RELEASES_DIR): void {
  rmSync(pendingPath(dir), { force: true });
}

/**
 * install-cli 调（reload bridge 之前）：BRIDGE_STATIC_DIR 还直接指着仓库的 web/out → 先把 web/out 发布成第一个版本
 * （publish 由调用方给，带构建锁），再把 .env 改指 current；reload 后 bridge 按版本托管。没托管、指向别处（包括指向
 * web/out 的符号链接）→ 不动。不抛错。已知一次性局限：做迁移的这一轮 update 里，构建仍在旧配置下原地进行（和以前一样）
 */
export async function migrateStaticDirToReleases(
  repoRoot: string, publish: () => Promise<PublishResult>, opts: { envFile?: string; dir?: string } = {},
): Promise<string[]> {
  const envFile = opts.envFile ?? join(repoRoot, ".env");
  const dir = opts.dir ?? RELEASES_DIR;
  const out = join(repoRoot, "web", "out");
  const v = staticDirIn(envFile);
  if (!v || v !== resolve(out)) return [];
  const r = await publish();
  if (!r.ok) return [`网页没改成按版本发布：${r.error}（仍直接托管 web/out，下次 install-cli 再试）`];
  try {
    const tmp = `${envFile}.tmp-${process.pid}`; // 先写临时文件再 rename：写到一半失败不会截断原 .env
    writeFileSync(tmp, mergeEnvContent(readFileSync(envFile, "utf8"), { BRIDGE_STATIC_DIR: currentLink(dir) }, "# Claudestra"), { mode: statSync(envFile).mode });
    renameSync(tmp, envFile);
  } catch (e) {
    return [`网页没改成按版本发布：写 .env 失败（${(e as Error).message}），仍直接托管 web/out`];
  }
  return [
    `网页改为按版本发布：BRIDGE_STATIC_DIR 从 web/out 换成 ${currentLink(dir)}。` +
    "这一次升级本身仍是原地构建，期间网页可能短暂打不开；从下一次更新起，构建期间线上不再缺文件" +
    `（回滚：把 BRIDGE_STATIC_DIR 改回 ${out} 再重启 bridge）`,
  ];
}
