/**
 * web 前端「构建是否过期 → 重建」的唯一实现，install-cli / manager update / doctor 共用。
 *
 * 判据为什么按 hash 而不是按时间：
 *  - 客户端「新版本已就绪」胶囊比的是 bundle 里烤入的 CLIENT_WEB_COMMIT（prebuild 写进
 *    web/lib/build-info.ts）与服务端现算的 webCommit。两者都是 `git log -1 --format=%h`
 *    同一 pathspec 的结果，所以这里也比 hash，才跟胶囊亮不亮是一回事。
 *  - 提交时间会骗人：release tag 里的提交常早于拉取时间，BUILD_ID 的 mtime 落在两者之间
 *    时按时间判「不落后」，胶囊却一直亮。
 *  - pathspec 必须排除 web 下的 *.md（与 web/scripts/gen-build-info.mjs、
 *    web/app/api/version/route.ts 一致）：文档提交不进 bundle，不算前端变更。
 *
 * 为什么另写 .next/claudestra-web-commit 标记：build-info.ts 每次跑 gen-build-info.mjs 都会重写
 * （predev、手动 typecheck 前都会跑），它的内容与 mtime 都不能证明 .next 里是哪次构建。标记在
 * 构建成功后写入并绑定 BUILD_ID——BUILD_ID 对不上（别人手动 build 过）就作废，退回比 build-info。
 *
 * 重建为什么要备份 .next：next build 开局就原地清空 .next（cleanDistDir 默认 true），
 * 失败时旧构建已经没了，下次重启 web 服务就是 "Could not find a production build"。
 * 所以先把 .next 克隆一份（APFS clonefile，秒级、几乎不占空间），失败就换回去。
 */

import { STATE_DIR } from "./paths.js";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { spawnSync } from "child_process";
import { resolveNpm } from "./npm-path.js";

/** 仓库根下的 web pathspec —— 与 gen-build-info.mjs 在 web/ 下的 `-- . ':(exclude)*.md'` 等价 */
export const WEB_PATHSPEC = ["--", "web", ":(exclude)web/*.md"];

/** .next/claudestra-web-commit：这份 .next 是哪次提交构建的。commit 为空 = 那次构建失败、换回了旧构建 */
export interface BuildMarker {
  commit: string;
  buildId: string;
}

export const MARKER_NAME = "claudestra-web-commit";

export interface WebBuildFacts {
  /** web/.next/BUILD_ID 的内容；null = 没有构建产物 */
  buildId: string | null;
  /** web/.next/BUILD_ID 的 mtime（只给拿不到 hash 时的时间兜底用） */
  buildIdMtimeMs: number | null;
  /** 构建成功后写入的标记；与 buildId 不符时作废 */
  marker: BuildMarker | null;
  /** build-info.ts 里烤入的 CLIENT_WEB_COMMIT（没有有效标记时的退路） */
  bakedWebCommit: string | null;
  /** 当前工作树里最后一次触及 web（不含 md）的提交 */
  headWebCommit: string | null;
  /** 同一 pathspec 的提交时间，只在拿不到 hash 时兜底 */
  lastWebCommitMs: number | null;
}

export interface WebBuildVerdict {
  status: "ok" | "warn";
  stale: boolean;
  detail: string;
}

/** 两个缩写 hash 是否指同一提交（缩写长度可能不同，按前缀比） */
export function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

export function parseBakedWebCommit(src: string): string | null {
  const m = /CLIENT_WEB_COMMIT\s*=\s*"([^"]*)"/.exec(src);
  return m && m[1] ? m[1] : null;
}

export function parseBuildMarker(src: string): BuildMarker | null {
  try {
    const j = JSON.parse(src);
    if (j && typeof j.commit === "string" && typeof j.buildId === "string" && j.buildId) {
      return { commit: j.commit, buildId: j.buildId };
    }
  } catch { /* 损坏按没有 */ }
  return null;
}

