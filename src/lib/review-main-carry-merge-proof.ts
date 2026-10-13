/**
 * CARRY2 second main-carry proof, tried only after the byte-exact net-diff proof (review-main-carry-proof.ts) failed: when main
 * and the card touched the same file, blob ids and hunk line numbers change though the card's own change did not. Both must hold:
 * a. clean merge, no hand edit: newHead has exactly two parents, first = oldHead, second = the verified main parent (on main's
 *    first-parent chain, checked by the caller's chain proof); `git merge-tree --write-tree oldHead <second>` reports no
 *    conflict and its tree is newHead's tree byte for byte.
 * b. same card change: per file, main...oldHead and main...newHead have the same headers (paths, add / delete, new-file mode)
 *    and the same +/- line sequence once index lines and hunk headers (line numbers) are dropped. Binary, gitlink and mode
 *    changes never take this road; only the byte-exact proof accepts them.
 * Switch: recovery key mainCarryMerge (off / observe / on, default observe). off never runs it; observe runs it and only appends
 * "on 会沿用" plus a digest to the unchanged refusal; on lets a pass take the existing carry write (formal PASS source gate and
 * hop limit unchanged). Read-only git, no fetch; any git error or timeout is a failure. tests/review-main-carry-merge-proof.test.ts.
 */
import { createHash } from "node:crypto";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import type { Git } from "./review-main-carry-proof.js";

const MAIN_CARRY_MERGE_KEY = "mainCarryMerge" as const;
const SHA = /^[a-f0-9]{40}$/;
const RANK: Record<RecoveryMode, number> = { off: 0, observe: 1, on: 2 };

/**
 * One repoDir may back several projects: the weakest mode wins (so on needs every one of them on), an unreadable policy or
 * config is off, and a repoDir no project names is off. Read every time, never throws.
 */
export function mainCarryMergeMode(repoDir: string, config: () => SchedulerConfig = readSchedulerConfig,
  policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    const ids = Object.entries(config().projects).filter(([, p]) => p.repoDir === repoDir).map(([id]) => id);
    if (!ids.length) return "off";
    const modes = ids.map((id) => {
      const p = policy(id, MAIN_CARRY_MERGE_KEY);
      return p.source === "error" || !(p.mode in RANK) ? "off" : p.mode;
    });
    return modes.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
  } catch { return "off"; }
}

export interface MergeCarryContext {
  git: Git;
  oldHead: string;
  newHead: string;
  /** the main parent the chain proof verified on main's first-parent chain */
  mainParent: string;
  hops: number;
  /** complete raw main...head net diff (the canonical netDiff, complete read) */
  diff: (head: string) => Promise<Buffer>;
}
type MergeCarryResult = Readonly<{ ok: true; reason: string; digest: string } | { ok: false; reason: string }>;
const fail = (reason: string): MergeCarryResult => Object.freeze({ ok: false, reason });

async function out(git: Git, args: string[], okCodes = [0]): Promise<{ code: number; text: string }> {
  const r = await git(args);
  if (!okCodes.includes(r.code) || r.stderr.length) throw new Error(`git ${args[0]} 失败或警告：exit ${r.code}`);
  return { code: r.code, text: r.stdout.toString("latin1") };
}

