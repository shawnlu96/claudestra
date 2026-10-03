/**
 * A lend-written card's delivered head lives on origin, not in the shared object store of the local reviewer checkout, so
 * before the reviewer is created or pinned the exact commit is fetched once: only from the configured project repository's
 * `origin`, only through the card's own lend branch / PR number (never a URL from an order), with a bounded fetch whose
 * every spawn passes the lease check. The ref is only a carrier: what gets checked out is the full commit id, so a ref that
 * moved on cannot change what is reviewed. Non-lend cards and heads already present return at once, without the network.
 * tests/scheduler-review-head.test.ts.
 */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { LEND_BRANCH_RE } from "./lend-git.js";
import type { LedgerTask } from "./ledger-stages.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { Git } from "./scheduler-review-worktree.js";

const SHA40 = /^[0-9a-f]{40}$/;
const REVIEW_FETCH_TIMEOUT_MS = 60_000;
/** No credential prompt and no half-dead transfer left hanging; runBounded kills the whole group at the deadline. */
const NET_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "10" };

export const boundedGit = (timeoutMs = REVIEW_FETCH_TIMEOUT_MS): Git => async (args) => {
  const r = await runBounded(["git", ...args], { env: { ...process.env, ...NET_ENV }, timeoutMs });
  if (r.timedOut) return { code: 124, out: `超时（${timeoutMs} ms）` };
  return { code: r.code ?? 1, out: (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim() };
};

export interface ReviewHeadEnv {
  db: Database;
  /** Local git (lease-checked). */ git: Git;
  /** Network git (bounded and lease-checked). */ net: Git;
  readConfig?: () => SchedulerConfig;
}

/** The refs this card's delivery may be fetched through: its lend branch, then its PR head. */
function sources(task: LedgerTask): string[] {
  const out: string[] = [];
  if (task.branch && LEND_BRANCH_RE.test(task.branch)) out.push(`refs/heads/${task.branch}`);
  if (task.pr && /^\d{1,9}$/.test(task.pr)) out.push(`refs/pull/${task.pr}/head`);
  return out;
}

const realOr = (p: string): string => { try { return realpathSync.native(p); } catch { return p; /* unresolvable: compare as written, a mismatch refuses */ } };

async function commonDir(git: Git, dir: string): Promise<string | null> {
  const r = await git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.code === 0 && r.out ? realOr(r.out) : null;
}

const cut = (s: string): string => s.replace(/\s+/g, " ").slice(0, 300);

/**
 * null = `head` is a commit `dir` can check out (it was there, or was fetched just now); otherwise why the review is not dispatched.
 * `dir` is the reviewer's checkout (`isCheckout`: tracked edits there refuse before any fetch) or the repository it is added from.
 */
export async function prepareReviewHead(env: ReviewHeadEnv, task: LedgerTask, head: string, dir: string, isCheckout: boolean): Promise<string | null> {
  if (!remoteHeadFamily(env.db, task)) return null;
  if (!SHA40.test(head)) return `派审 head ${head} 不是完整的 commit id，不取对象、不派审`;
  const has = async () => { const r = await env.git(["-C", dir, "rev-parse", "--verify", "--quiet", `${head}^{commit}`]); return r.code === 0 && r.out === head; };
  if (await has()) return null;
  if (isCheckout) {
    const st = await env.git(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
    if (st.code !== 0) return `审查 worktree ${dir} 读不了：${cut(st.out)}`;
    if (st.out) return `审查 worktree 有已跟踪文件被改过（审查员不该改被审代码），不取远端、不覆盖：${cut(st.out.split("\n").slice(0, 5).join("; "))}`;
  }
  const short = head.slice(0, 12);
  if (head !== task.headSHA) return `派审 head ${short} 不是卡上的交付 head，不从远端取`;
  const refs = sources(task);
  if (!refs.length) return `交付 head ${short} 不在本机，卡上没有可取的出借分支或 PR 号，不派审`;
  let repoDir: string | undefined;
  try { repoDir = (env.readConfig ?? readSchedulerConfig)().projects[task.project]?.repoDir; }
  catch (e) { return `读 scheduler.json 失败，取不了交付 head ${short}：${cut((e as Error).message)}`; }
  if (!repoDir) return `scheduler.json 里没有项目 ${task.project} 的 repoDir，取不了交付 head ${short}`;
  const mine = await commonDir(env.git, dir), project = await commonDir(env.git, repoDir);
  if (!mine || mine !== project) return `${dir} 与项目仓库 ${repoDir} 不共用对象库，不从别处取交付 head ${short}`;
  const tried: string[] = [];
  for (const ref of refs) {
    const f = await env.net(["-C", repoDir, "fetch", "--no-tags", "-q", "origin", ref]);
    if (f.code === 0 && await has()) return null;
    tried.push(f.code === 0 ? `${ref}：取到了但不含该 commit（引用已移动？）` : `${ref}：${cut(f.out)}`);
  }
  return `交付 head ${short} 从项目仓库 origin 取不到，不派审：${tried.join("；")}`.slice(0, 600);
}
