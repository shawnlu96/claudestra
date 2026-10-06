/**
 * Merge handoff (scheduler-merge-handoff-tick.ts): did a handed PR's head move only by the repository owner merging main in?
 * Its parents must be the followed head and one commit already on main, and the merge must have added nothing: the new tree is
 * git's own clean merge, or else the PR's net diff is byte-identical. Not review-main-carry-proof.ts (the local driver's and
 * review's gate): this one also holds after the PR merged (`onMain` = main before that merge, diffs against the main parent)
 * and when main touched a file the PR changed. tests/scheduler-merge-handoff-carry.test.ts.
 */
import { createHash } from "node:crypto";
import type { runBounded } from "./run-bounded.js";
import type { ReviewCarry } from "./scheduler-merge-driver.js";

export const MAIN_REF = "refs/remotes/origin/main";
/** runBounded silently stops reading at 1 MiB; anything near that may be cut, and two cut diffs could compare equal. */
const DIFF_LIMIT = 900 * 1024;
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 350) ?? "";
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
type Git = (...args: string[]) => Promise<string>;
/** `basis`: what proved it — the new tree is the clean automatic merge, or the net diff is byte-identical. */
export type MainMergeCarry = ReviewCarry & { basis?: "auto-merge" | "net-diff" };

/** No retry changes this answer: the diff can never be compared byte by byte. */
export class CarryUndecidable extends Error {}

/**
 * `git diff base...head` with every knob that could vary between calls pinned, and none that repository config can use to leave
 * a path out (`.gitmodules` ignore=all, `diff.relative`) or print two changes alike (`diff.submodule=log`). The raw records head
 * the patch, so every path's modes and full object ids are in the text whatever the patch format does or the decoding loses.
 */
async function netDiff(git: Git, base: string, head: string): Promise<string> {
  const out = await git("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary",
    "--full-index", "--ignore-submodules=none", "--no-relative", "--submodule=short", "--raw", "--patch", "--no-abbrev", `${base}...${head}`);
  if (Buffer.byteLength(out) >= DIFF_LIMIT) throw new CarryUndecidable("净 diff 太大，无法逐字核对");
  return out;
}

/** The tree git's own clean merge of `a` and `b` gives; null on conflicts or when this git cannot tell (then the net diff decides). */
async function autoMergeTree(command: typeof runBounded, cwd: string, a: string, b: string): Promise<string | null> {
  const r = await command(["git", "merge-tree", "--write-tree", "--no-messages", a, b], { cwd, env: gitEnv(), timeoutMs: 120_000 });
  const tree = r.stdout.trim().split("\n")[0] ?? "";
  return !r.timedOut && r.code === 0 && /^[a-f0-9]{40}$/i.test(tree) ? tree : null;
}

/**
 * `onMain`: what the other parent must already be an ancestor of. Both net diffs are taken against that main parent, which still
 * isolates the PR's own change once main contains the PR; each starts at its own merge base, so they only match when main did not
 * touch what the PR changed — the auto-merge tree covers that case first.
 */
export async function mainMergeCarry(git: Git, command: typeof runBounded, cwd: string, oldHead: string, newHead: string,
  onMain: string): Promise<MainMergeCarry> {
  const mainHead = (await git("rev-parse", "--verify", `${onMain}^{commit}`)).trim();
  const [self, ...parents] = (await git("rev-list", "--parents", "-n", "1", newHead)).trim().split(/\s+/);
  if (self?.toLowerCase() !== newHead.toLowerCase()) throw new Error("新 head 读不到");
  const others = parents.filter((p) => p.toLowerCase() !== oldHead.toLowerCase());
  if (parents.length !== 2 || others.length !== 1) return { ok: false, reason: `新 head 不是「原审查 head + main 提交」的合并提交（父提交 ${parents.length} 个）` };
  const mainParent = others[0]!;
  const ancestor = await command(["git", "merge-base", "--is-ancestor", mainParent, onMain], { cwd, env: gitEnv(), timeoutMs: 30_000 });
  if (ancestor.timedOut || (ancestor.code !== 0 && ancestor.code !== 1)) throw new Error(`git merge-base 失败：${oneLine(ancestor.stderr)}`);
  if (ancestor.code !== 0) return { ok: false, reason: `另一个父提交 ${mainParent.slice(0, 12)} 不在 main 上` };
  const after = await netDiff(git, mainParent, newHead);
  const diffHash = createHash("sha256").update(after).digest("hex");
  if (await autoMergeTree(command, cwd, oldHead, mainParent) === (await git("rev-parse", "--verify", `${newHead}^{tree}`)).trim()) {
    return { ok: true, reason: "新 head 就是原 head 与 main 父提交的自动合并", mainParent, mainHead, diffHash, basis: "auto-merge" };
  }
  if (await netDiff(git, mainParent, oldHead) !== after) return { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent, mainHead };
  return { ok: true, reason: "净 diff 一致", mainParent, mainHead, diffHash, basis: "net-diff" };
}