export function webBuildVerdict(f: WebBuildFacts): WebBuildVerdict {
  if (f.buildId === null) {
    return { status: "warn", stale: true, detail: "web 无构建产物(.next/BUILD_ID 不存在)" };
  }
  // 标记只对写它时的那份 .next 有效；BUILD_ID 变了说明之后有人另外 build 过
  const built = f.marker && f.marker.buildId === f.buildId ? f.marker.commit : null;
  if (built === "") {
    return { status: "warn", stale: true, detail: "上一次 web 构建失败,在服务的是更早的构建" };
  }
  const have = built ?? f.bakedWebCommit;
  if (have && f.headWebCommit) {
    if (!sameCommit(have, f.headWebCommit)) {
      return {
        status: "warn",
        stale: true,
        detail: `web 构建落后于代码(构建自 ${have},web/ 最新提交 ${f.headWebCommit})`,
      };
    }
    return { status: "ok", stale: false, detail: `web 构建与代码一致(${f.headWebCommit})` };
  }
  // 拿不到 hash（非 git 部署 / 老构建没有 build-info）才退回时间比较；60s 吸收同分钟粒度
  if (f.buildIdMtimeMs === null || f.lastWebCommitMs === null) {
    return { status: "ok", stale: false, detail: "无法取得 web/ 提交信息,跳过比对" };
  }
  if (f.buildIdMtimeMs + 60_000 < f.lastWebCommitMs) {
    return {
      status: "warn",
      stale: true,
      detail: `web 构建产物落后于代码(BUILD_ID ${new Date(f.buildIdMtimeMs).toISOString()} < 最后 web 提交 ${new Date(f.lastWebCommitMs).toISOString()})`,
    };
  }
  return { status: "ok", stale: false, detail: "web 构建产物不落后于代码" };
}

function mtimeOrNull(p: string): number | null {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

function readBuildId(nextDir: string): string | null {
  try { return readFileSync(`${nextDir}/BUILD_ID`, "utf-8").trim() || null; } catch { return null; }
}

/** 给当前 .next 打标记；commit 为空表示「这份是构建失败后换回的旧构建」 */
function writeMarker(nextDir: string, commit: string): void {
  const buildId = readBuildId(nextDir);
  if (!buildId) return;
  try { writeFileSync(`${nextDir}/${MARKER_NAME}`, JSON.stringify({ commit, buildId }) + "\n"); } catch { /* 标记只影响判据 */ }
}

function git(repoRoot: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim() };
}

export function readWebBuildFacts(repoRoot: string): WebBuildFacts {
  const webDir = `${repoRoot}/web`;
  let baked: string | null = null;
  try { baked = parseBakedWebCommit(readFileSync(`${webDir}/lib/build-info.ts`, "utf-8")); } catch { /* 没构建过 */ }
  const h = git(repoRoot, ["log", "-1", "--format=%h", ...WEB_PATHSPEC]);
  const ct = git(repoRoot, ["log", "-1", "--format=%ct", ...WEB_PATHSPEC]);
  let marker: BuildMarker | null = null;
  try { marker = parseBuildMarker(readFileSync(`${webDir}/.next/${MARKER_NAME}`, "utf-8")); } catch { /* 没有 */ }
  return {
    buildId: readBuildId(`${webDir}/.next`),
    buildIdMtimeMs: mtimeOrNull(`${webDir}/.next/BUILD_ID`),
    marker,
    bakedWebCommit: baked,
    headWebCommit: h.ok && h.out ? h.out : null,
    lastWebCommitMs: ct.ok && /^\d+$/.test(ct.out) ? Number(ct.out) * 1000 : null,
  };
}

/** package.json / lock 比已装依赖新 ⇒ 先 npm install（marker 缺失时不猜） */
export function needsNpmInstall(m: { pkg: number | null; lock: number | null; installed: number | null }): boolean {
  if (m.installed === null) return false;
  return (m.pkg ?? 0) > m.installed || (m.lock ?? 0) > m.installed;
}

