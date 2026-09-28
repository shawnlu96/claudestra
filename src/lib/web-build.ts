/**
 * web 前端「静态包是否过期 → 重建」的唯一实现，install-cli / manager update / doctor 共用。
 * 前端是 Next `output: "export"` 的静态导出（web/out），由 bridge 直接托管（BRIDGE_STATIC_DIR）——
 * 机器上没有 web 服务进程，所以「构建好了」= web/out/index.html 在 + 标记指向当前 web 提交。
 *
 * 判据为什么按 hash 而不是按时间：
 *  - 客户端「新版本已就绪」胶囊比的是 bundle 里烤入的 CLIENT_WEB_COMMIT（prebuild 写进
 *    web/lib/build-info.ts）与服务端现算的 webCommit。两者都是 `git log -1 --format=%h`
 *    同一 pathspec 的结果，所以这里也比 hash，才跟胶囊亮不亮是一回事。
 *  - 提交时间会骗人：release tag 里的提交常早于拉取时间，BUILD_ID 的 mtime 落在两者之间
 *    时按时间判「不落后」，胶囊却一直亮。
 *  - pathspec 必须排除 web 下的 *.md（与 web/scripts/gen-build-info.mjs 一致）：文档提交不进 bundle。
 *
 * 为什么另写 .next/claudestra-web-commit 标记：build-info.ts 每次跑 gen-build-info.mjs 都会重写
 * （predev、手动 typecheck 前都会跑），它的内容与 mtime 都不能证明 .next / out 里是哪次构建。标记在
 * 构建成功后写入并绑定 BUILD_ID——BUILD_ID 对不上（别人手动 build 过）就作废，退回比 build-info。
 *
 * 重建为什么要备份 .next 和 out：next build 开局清空 .next（cleanDistDir），导出阶段清空 out。
 * 失败时旧构建已经没了，所以先把两份都克隆一份（APFS clonefile，秒级、几乎不占空间），失败就换回去。
 * bridge 按版本托管（BRIDGE_STATIC_DIR = web-releases/current，lib/web-releases.ts）时，线上读的不是 out：
 * 构建成功才发布一个新版本并切换，构建过程中线上一直是上一个版本；还直接托管 out 的老配置由 install-cli 迁移。
 */

import { STATE_DIR } from "./paths.js";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { spawnSync } from "child_process";
import { resolveNpm } from "./npm-path.js";
import { healSelfDirty } from "./self-dirty.js";
import { publishWebRelease, releasesManaged } from "./web-releases.js";

/** 仓库根下的 web pathspec —— 与 gen-build-info.mjs 在 web/ 下的 `-- . ':(exclude)*.md'` 等价 */
export const WEB_PATHSPEC = ["--", "web", ":(exclude)web/*.md"];

/** .next/claudestra-web-commit：这份构建是哪次提交的。commit 为空 = 那次构建失败、换回了旧构建 */
export interface BuildMarker {
  commit: string;
  buildId: string;
}

export const MARKER_NAME = "claudestra-web-commit";

/** bridge 托管的入口文件；没有它构建产物再新也打不开网页 */
export function webOutIndex(repoRoot: string): string {
  return `${repoRoot}/web/out/index.html`;
}

export interface WebBuildFacts {
  /** web/out/index.html 在不在 */
  outIndex: boolean;
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
  if (!f.outIndex) {
    return { status: "warn", stale: true, detail: "前端静态包不存在(web/out/index.html)" };
  }
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
    outIndex: existsSync(webOutIndex(repoRoot)),
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
  /** 构建失败后已把旧 .next / out 换回 */
  restored?: boolean;
  /** 构建输出末尾几行（失败时） */
  log?: string[];
}

const ORCH_DIR = STATE_DIR;
const LOCK_PATH = `${ORCH_DIR}/web-build.lock`;
/** 备份放仓库外：web/.gitignore 只忽略 /.next/ 与 /out/，放 web/ 下会让工作区变脏、挡住自动更新 */
const BACKUP_ROOT = `${ORCH_DIR}/web-build`;
/** 构建会清空的两个目录，各自的克隆位置 */
const BACKUPS = [
  { sub: ".next", prev: `${BACKUP_ROOT}/next-prev` },
  { sub: "out", prev: `${BACKUP_ROOT}/out-prev` },
];

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

/** 构建前克隆 .next 与 out；clonefile 不可用（非 APFS / 跨卷）退回普通复制。任一份失败即失败 */
function backupBuild(webDir: string): boolean {
  mkdirSync(BACKUP_ROOT, { recursive: true });
  for (const b of BACKUPS) {
    rmSync(b.prev, { recursive: true, force: true });
    const src = `${webDir}/${b.sub}`;
    if (!existsSync(src)) continue;
    if (!(sh(["/bin/cp", "-c", "-R", src, b.prev]) || sh(["/bin/cp", "-R", src, b.prev]))) return false;
  }
  return true;
}

