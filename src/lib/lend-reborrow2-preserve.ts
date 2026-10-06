/**
 * REBOR2 same-peer checkpoint retention. Every local checkpoint of the old copy (HEAD, branches, checkpoint refs, stash, reflog,
 * the recorded unpushed work head) goes into a verified bundle; heads already in the new start head and unpushed heads are
 * recorded separately. A dirty tree, a removed copy of an order that ever started, or any git failure refuses the claim.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { orderOf, type LendRow } from "./lend-journal.js";
import { firstSymlink, orderDirName } from "./lend-clone.js";
import { lendRepoUrl } from "./lend-git.js";
import { runBounded } from "./run-bounded.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";
import { statePath } from "./paths.js";
import { writeTextAtomicSync } from "./state-file.js";
import { remoteBranchState } from "./lend-reborrow2-source.js";

export class Reborrow2Refusal extends Error {}
const sha = /^[0-9a-f]{40}$/;
const refuse = (why: string): never => { throw new Reborrow2Refusal(why); };
/** The worker's deliverable text; recorded in journal `work` once submitted, so it is not an unsaved checkpoint. */
const DELIVERABLES = new Set(["summary.txt", "selfcheck.md"]);

type Git = (cwd: string, args: string[], ok?: number[]) => Promise<{ code: number; out: string }>;

function gitRunner(): Git {
  const env = { ...pickWorkerEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  return async (cwd, args, ok = [0]) => {
    const r = await runBounded(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, timeoutMs: 60_000 });
    if (r.timedOut || r.code === null || !ok.includes(r.code)) refuse("git 读取失败，来源失读");
    return { code: r.code as number, out: r.stdout.trim() };
  };
}

async function remoteState(repo: string, branch: string): Promise<string | null> {
  const s = await remoteBranchState(repo, branch);
  return s ? s.head : refuse("远端分支失读");
}

async function snapshot(git: Git, dir: string, old: LendRow, priorHead: string) {
  const dirty = (await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"])).out.split("\n").filter(Boolean)
    .filter((l) => !(l.startsWith("?? ") && DELIVERABLES.has(l.slice(3)) && old.work));
  if (dirty.length) refuse("原副本有未提交修改，无法证明检查点不丢");
  const current = (await git(dir, ["rev-parse", "HEAD"])).out;
  const refs = (await git(dir, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/checkpoints", "refs/stash"])).out;
  const reflog = (await git(dir, ["reflog", "show", "--format=%H", "HEAD"], [0, 128])).out;
  const heads = [...new Set([priorHead, current, ...refs.split("\n"), ...reflog.split("\n"), old.work?.head ?? ""].filter(Boolean))].sort();
  if (heads.some((h) => !sha.test(h))) refuse("检查点 head 失读");
  return heads;
}

/**
 * Old copy already removed: no archive of its refs / stash / reflog exists anywhere, and a pushed work head says nothing about
 * other checkpoints, so only an old order that never started a worker (nothing could have been made) is provably lossless.
 */
function removedCopy(old: LendRow): void {
  if (old.state === "released" && !old.startedAt && !old.work && !old.payload && !old.payloadSha) return;
  refuse("原副本已清理，没有完整检查点归档可核（已推 head 不能证明其它分支 / stash / reflog 已保全）");
}

export async function preserveReborrow2Git(old: LendRow, next: LendRow, git: Git = gitRunner()): Promise<void> {
  const o = orderOf(next), head = String(o?.head), repo = String(o?.repo), branch = next.wire?.write?.branch, priorHead = String(orderOf(old)?.head);
  if (!sha.test(head) || !branch || !sha.test(priorHead)) refuse("订单起点或分支失读");
  const remote = await remoteState(repo, branch!);
  if (remote !== null ? remote !== head : head !== priorHead) refuse("订单起点不是远端分支 head（或未推送时的原起点）");
  if (!old.dir || !existsSync(old.dir)) return removedCopy(old);
  const dir = realpathSync(old.dir);
  if (firstSymlink(dir)) refuse("原副本含符号链接");
  const before = await snapshot(git, dir, old, priorHead);
  const scratch = mkdtempSync(join(tmpdir(), "lend-reborrow2-"));
  try {
    await git(scratch, ["init", "--bare", "-q"]);
    await git(scratch, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", dir, "+refs/*:refs/retained/*", "HEAD:refs/retained/head"]);
    if (remote) await git(scratch, ["fetch", "--no-tags", lendRepoUrl(repo), `refs/heads/${branch}:refs/heads/remote`]);
    const inRemote: string[] = [], unpushed: string[] = [];
    for (const h of before) {
      await git(scratch, ["cat-file", "-e", `${h}^{commit}`]);
      const contained = h === head || (await git(scratch, ["merge-base", "--is-ancestor", h, head], [0, 1])).code === 0;
      (contained ? inRemote : unpushed).push(h);
    }
    for (const h of unpushed) await git(scratch, ["update-ref", `refs/unpushed/${h}`, h]);
    const kept = statePath("lend", "reborrow2", orderDirName(next.orderId));
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    const bundle = join(kept, `source-${old.leaseGen}.bundle`), temp = join(kept, `source-${old.leaseGen}.${process.pid}.tmp`);
    await git(scratch, ["bundle", "create", temp, "--all"]);
    await git(scratch, ["bundle", "verify", temp]);
    if (JSON.stringify(await snapshot(git, dir, old, priorHead)) !== JSON.stringify(before)) refuse("保全期间原副本漂移");
    if (await remoteState(repo, branch!) !== remote) refuse("保全期间远端分支漂移");
    renameSync(temp, bundle);
    writeTextAtomicSync(join(kept, "source.json"), JSON.stringify({ oldOrderId: old.orderId, gen: old.leaseGen, orderId: next.orderId,
      startHead: head, remoteHead: remote, inRemote, unpushed, bundle: `source-${old.leaseGen}.bundle` }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
