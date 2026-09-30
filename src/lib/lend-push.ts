/**
 * 写单的推送与 PR（i28-R6，出借方 B）：worker 的工作副本上了锁推不出去（lend-clone.ts WRITE_LOCK），推送只在这里做。
 * 每次都在 statePath("lend","push",<单目录>) 新建一个 bare 仓库，从工作副本取订单分支，核过「就是 worker 交的那个 head、
 * 是订单起点的后代」，再只推一条显式 refspec `<head>:refs/heads/<订单分支>`：不 force、不 --mirror / --all，分支名必须是
 * lend/<任务>-<指纹前 4 位> 且不是基线。远端不是快进（被别人推过）就拒，不覆盖。
 * 凭据是出借人自己的 git / gh 登录（白名单环境里的 HOME），推不上去且像是没权限的，报「推到自己 fork 的路径 v1 不支持」——
 * 这一种只检测、不自动 fork。开工单推完开 PR（base = 基线；已有同分支的开着的 PR 就用它），修复单推同一分支、PR 自己更新。
 * 沙箱 lab（本地 bare 仓库）没有 PR，pr 原样给 null / 订单的号。tests/lend-write.test.ts。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEND_ROOT, orderDir, removeOrderDir, type Run } from "./lend-clone.js";
import { isBaseBranch, labGitRoot, LEND_BRANCH_RE, lendRepoUrl } from "./lend-git.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";

const TIMEOUT_MS = 5 * 60_000;
const SHA40 = /^[0-9a-f]{40}$/;

export interface PushTarget { orderId: string; repo: string; branch: string; base: string; cloneDir: string; orderHead: string }
export type PushResult = { ok: true } | { ok: false; reason: string; retry: boolean };
interface PushOpts { root?: string; env?: Record<string, string | undefined>; run?: Run }

/** 像是凭据 / 权限问题（GitHub 的 403、没登录、不许交互输密码）：换个时间再试也没用 */
const DENIED = /\b403\b|denied|permission|authentication failed|could not read username|terminal prompts disabled|not found/i;
const NOT_FF = /non-fast-forward|fetch first|\[rejected\]|stale info/i;
const tail = (r: BoundedResult): string => (r.timedOut ? "超时" : (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300));

/** 推送目标本身不合格就什么都不做：分支必须是出借分支、不是基线 */
export function pushTargetProblem(t: Pick<PushTarget, "branch" | "base" | "orderHead">): string | null {
  if (!LEND_BRANCH_RE.test(t.branch)) return `订单分支 ${t.branch.slice(0, 80)} 不是出借分支，不推`;
  if (!isBaseBranch(t.base) || t.base === t.branch) return `基线 ${t.base.slice(0, 80)} 不合格，不推`;
  if (!SHA40.test(t.orderHead)) return "订单起点不是完整 40 位 SHA";
  return null;
}

function setup(t: PushTarget, o: PushOpts) {
  const root = o.root ?? LEND_ROOT;
  const dir = orderDir(t.orderId, root, "push");
  const env = { ...pickWorkerEnv(o.env ?? process.env), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  const run: Run = o.run ?? ((argv, opts) => runBounded(argv, opts));
  return { root, dir, env, url: lendRepoUrl(t.repo, o.env ?? process.env), run, git: (args: string[]) => run(["git", ...args], { cwd: dir, env, timeoutMs: TIMEOUT_MS }) };
}

/** 新建推送目录，把工作副本的订单分支取成 refs/lend/work，返回它的 head */
async function stage(t: PushTarget, o: PushOpts): Promise<{ ok: true; head: string; s: ReturnType<typeof setup> } | { ok: false; reason: string; retry: boolean }> {
  const s = setup(t, o);
  try {
    removeOrderDir(t.orderId, s.root, "push");
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ok: false, reason: `建推送目录失败：${(e as Error).message}`, retry: true };
  }
  for (const args of [["init", "-q", "--bare"], ["fetch", "--no-tags", "-q", t.cloneDir, `+refs/heads/${t.branch}:refs/lend/work`]]) {
    const r = await s.git(args);
    if (r.code !== 0) return { ok: false, reason: `从工作副本取 ${t.branch} 失败：${tail(r)}`, retry: false };
  }
  const h = await s.git(["rev-parse", "refs/lend/work"]);
  const head = h.stdout.trim();
  return h.code === 0 && SHA40.test(head) ? { ok: true, head, s } : { ok: false, reason: "读不到工作副本订单分支的 head", retry: false };
}