/** 把克隆换回去（有哪份换哪份） */
function restoreBuild(webDir: string): boolean {
  let ok = true;
  for (const b of BACKUPS) {
    if (!existsSync(b.prev)) continue;
    rmSync(`${webDir}/${b.sub}`, { recursive: true, force: true });
    ok = sh(["/bin/mv", b.prev, `${webDir}/${b.sub}`]) && ok;
  }
  return ok;
}

function discardBackups(): void {
  for (const b of BACKUPS) rmSync(b.prev, { recursive: true, force: true });
}

/**
 * 静态包过期就重建。失败只报告不抛：web 是附属前端，不能拖垮 install-cli / update。
 * 构建成功后 bridge 立刻服务新文件（它按请求读 out/，不用重启）。
 */
export async function rebuildWebIfStale(repoRoot: string): Promise<WebBuildResult> {
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
  if (healSelfDirty(repoRoot, dirty.out)) return { attempted: false, skipped: `${verdict.detail};但 web/ 有未提交改动,不自动构建` };

  const npmBin = resolveNpm();
  if (!npmBin) return { attempted: false, error: `${verdict.detail};找不到 npm(PATH/nvm/homebrew 都没有),无法重建` };

  if (!takeLock()) return { attempted: false, skipped: "另一次 web 构建正在进行" };
  try {
    // 上一次构建中途被杀（.next 已清空、备份还在）→ 先把旧构建换回来
    if (!existsSync(`${nextDir}/BUILD_ID`) && existsSync(`${BACKUPS[0]!.prev}/BUILD_ID`)) restoreBuild(webDir);
    const hadBuild = existsSync(`${nextDir}/BUILD_ID`) || existsSync(webOutIndex(repoRoot));
    if (hadBuild && !backupBuild(webDir)) {
      return { attempted: false, error: "备份 .next / out 失败(磁盘满?),不冒险构建——旧构建仍在服务" };
    }
    const env = { ...process.env, PATH: `${npmBin.binDir}:${process.env.PATH || ""}` } as Record<string, string>;

    const result: WebBuildResult = { attempted: true };
    if (needsNpmInstall({
      pkg: mtimeOrNull(`${webDir}/package.json`),
      lock: mtimeOrNull(`${webDir}/package-lock.json`),
      installed: mtimeOrNull(`${webDir}/node_modules/.package-lock.json`),
    })) {
      // 有锁文件就 npm ci：严格按锁安装、不改写它——npm install 会改写受 git 管理的 package-lock.json，
      // 之后自动更新全因「工作区脏」被拦（lib/self-dirty.ts）；装完万一还是改了就还原
      const ip = await run([npmBin.npm, existsSync(`${webDir}/package-lock.json`) ? "ci" : "install"], webDir, env);
      healSelfDirty(repoRoot, git(repoRoot, ["status", "--porcelain", "--", "web/package-lock.json"]).out);
      if (!ip.ok) {
        result.ok = false;
        result.error = "npm install 失败";
        result.log = ip.tail;
      }
    }
    if (result.ok !== false) {
      const bp = await run([npmBin.npm, "run", "build"], webDir, env);
      result.ok = bp.ok && existsSync(webOutIndex(repoRoot));
      if (!result.ok) {
        result.error = bp.ok ? "next build 成功但没有导出 web/out/index.html(next.config 不是 output: export?)" : "next build 失败";
        result.log = bp.tail;
      }
    }
    if (result.ok) {
      discardBackups();
      // prebuild 刚把这次的 hash 写进 build-info，照抄进标记
      let baked: string | null = null;
      try { baked = parseBakedWebCommit(readFileSync(`${webDir}/lib/build-info.ts`, "utf-8")); } catch { /* 没有就不写 */ }
      if (baked) writeMarker(nextDir, baked);
      // 按版本托管：发布失败 = 这次没上线（线上仍是上一个版本、没坏），按失败报出去
      if (releasesManaged(`${repoRoot}/.env`)) {
        const p = publishWebRelease(`${webDir}/out`);
        if (!p.ok) Object.assign(result, { ok: false, error: `构建成功但${p.error}` });
      }
    } else if (hadBuild) {
      result.restored = restoreBuild(webDir);
      if (result.restored) writeMarker(nextDir, "");
      result.error += result.restored ? "(已换回旧构建)" : "(换回旧构建也失败了——网页可能打不开)";
    }
    return result;
  } catch (e) {
    const restored = existsSync(`${BACKUPS[0]!.prev}/BUILD_ID`) && !existsSync(`${nextDir}/BUILD_ID`) ? restoreBuild(webDir) : undefined;
    if (restored) writeMarker(nextDir, "");
    return { attempted: true, ok: false, restored, error: `web 构建异常: ${(e as Error).message}` };
  } finally {
    releaseLock();
  }
}
