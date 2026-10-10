/**
 * i28-SECPOOL2：一张卡属于哪个仓库（docs/architecture/private-pool.md）。私仓节点的 fileGlobs 写成 `repo:<owner>/<name>/<仓库内路径>`，
 * 没有前缀 = 公共仓（scheduler.json remote.repo）。开卡、出单、交付范围比对、本机放置都从这里取仓库，口径不分叉。
 * 私仓卡进统一池的开关 statePath("private-pool.json") 与 security-pool 同一套版本号 CAS 读写（security-pool.ts readProjectMode / setProjectMode）。
 * tests/card-repo.test.ts、tests/private-pool.test.ts。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.js";
import { PROJECTS_PATH } from "./projects.js";
import { readProjectMode, setProjectMode, type SecurityPoolMode } from "./security-pool.js";
import { readJsonStateSync } from "./state-file.js";

export type PrivatePoolMode = SecurityPoolMode;

const privatePoolPath = (): string => statePath("private-pool.json");

/** 缺省 / 损坏 / 非法取值 = off：私仓节点照旧由 PM 手动开；非法取值打一次带项目名的警告 */
export const privatePoolMode = (project: string, path = privatePoolPath()): PrivatePoolMode => readProjectMode("private-pool", project, path);

export const setPrivatePoolMode = (project: string, mode: string, path = privatePoolPath()): Promise<{ from: PrivatePoolMode; mode: PrivatePoolMode }> =>
  setProjectMode("private-pool", project, mode, path);

/** GitHub PR 链接 → owner/name 与编号（scheduler-pool-facts.ts 原样转出，旧的导入点不变） */
export function prCoordinates(pr: string | null): { repo: string; pr: number } | null {
  const m = pr?.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d+)\/?$/);
  return m ? { repo: m[1], pr: Number(m[2]) } : null;
}