/** 按完整输出判类（--porcelain 的 [rejected] 在 stdout，提示在 stderr），给人看的只留末两行 */
const failed = (what: string, r: BoundedResult): PushResult => {
  const why = tail(r);
  const all = `${r.stdout}\n${r.stderr}`;
  if (NOT_FF.test(all)) return { ok: false, retry: false, reason: `远端 ${what} 不是这一单的起点（被别人推过），不强推：${why}` };
  if (DENIED.test(all)) return { ok: false, retry: false, reason: `没有推送权限：出借人的 GitHub 登录推不了这个仓库（推到自己 fork 再发 PR 的路径 v1 不支持，只检测）：${why}` };
  return { ok: false, retry: true, reason: `${what}失败：${why}` };
};

/** 起 worker 之前先试推（dry-run，同一套凭据）：没权限就不借，免得白干一单 */
export async function probePush(t: PushTarget, o: PushOpts = {}): Promise<PushResult> {
  const bad = pushTargetProblem(t);
  if (bad) return { ok: false, reason: bad, retry: false };
  const st = await stage(t, o);
  if (!st.ok) return st;
  if (st.head !== t.orderHead) return { ok: false, reason: "工作副本的订单分支不在订单起点上", retry: false };
  const r = await st.s.git(["push", "--dry-run", "--porcelain", st.s.url, `${t.orderHead}:refs/heads/${t.branch}`]);
  return r.code === 0 ? { ok: true } : failed("试推", r);
}

/** 推 worker 交的 head：必须正是工作副本订单分支的 head、是订单起点的严格后代；只推订单分支，不 force */
export async function pushWork(t: PushTarget & { head: string }, o: PushOpts = {}): Promise<PushResult> {
  const bad = pushTargetProblem(t) ?? (SHA40.test(t.head) && t.head !== t.orderHead ? null : "交的 head 不是新的完整 SHA");
  if (bad) return { ok: false, reason: bad, retry: false };
  const st = await stage(t, o);
  if (!st.ok) return st;
  if (st.head !== t.head) return { ok: false, reason: `工作副本 ${t.branch} 的 head 是 ${st.head.slice(0, 12)}，不是交的 ${t.head.slice(0, 12)}`, retry: false };
  const anc = await st.s.git(["merge-base", "--is-ancestor", t.orderHead, t.head]);
  if (anc.code !== 0) return { ok: false, reason: "交的 head 不是从订单起点接着提交的（改写了历史），不推", retry: false };
  const r = await st.s.git(["push", "--porcelain", st.s.url, `${t.head}:refs/heads/${t.branch}`]);
  return r.code === 0 ? { ok: true } : failed(t.branch, r);
}

export interface PrInput { orderId: string; repo: string; branch: string; base: string; pr: number | null; title: string; body: string }
export type PrResult = { ok: true; pr: number | null } | { ok: false; reason: string; retry: boolean };

/** 开工单开 PR（已有同分支开着的 PR 就用它），修复单沿用订单的 PR；lab 的本地 bare 仓库没有 PR */
export async function ensurePr(p: PrInput, o: PushOpts = {}): Promise<PrResult> {
  if (p.pr !== null || labGitRoot(o.env ?? process.env)) return { ok: true, pr: p.pr };
  const s = setup({ ...p, cloneDir: "", orderHead: "" }, o);
  const gh = (args: string[]) => s.run(["gh", ...args], { cwd: s.dir, env: s.env, timeoutMs: 60_000 });
  const listed = await gh(["pr", "list", "--repo", p.repo, "--head", p.branch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
  if (listed.code !== 0) return { ok: false, reason: `查 PR 失败：${tail(listed)}`, retry: true };
  const have = Number(listed.stdout.trim());
  if (Number.isInteger(have) && have > 0) return { ok: true, pr: have };
  const bodyFile = join(s.dir, "PR_BODY.md");
  try { writeFileSync(bodyFile, p.body, { mode: 0o600 }); } catch (e) { return { ok: false, reason: `写 PR 正文失败：${(e as Error).message}`, retry: true }; }
  const made = await gh(["pr", "create", "--repo", p.repo, "--base", p.base, "--head", p.branch, "--title", p.title, "--body-file", bodyFile]);
  const n = Number(made.stdout.match(/\/pull\/(\d+)\s*$/m)?.[1]);
  if (made.code === 0 && Number.isInteger(n) && n > 0) return { ok: true, pr: n };
  return { ok: false, reason: `开 PR 失败：${tail(made)}`, retry: !DENIED.test(tail(made)) };
}
