/**
 * 出借单的工作副本（docs/design/remote-capacity.md §2.3 第 4 步、§5）：statePath("lend", <单目录>) 下 git init 一个全新仓库，只从
 * GitHub 取订单给的完整 SHA，checkout 后核 HEAD == 订单 head。不是 B 任何仓库的 worktree：不共享 .git、stash、分支。
 * git 在白名单环境里跑（runtimes/clean-env.ts，外加 GIT_TERMINAL_PROMPT=0：私有仓库没权限就直接失败，不卡在输入密码上）。
 * 软链一律不落盘：core.symlinks=false 让仓库里的软链检出成普通文本文件（内容是链接路径），检出后再扫一遍，树里还有任何软链就不起 worker。
 * 不判「指向里面还是外面」：链式软链（same → .，.env → same/../x）按字面算在里面、实际逃出去，判不准就不判。
 * 写单（i28-R6）另外：在订单 head 上切出订单分支，再给这个副本上「推不出去」的锁（WRITE_LOCK：禁掉全部传输协议、清空凭据助手、
 * askPass / ssh 都指向 false）——worker 照派单或被注入去 `git push` 都失败；推送只由出借服务从另一个目录做（lend-push.ts）。
 * 锁是配置不是边界：worker 和出借人是同一个系统用户，有意改回配置就能推（设计稿 §5 的已知限制）。
 * 任何一步失败都返回 { ok:false }，调用方按 not_started 释放；删目录只删 LEND_ROOT 之下、名字对得上的那一个。tests/lend-clone.test.ts、tests/lend-write.test.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { LEND_BRANCH_RE, lendRepoUrl } from "./lend-git.js";
import { isFullSha } from "./order-wire.js";
import { statePath } from "./paths.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";

export const LEND_ROOT = statePath("lend");
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const GIT_TIMEOUT_MS = 10 * 60_000;

export type Run = (argv: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs: number }) => Promise<BoundedResult>;

/** orderId 可以带 `:`；目录名换成安全字符再接一段哈希，两张单永远落不到同一个目录，也拼不出 `..` */
export function orderDirName(orderId: string): string {
  const safe = orderId.replace(/[^\w.-]/g, "_").slice(0, 60);
  return `${safe}-${createHash("sha256").update(orderId).digest("hex").slice(0, 12)}`;
}

/** work = worker 的工作副本；push = 出借服务推送用的独立目录（lend-push.ts），两边不共用 .git */
type Area = "work" | "push";
export const orderDir = (orderId: string, root = LEND_ROOT, area: Area = "work"): string => join(root, area, orderDirName(orderId));

function gitEnv(base: Record<string, string | undefined>): Record<string, string> {
  return { ...pickWorkerEnv(base), GIT_TERMINAL_PROMPT: "0" };
}

/** 写单：订单分支与提交署名（出借人自己的 git 身份；副本里没有全局配置可读） */
export interface CloneWrite { branch: string; name: string; email: string }
export interface CloneInput { orderId: string; repo: string; pr: number | null; head: string; write?: CloneWrite }

/** 写单副本的锁：worker 在这里 push 任何地址（origin、URL、本地路径、ext::）都在传输层被拒，也拿不到凭据 */
export const WRITE_LOCK: readonly [string, string][] = [
  ["protocol.allow", "never"], ["credential.helper", ""], ["core.askPass", "false"], ["core.sshCommand", "false"],
  ["remote.origin.pushurl", "lend-no-push://worker-may-not-push"],
];
export type CloneResult = { ok: true; dir: string } | { ok: false; reason: string };

const tail = (r: BoundedResult): string => (r.timedOut ? "超时" : (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300));

/**
 * 新 clone + 核 head。目录已存在（上次做到一半重启）就先删掉重来：没起过 worker 的目录里没有要保留的东西。
 * fork PR 的提交只经 refs/pull/<N>/head 可达：直接按 SHA 取不到时再取这个 ref，最后仍以 HEAD == head 为准。
 */
