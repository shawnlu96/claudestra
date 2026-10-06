/**
 * Whether a moved PR head only merged main in: its parents are the old head and one commit already on main, and the PR's net
 * diff is byte-identical (the handoff also accepts a tree that is git's own clean merge). Shared by the local merge driver's
 * update-branch (scheduler-merge-external.ts) and the merge handoff after the repository owner merged main into a handed PR
 * (scheduler-merge-handoff-tick.ts). tests/scheduler-merge-handoff-carry.test.ts.
 */
import { createHash } from "node:crypto";
import type { runBounded } from "./run-bounded.js";
import type { ReviewCarry } from "./scheduler-merge-driver.js";

export const MAIN_REF = "refs/remotes/origin/main";
/** runBounded silently stops reading at 1 MiB; anything near that may be cut, and two cut diffs could compare equal. */
const DIFF_LIMIT = 900 * 1024;
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 350) ?? "";
type Git = (...args: string[]) => Promise<string>;
/** `basis`: what proved it — the new tree is the clean automatic merge, or the net diff is byte-identical. */
export type MainMergeCarry = ReviewCarry & { basis?: "auto-merge" | "net-diff" };

/** No retry changes this answer: the diff can never be compared byte by byte. */
export class CarryUndecidable extends Error {}

/**
 * Net diff exactly as `git diff base...head` prints it, with every knob that could vary between calls pinned. `whole` also stops
 * repository config from leaving paths out (`.gitmodules` ignore=all hides a swapped gitlink, `diff.relative` all but one
 * directory) or from printing two changes alike (`diff.submodule=log` shows a gitlink by short prefix); the raw records head
 * the patch so every path's modes and full object ids are in the text, whatever the patch format does.
 */
const WHOLE = ["--ignore-submodules=none", "--no-relative", "--submodule=short", "--raw", "--patch", "--no-abbrev"];
async function netDiff(git: Git, base: string, head: string, whole = false): Promise<string> {
  const out = await git("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    "--binary", "--full-index", ...(whole ? WHOLE : []), `${base}...${head}`);
  if (Buffer.byteLength(out) >= DIFF_LIMIT) throw new CarryUndecidable("净 diff 太大，无法逐字核对");
  return out;
}

/** The tree git's own clean merge of `a` and `b` gives; null on conflicts or when this git cannot tell (then the net diff decides). */
async function autoMergeTree(command: typeof runBounded, cwd: string, a: string, b: string): Promise<string | null> {
  const r = await command(["git", "merge-tree", "--write-tree", "--no-messages", a, b],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 });
  const tree = r.stdout.trim().split("\n")[0] ?? "";
  return !r.timedOut && r.code === 0 && /^[a-f0-9]{40}$/i.test(tree) ? tree : null;
}

/**
 * `onMain`: what the other parent must already be an ancestor of. `diffBase`: what both net diffs are taken against; absent =
 * that main parent, which still isolates the PR's own change once main contains the PR (current main would then diff empty).
 * Each `git diff base...head` starts at its own merge base, so main touching a file the PR changed makes the two texts differ
 * though the PR did not change. `strict` (the handoff) first accepts a new tree that is exactly git's clean merge of the old head
 * and the main parent (only main came in), and compares whole net diffs; the local driver keeps its form unchanged.
 */
export async function mainMergeCarry(git: Git, command: typeof runBounded, cwd: string, oldHead: string, newHead: string,
  o: { onMain: string; diffBase?: string; strict?: boolean }): Promise<MainMergeCarry> {
  const mainHead = (await git("rev-parse", "--verify", `${o.onMain}^{commit}`)).trim();
  const [self, ...parents] = (await git("rev-list", "--parents", "-n", "1", newHead)).trim().split(/\s+/);
  if (self?.toLowerCase() !== newHead.toLowerCase()) throw new Error("新 head 读不到");
  const others = parents.filter((p) => p.toLowerCase() !== oldHead.toLowerCase());
  if (parents.length !== 2 || others.length !== 1) return { ok: false, reason: `新 head 不是「原审查 head + main 提交」的合并提交（父提交 ${parents.length} 个）` };
  const mainParent = others[0]!;
  const onMain = await command(["git", "merge-base", "--is-ancestor", mainParent, o.onMain],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
  if (onMain.timedOut || (onMain.code !== 0 && onMain.code !== 1)) throw new Error(`git merge-base 失败：${oneLine(onMain.stderr)}`);
  if (onMain.code !== 0) return { ok: false, reason: `另一个父提交 ${mainParent.slice(0, 12)} 不在 main 上` };
  const base = o.diffBase ?? mainParent;
  const after = await netDiff(git, base, newHead, o.strict);
  const diffHash = createHash("sha256").update(after).digest("hex");
  if (o.strict && await autoMergeTree(command, cwd, oldHead, mainParent) === (await git("rev-parse", "--verify", `${newHead}^{tree}`)).trim()) {
    return { ok: true, reason: "新 head 就是原 head 与 main 父提交的自动合并", mainParent, mainHead, diffHash, basis: "auto-merge" };
  }
  // parents verified: scheduler-review-rebase.ts scopes the re-review on this main parent
  if (await netDiff(git, base, oldHead, o.strict) !== after) return { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent, mainHead };
  return { ok: true, reason: "净 diff 一致", mainParent, mainHead, diffHash, ...(o.strict ? { basis: "net-diff" as const } : {}) };
}