export interface WebBuildResult {
  /** 真的跑了 npm run build */
  attempted: boolean;
  ok?: boolean;
  skipped?: string;
  error?: string;
  /** 构建失败后已把旧 .next 换回 */
  restored?: boolean;
  /** 已 kickstart com.claudestra.web（仅 restartService 时） */
  restarted?: boolean;
  /** 构建输出末尾几行（失败时） */
  log?: string[];
}

const ORCH_DIR = STATE_DIR;
const LOCK_PATH = `${ORCH_DIR}/web-build.lock`;
/** 备份放仓库外：web/.gitignore 只忽略 /.next/，放 web/ 下会让工作区变脏、挡住自动更新 */
const BACKUP_DIR = `${ORCH_DIR}/web-build/next-prev`;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 锁持有者是否还在构建。只看死活、不按年龄接管：备份目录是共用的，接管一个还活着的构建
 * 会删掉它的备份、让它失败时无从回滚。pid 被复用成别的进程时（不是 bun）按已死处理。
 */
function holderBusy(pid: number): boolean {
  if (!(pid > 0) || !pidAlive(pid)) return false;
  const comm = (spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout || "").trim();
  return !comm || isBuilderComm(comm); // ps 读不到就当还活着：宁可这轮不建，也不删别人的备份
}

/** 构建都跑在 bun 进程里（manager / install-cli）；ps comm 可能是全路径 */
export function isBuilderComm(comm: string): boolean {
  return /(^|\/)bun$/.test(comm.trim());
}

function takeLock(): boolean {
  mkdirSync(ORCH_DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      let holder = 0;
      try { holder = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10); } catch { /* 读不到当孤儿 */ }
      if (holderBusy(holder)) return false;
      try { unlinkSync(LOCK_PATH); } catch { /* 被别人抢先清了，再试一次 */ }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    if (parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10) === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* 已不在 */ }
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<{ ok: boolean; tail: string[] }> {
  const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // 两个管道都必须读走：输出一多不读就背压卡死
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const tail = `${out}\n${err}`.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-8);
  return { ok: p.exitCode === 0, tail };
}

function sh(cmd: string[]): boolean {
  return spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" }).status === 0;
}

/** 构建前克隆 .next；clonefile 不可用（非 APFS / 跨卷）退回普通复制 */
function backupNext(nextDir: string): boolean {
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(`${ORCH_DIR}/web-build`, { recursive: true });
  return sh(["/bin/cp", "-c", "-R", nextDir, BACKUP_DIR]) || sh(["/bin/cp", "-R", nextDir, BACKUP_DIR]);
}

function restoreNext(nextDir: string): boolean {
  rmSync(nextDir, { recursive: true, force: true });
  return sh(["/bin/mv", BACKUP_DIR, nextDir]);
}

/**
 * 重启 launchd 托管的 web 服务。只在服务已 load 时 kickstart（这是重启，不是替用户拉起
 * 一个被刻意 unload 的服务）；非 launchd 托管的不猜不杀。
 */
export function restartWebService(): boolean {
  const uid = process.getuid?.() ?? 501;
  const label = `gui/${uid}/com.claudestra.web`;
  if (!sh(["launchctl", "print", label])) return false;
  return sh(["launchctl", "kickstart", "-k", label]);
}

/**
 * web 构建过期就重建。失败只报告不抛：web 是附属前端，不能拖垮 install-cli / update。
 * restartService=true 时构建后（无论成败）kickstart web 服务——构建期间它的文件被删过。
 */
