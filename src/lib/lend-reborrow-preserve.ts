/** Retain committed provider checkpoints in a separate bundle, then prove each is included in the new remote starting head. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LendRow } from "./lend-journal.js";
import { orderOf } from "./lend-journal.js";
import { orderDirName, firstSymlink } from "./lend-clone.js";
import { lendRepoUrl, remoteHeadAt } from "./lend-git.js";
import { runBounded } from "./run-bounded.js";
import { pickWorkerEnv } from "./runtimes/clean-env.js";
import { statePath } from "./paths.js";
import { writeTextAtomicSync } from "./state-file.js";

const sha = /^[0-9a-f]{40}$/;
const bad = (): never => { throw new Error("来源失读、未交修改或检查点未保全对账"); };

export async function preserveReborrowGit(old: LendRow, next: LendRow): Promise<void> {
  const o = orderOf(next), prior = orderOf(old), head = String(o?.head), repo = String(o?.repo), branch = next.wire?.write?.branch;
  if (!sha.test(head) || !branch || !old.dir || !prior || !sha.test(String(prior.head))) bad();
  const dir = realpathSync(old.dir!), env = { ...pickWorkerEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  if (firstSymlink(dir)) bad();
  if (old.state !== "acked" && ["summary.txt", "selfcheck.md"].some((file) => existsSync(join(dir, file)))) bad();
  const git = async (cwd: string, args: string[]) => {
    const r = await runBounded(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, timeoutMs: 60_000 });
    if (r.code !== 0 || r.timedOut) bad();
    return r.stdout.trim();
  };
  const snapshot = async () => {
    if (await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"])) bad();
    const current = await git(dir, ["rev-parse", "HEAD"]);
    const refs = await git(dir, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/checkpoints", "refs/stash"]);
    const reflog = await git(dir, ["reflog", "show", "--format=%H", "HEAD"]);
    const heads = [...new Set([String(prior!.head), current, ...refs.split("\n"), ...reflog.split("\n"), old.work?.head ?? ""].filter(Boolean))].sort();
    if (heads.some((h) => !sha.test(h))) bad();
    return { current, heads };
  };
  const before = await snapshot();
  const remote = await remoteHeadAt(repo, branch!, runBounded);
  if (!remote.ok || remote.head !== head) bad();
  const scratch = mkdtempSync(join(tmpdir(), "lend-reborrow-"));
  try {
    await git(scratch, ["init", "--bare", "-q"]);
    await git(scratch, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", dir, "+refs/*:refs/retained/*", "HEAD:refs/retained/head"]);
    await git(scratch, ["fetch", "--no-tags", lendRepoUrl(repo), `refs/heads/${branch}:refs/heads/remote`]);
    if (await git(scratch, ["rev-parse", "refs/heads/remote"]) !== head) bad();
    for (const checkpoint of before.heads) await git(scratch, ["merge-base", "--is-ancestor", checkpoint, head]);
    const kept = statePath("lend", "reborrow", orderDirName(next.orderId));
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    const bundle = join(kept, `source-${old.leaseGen}.bundle`), temp = join(kept, `source-${old.leaseGen}.${process.pid}.tmp`);
    await git(scratch, ["bundle", "create", temp, "--all"]);
    await git(scratch, ["bundle", "verify", temp]);
    if (JSON.stringify(await snapshot()) !== JSON.stringify(before)) bad();
    const fresh = await remoteHeadAt(repo, branch!, runBounded);
    if (!fresh.ok || fresh.head !== head) bad();
    renameSync(temp, bundle);
    writeTextAtomicSync(join(kept, "source.json"), JSON.stringify({ oldOrderId: old.orderId, gen: old.leaseGen,
      orderId: next.orderId, remoteHead: head, checkpoints: before.heads, bundle: `source-${old.leaseGen}.bundle` }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
