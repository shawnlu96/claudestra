/**
 * Which checkout the repair diff summary reads (dispatch-recovery-CONVREPO1). A public card reads its source exactly as before and
 * still throws on a git failure. A private card's heads only exist in its own repo, so it reads the source when that already is a
 * clone of the card's repo (a local private author), else the project's clone of that repo (same lookup as cardScopeDiff), and it
 * never throws: no clone or an unreadable pair becomes an "unavailable" line. No fetch here, and no git stderr in the text — the
 * material rides the outbound order. The git run itself is injected (fix-strategy-runtime.ts). tests/fix-strategy-private-diff.test.ts.
 */
import { gitOriginRepo, noCloneReason, prCoordinates, privateCardRepo, repoDirFor } from "./card-repo.js";

export interface DiffDirIO {
  /** origin owner/name of a checkout; null = not GitHub / unreadable */
  origin(dir: string): string | null;
  /** the project's clone of a repo (projects.json dirs by origin); null = none */
  dirFor(project: string, repo: string): string | null;
}
export const LOCAL_DIFF_DIRS: DiffDirIO = { origin: gitOriginRepo, dirFor: (project, repo) => repoDirFor(project, repo) };

type CardLike = { project: string; pr: string | null; extra?: Record<string, unknown> };
export type DiffRun = (dir: string, from: string, to: string) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
export type InjectedDiff = (source: string, from: string | null, to: string) => Promise<string>;

/** null = public card; otherwise the card's repo and the checkout to read (dir null = no clone on this machine). */
export function privateDiffDir(task: CardLike, source: string, io: DiffDirIO = LOCAL_DIFF_DIRS): { repo: string; dir: string | null } | null {
  const own = privateCardRepo(task);
  if (!own) return null;
  const repo = prCoordinates(task.pr)?.repo ?? own;
  if (io.origin(source)?.toLowerCase() === repo.toLowerCase()) return { repo, dir: source };
  return { repo, dir: io.dirFor(task.project, repo) };
}

export const FIRST_ROUND_DIFF = "首轮审查前没有上一轮修复区间";
const unavailable = (why: string): string => `diff 摘要不可用：${why}`;
const unreadable = (repo: string, why: string): string => unavailable(`本机 ${repo} clone 读不到这两个提交（${why}）`);

/** The (from, to) → summary reader fixHistory calls; the directory is resolved once, on first use, and only for a private card. */
export function diffSummarizer(task: CardLike, source: string, run: DiffRun, injected?: InjectedDiff, io: DiffDirIO = LOCAL_DIFF_DIRS) {
  let pick: ReturnType<typeof privateDiffDir> | undefined;
  return async (from: string | null, to: string): Promise<string> => {
    pick ??= privateDiffDir(task, source, io);
    if (!pick) {
      if (injected) return injected(source, from, to);
      if (!from) return FIRST_ROUND_DIFF;
      const r = await run(source, from, to);
      if (r.code !== 0 || r.timedOut) throw new Error(`修复 diff 摘要读取失败：${r.stderr}`);
      return r.stdout;
    }
    const { repo, dir } = pick;
    if (injected) {
      if (!dir) return unavailable(noCloneReason(repo));
      // the injected reader's message may carry SHAs or paths: only the fact that it failed goes into the material
      try { return await injected(dir, from, to); } catch { return unreadable(repo, "摘要读取出错"); }
    }
    if (!from) return FIRST_ROUND_DIFF;
    if (!dir) return unavailable(noCloneReason(repo));
    const r = await run(dir, from, to);
    if (r.code !== 0 || r.timedOut) return unreadable(repo, r.timedOut ? "超时" : `git 退出码 ${r.code}`);
    return r.stdout;
  };
}