export async function rebuildWebIfStale(
  repoRoot: string,
  opts: { restartService?: boolean } = {},
): Promise<WebBuildResult> {
  const webDir = `${repoRoot}/web`;
  const nextDir = `${webDir}/.next`;
  if (process.platform !== "darwin") return { attempted: false, skipped: "非 macOS" };
  if (!existsSync(`${webDir}/package.json`)) return { attempted: false, skipped: "本 checkout 没有 web/" };
  if (!existsSync(`${webDir}/node_modules/.bin/next`)) return { attempted: false, skipped: "web 依赖没装" };

  const verdict = webBuildVerdict(readWebBuildFacts(repoRoot));
  if (!verdict.stale) return { attempted: false, skipped: verdict.detail };

  // 主树就是线上：脏树构建会把未提交代码烤进 bundle，且烤入的 commit 与代码对不上
  const dirty = git(repoRoot, ["status", "--porcelain", ...WEB_PATHSPEC]);
  if (!dirty.ok) return { attempted: false, skipped: "git status 失败,不构建" };
  if (dirty.out) return { attempted: false, skipped: `${verdict.detail};但 web/ 有未提交改动,不自动构建` };

  const npmBin = resolveNpm();
  if (!npmBin) return { attempted: false, error: `${verdict.detail};找不到 npm(PATH/nvm/homebrew 都没有),无法重建` };

  if (!takeLock()) return { attempted: false, skipped: "另一次 web 构建正在进行" };
  try {
    // 上一次构建中途被杀（.next 已清空、备份还在）→ 先把旧构建换回来
    if (existsSync(BACKUP_DIR) && !existsSync(`${nextDir}/BUILD_ID`) && existsSync(`${BACKUP_DIR}/BUILD_ID`)) {
      restoreNext(nextDir);
    }
    const hadBuild = existsSync(`${nextDir}/BUILD_ID`);
    if (hadBuild && !backupNext(nextDir)) {
      return { attempted: false, error: "备份 .next 失败(磁盘满?),不冒险构建——旧构建仍在服务" };
    }
    const env = { ...process.env, PATH: `${npmBin.binDir}:${process.env.PATH || ""}` } as Record<string, string>;

    const result: WebBuildResult = { attempted: true };
    if (needsNpmInstall({
      pkg: mtimeOrNull(`${webDir}/package.json`),
      lock: mtimeOrNull(`${webDir}/package-lock.json`),
      installed: mtimeOrNull(`${webDir}/node_modules/.package-lock.json`),
    })) {
      const ip = await run([npmBin.npm, "install"], webDir, env);
      if (!ip.ok) {
        result.ok = false;
        result.error = "npm install 失败";
        result.log = ip.tail;
      }
    }
    if (result.ok !== false) {
      const bp = await run([npmBin.npm, "run", "build"], webDir, env);
      result.ok = bp.ok;
      if (!bp.ok) {
        result.error = "next build 失败";
        result.log = bp.tail;
      }
    }
    if (result.ok) {
      rmSync(BACKUP_DIR, { recursive: true, force: true });
      // prebuild 刚把这次的 hash 写进 build-info，照抄进标记
      let baked: string | null = null;
      try { baked = parseBakedWebCommit(readFileSync(`${webDir}/lib/build-info.ts`, "utf-8")); } catch { /* 没有就不写 */ }
      if (baked) writeMarker(nextDir, baked);
    } else if (hadBuild) {
      result.restored = restoreNext(nextDir);
      if (result.restored) writeMarker(nextDir, "");
      result.error += result.restored ? "(已换回旧构建)" : "(换回旧构建也失败了——web 服务可能起不来)";
    }
    if (opts.restartService) result.restarted = restartWebService();
    return result;
  } catch (e) {
    const restored = existsSync(BACKUP_DIR) && !existsSync(`${nextDir}/BUILD_ID`) ? restoreNext(nextDir) : undefined;
    if (restored) writeMarker(nextDir, "");
    return { attempted: true, ok: false, restored, error: `web 构建异常: ${(e as Error).message}` };
  } finally {
    releaseLock();
  }
}