/** a: the merge commit is exactly what git's own clean merge of the two parents produces. */
async function cleanMerge(c: MergeCarryContext): Promise<string | null> {
  if (c.hops !== 1) return "只认单跳干净合并";
  const [self, ...parents] = (await out(c.git, ["rev-list", "--parents", "-n", "1", c.newHead])).text.trim().toLowerCase().split(/\s+/);
  if (self !== c.newHead || parents.length !== 2 || parents.some((p) => !SHA.test(p))) return "新 head 不是双亲 merge";
  if (parents[0] !== c.oldHead || parents[1] !== c.mainParent) return "第一父不是原审查 head 或第二父不是 main 父提交";
  // exit 1 = conflicts (the tree then carries conflict markers); anything else is a git error and fails closed
  const merged = await out(c.git, ["merge-tree", "--write-tree", "--no-messages", c.oldHead, c.mainParent], [0, 1]);
  if (merged.code !== 0) return "两个父提交合并有冲突";
  const tree = merged.text.trim().toLowerCase();
  if (!SHA.test(tree)) return "merge-tree 没给出完整 tree";
  const actual = (await out(c.git, ["rev-parse", "--verify", `${c.newHead}^{tree}`])).text.trim().toLowerCase();
  return actual === tree ? null : "合并提交的 tree 与干净合并结果不同（有手改）";
}

type FilePatch = { header: string[]; changes: string[] };
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const UNSUPPORTED = /^(?:old mode |new mode |GIT binary patch|Binary files |Subproject commit )|^(?:new file|deleted file) mode 160000|^index \S+ 160000/;

/** Split a canonical net diff into per-file headers + the +/- sequence; a string = why this proof does not accept it. */
function filePatches(diff: string): FilePatch[] | string {
  if (!diff.length) return [];
  if (!diff.startsWith("diff --git ")) return "净 diff 格式无法识别";
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null, inHunk = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { header: [line], changes: [] }; files.push(cur); inHunk = false; continue; }
    if (UNSUPPORTED.test(line) && !inHunk) return "binary / gitlink / mode 改动只认逐字证明";
    if (HUNK.test(line)) { inHunk = true; continue; }
    if (!inHunk) { if (!line.startsWith("index ")) cur!.header.push(line); continue; }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) cur!.changes.push(line);
    else if (!line.startsWith(" ") && line !== "") return "净 diff hunk 里有无法识别的行";
  }
  return files;
}

/** b: the card's own change, compared without blob ids or line numbers. */
export function sameCardChange(before: string, after: string): { ok: true; digest: string; files: number } | { ok: false; reason: string } {
  const [a, b] = [filePatches(before), filePatches(after)];
  if (typeof a === "string") return { ok: false, reason: a };
  if (typeof b === "string") return { ok: false, reason: b };
  const norm = (f: FilePatch[]) => JSON.stringify(f.map((x) => [x.header, x.changes]));
  if (norm(a) !== norm(b)) return { ok: false, reason: a.length !== b.length ? "卡侧改动的文件集变了" : "卡侧 +/- 行或文件头变了" };
  return { ok: true, digest: createHash("sha256").update(norm(b)).digest("hex"), files: b.length };
}

/** Never throws: a git error, timeout or truncated read is a failure. */
async function mergeCarryProof(c: MergeCarryContext): Promise<MergeCarryResult> {
  try {
    const why = await cleanMerge(c);
    if (why) return fail(why);
    const same = sameCardChange((await c.diff(c.oldHead)).toString("latin1"), (await c.diff(c.newHead)).toString("latin1"));
    if (!same.ok) return fail(same.reason);
    return Object.freeze({ ok: true, digest: same.digest,
      reason: `干净合并：tree 与 merge-tree 一致，卡侧 ${same.files} 个文件 +/- 行一致 sha256=${same.digest.slice(0, 16)}` });
  } catch (e) {
    return fail(`干净合并证明读取失败：${(e as Error).message.slice(0, 120)}`);
  }
}

/** What the byte-exact proof appends to its refusal (observe), or the pass it takes instead (on). */
export async function mergeCarryFallback(mode: () => RecoveryMode, c: MergeCarryContext): Promise<{ carry: string } | { note: string }> {
  const m = mode();
  if (m === "off") return { note: "" };
  const r = await mergeCarryProof(c);
  if (m === "on" && r.ok) return { carry: r.reason };
  return { note: r.ok ? `；mainCarryMerge=observe：on 会沿用（${r.reason}）` : `；干净合并证明不成立：${r.reason}` };
}