export async function prepareClone(input: CloneInput, o: { root?: string; env?: Record<string, string | undefined>; run?: Run } = {}): Promise<CloneResult> {
  const root = o.root ?? LEND_ROOT;
  if (!REPO.test(input.repo)) return { ok: false, reason: `仓库坐标不合法：${input.repo}` };
  if (!isFullSha(input.head)) return { ok: false, reason: "订单 head 不是完整 SHA" };
  if (input.write && !LEND_BRANCH_RE.test(input.write.branch)) return { ok: false, reason: `订单分支 ${input.write.branch.slice(0, 80)} 不是出借分支` };
  const dir = orderDir(input.orderId, root);
  const env = gitEnv(o.env ?? process.env);
  const run: Run = o.run ?? ((argv, opts) => runBounded(argv, opts));
  const git = (args: string[]) => run(["git", ...args], { cwd: dir, env, timeoutMs: GIT_TIMEOUT_MS });
  try {
    removeOrderDir(input.orderId, root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ok: false, reason: `建工作目录失败：${(e as Error).message}` };
  }
  const steps: [string, string[]][] = [
    ["git init", ["init", "-q"]],
    ["关软链", ["config", "core.symlinks", "false"]],
    ["加 origin", ["remote", "add", "origin", lendRepoUrl(input.repo, o.env ?? process.env)]],
  ];
  for (const [what, args] of steps) {
    const r = await git(args);
    if (r.code !== 0) return { ok: false, reason: `${what}失败：${tail(r)}` };
  }
  let got = await git(["fetch", "--no-tags", "-q", "origin", input.head]);
  if (got.code !== 0 && input.pr) got = await git(["fetch", "--no-tags", "-q", "origin", `refs/pull/${input.pr}/head`]);
  if (got.code !== 0) return { ok: false, reason: `取不到 ${input.head.slice(0, 12)}：${tail(got)}` };
  const co = await git(["-c", "advice.detachedHead=false", "-c", "core.symlinks=false", "checkout", "-q", "--detach", input.head]);
  if (co.code !== 0) return { ok: false, reason: `checkout 失败：${tail(co)}` };
  const head = await git(["rev-parse", "HEAD"]);
  const actual = head.stdout.trim().toLowerCase();
  if (head.code !== 0 || actual !== input.head.toLowerCase()) return { ok: false, reason: `HEAD ${actual.slice(0, 12) || "读不到"} 与订单 head ${input.head.slice(0, 12)} 不一致` };
  const link = firstSymlink(dir);
  if (link) return { ok: false, reason: `工作副本里有软链 ${link}（应已检出成文本文件），不起 worker` };
  // 审查要对比基线：取对方默认分支，取不到不算失败（worker 仍能看提交本身）
  await git(["fetch", "--no-tags", "-q", "origin", "HEAD:refs/remotes/origin/HEAD"]);
  if (input.write) {
    const w = input.write;
    const steps: [string, string[]][] = [["切订单分支", ["-c", "core.symlinks=false", "checkout", "-q", "-b", w.branch]],
      ["设署名", ["config", "user.name", w.name]], ["设署名", ["config", "user.email", w.email]], ...WRITE_LOCK.map(([k, v]): [string, string[]] => ["上锁", ["config", k, v]])];
    for (const [what, args] of steps) {
      const r = await git(args);
      if (r.code !== 0) return { ok: false, reason: `${what}失败：${tail(r)}` };
    }
  }
  return { ok: true, dir };
}

/** 工作树里第一个软链（相对 dir 的路径）；没有 = null。不跟随软链、不看它指向哪；根下的 .git 是我们自己 git init 的，不扫 */
export function firstSymlink(dir: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name);
      if (cur === dir && e.name === ".git") continue;
      if (e.isSymbolicLink()) return relative(dir, p);
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** 真实路径必须落在 LEND_ROOT/<work|push> 之下、且正是这张单的目录名：软链或拼错的路径一律不删 */
export function removeOrderDir(orderId: string, root = LEND_ROOT, area: Area = "work"): boolean {
  const dir = orderDir(orderId, root, area);
  if (!existsSync(dir)) return false;
  const work = realpathSync(join(root, area));
  const real = realpathSync(dir);
  const rel = relative(work, real);
  if (rel !== orderDirName(orderId) || rel.includes(sep)) throw new Error(`拒绝删除 ${dir}：真实路径 ${real} 不是出借工作目录`);
  rmSync(real, { recursive: true, force: true });
  return true;
}