const PREFIXED = /^repo:([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/(.+)$/;
const GITHUB = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/**
 * 节点 fileGlobs 的仓库：全都带 `repo:<owner>/<name>/` 前缀且是同一个仓库 → owner/name；全都不带 → null（公共仓）。
 * 混了两个仓库、带前缀和不带前缀混用、前缀格式不对 → 抛错，错误文字就是自动开卡的 stop 原因。
 */
export function repoOfGlobs(globs: readonly string[]): string | null {
  const prefixed = globs.filter((g) => g.startsWith("repo:"));
  if (!prefixed.length) return null;
  if (prefixed.length !== globs.length) throw new Error(`节点文件范围带 repo: 前缀和不带前缀的混在一起（${prefixed.length}/${globs.length} 条带前缀）：一个节点只能对一个仓库`);
  const bad = prefixed.find((g) => !PREFIXED.test(g));
  if (bad) throw new Error(`文件范围 ${bad.slice(0, 120)} 不是 repo:<owner>/<name>/<仓库内路径> 的写法`);
  const repos = [...new Set(prefixed.map((g) => (g.match(PREFIXED) as RegExpMatchArray)[1].toLowerCase()))];
  if (repos.length > 1) throw new Error(`节点文件范围混了 ${repos.length} 个仓库（${repos.join("、")}）：一个节点只能对一个仓库`);
  return (prefixed[0].match(PREFIXED) as RegExpMatchArray)[1];
}

/** 解析不了（混用 / 写法不对）按 null：给只读口径用（交付范围、订单 repo），开卡门另走 repoOfGlobs 报原因 */
function repoOfGlobsSoft(globs: readonly string[]): string | null {
  try { return repoOfGlobs(globs); } catch { return null; }
}

/** 去掉本仓库的 `repo:<owner>/<name>/` 前缀（不分大小写），得到仓库内路径；别的条目原样（公共仓的卡没有前缀，逐字不变） */
export function stripRepoPrefix(globs: readonly string[], ownerName: string): string[] {
  const head = `repo:${ownerName}/`.toLowerCase();
  return globs.map((g) => (g.toLowerCase().startsWith(head) ? g.slice(head.length) : g));
}

export interface RepoDirIO {
  /** 项目 dirs（projects.json） */
  dirs(project: string): readonly string[];
  /** 目录 origin 的 GitHub owner/name；不是 GitHub / 读不到为 null。只读本地 git 配置，不联网 */
  origin(dir: string): string | null;
  exists(path: string): boolean;
}

/** projects.json 同步读：读不到 / 损坏按没有目录（调用方据此 stop，不落到公共仓） */
function projectDirsSync(project: string): string[] {
  const r = readJsonStateSync(PROJECTS_PATH, (d) => !!d && typeof d === "object" && Array.isArray((d as { projects?: unknown }).projects));
  if (r.status !== "ok") return [];
  const p = (r.data as { projects: { id?: unknown; dirs?: unknown }[] }).projects.find((x) => x?.id === project);
  return Array.isArray(p?.dirs) ? p.dirs.filter((d): d is string => typeof d === "string" && !!d) : [];
}

/** `git remote get-url origin`：读本地配置，不联网；5 秒超时 */
export function gitOriginRepo(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore", timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.exitCode === 0 ? r.stdout.toString().trim().match(GITHUB)?.[1] ?? null : null;
}

export const LOCAL_REPO_DIRS: RepoDirIO = { dirs: projectDirsSync, origin: gitOriginRepo, exists: existsSync };

/** 项目 dirs 里 origin 是 ownerName 的 git 目录（不分大小写，按 dirs 顺序取第一个）；找不到 null */
export function repoDirFor(project: string, ownerName: string, io: RepoDirIO = LOCAL_REPO_DIRS): string | null {
  const want = ownerName.toLowerCase();
  return io.dirs(project).find((d) => io.exists(join(d, ".git")) && io.origin(d)?.toLowerCase() === want) ?? null;
}

export const noCloneReason = (ownerName: string): string => `项目 dirs 里没有 ${ownerName} 的 clone`;

type CardLike = { pr: string | null; extra?: Record<string, unknown> } | null | undefined;

const globsOf = (task: CardLike): string[] =>
  Array.isArray(task?.extra?.fileGlobs) ? (task.extra.fileGlobs as unknown[]).filter((g): g is string => typeof g === "string") : [];

/**
 * 私仓卡（fileGlobs 带 repo: 前缀）的仓库：extra.repo 优先，没写就按前缀解析。公共仓卡为 null——公共仓卡不看 extra.repo，
 * 订单 repo 与改动前逐字一致（peer 放置写的 extra.repo 取自目录 origin，大小写可能和 remote.repo 不同）。
 */
export function privateCardRepo(task: CardLike): string | null {
  const globs = globsOf(task);
  if (!globs.some((g) => g.startsWith("repo:"))) return null;
  const declared = task?.extra?.repo;
  return typeof declared === "string" && declared ? declared : repoOfGlobsSoft(globs);
}

/** 卡的仓库 = PR 链接的仓库 ?? 私仓卡的 extra.repo（或前缀）?? remote.repo；task 为 null（还没建卡的开卡容量）= remote.repo */
export function cardRepo(task: CardLike, remote: { repo?: string | null } | null | undefined): string | null {
  return prCoordinates(task?.pr ?? null)?.repo ?? privateCardRepo(task) ?? remote?.repo ?? null;
}

/** 本卡仓库内路径：私仓卡去掉自己仓库的前缀，公共仓卡原样 */
export function cardGlobs(task: CardLike): string[] {
  const globs = globsOf(task), own = privateCardRepo(task);
  return own ? stripRepoPrefix(globs, own) : globs;
}

/** 私仓开卡要用的仓库与目录（开关 on 才解析）：null = 不是私仓节点或开关不是 on，走原路；error = 该 stop 的原因 */
export function privateStart(project: string, globs: readonly string[], mode: PrivatePoolMode, io: RepoDirIO = LOCAL_REPO_DIRS):
  { repo: string; dir: string | null } | { error: string } | null {
  if (mode !== "on") return null;
  let repo: string | null;
  try { repo = repoOfGlobs(globs); } catch (e) { return { error: (e as Error).message }; }
  return repo ? { repo, dir: repoDirFor(project, repo, io) } : null;
}

/** observe：派单同 off，stop 原因后面多一句「按私仓进池会用 <仓库>（<目录>）开卡」 */
export function privateObserveNote(project: string, globs: readonly string[], io: RepoDirIO = LOCAL_REPO_DIRS): string {
  let repo: string | null;
  try { repo = repoOfGlobs(globs); } catch (e) { return `；按私仓进池会停：${(e as Error).message}`; }
  if (!repo) return "";
  const dir = repoDirFor(project, repo, io);
  return dir ? `；按私仓进池会用 ${repo}（${dir}）开卡` : `；按私仓进池会停：${noCloneReason(repo)}`;
}
