/**
 * i28-RH1: the merge driver moved the head (update-branch merged main in, the carry was refused) and sent the card back to
 * review. That move is the round's "delivery": its merge_phase receipt spells out old head → new head and the main parent,
 * scheduler-review.ts p1RowsByRound takes the new head from it like from a deliver event, and the re-review order is scoped
 * to the PR's net change against main (review-converge-order.ts), and so is the planner's fix diff (review-converge-scope.ts),
 * not "last reviewed head → new head", which would pull in all of main. Only the record the driver writes counts: actor scheduler, updating → await_review, the receipt below,
 * and the merge → review stage event of the same transaction right before it with the same head. tests/scheduler-review-rebase.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import type { ReviewCarry } from "./scheduler-merge-driver.js";
import type { FixDiff } from "./review-converge.js";
import { existsSync } from "node:fs";
import { statePath } from "./paths.js";
import { REPO_ROOT } from "./repo-root.js";

export interface RebaseHead { oldHead: string; newHead: string; mainParent: string; round: number }

const SHA = /^[a-f0-9]{40}$/i;
const RECEIPT = /^update-branch 改了 head：原 head ([a-f0-9]{40}) → 新 head ([a-f0-9]{40})，main 父提交 ([a-f0-9]{40})，[\s\S]*旧审查失效$/;

/** The await_review receipt; without a main parent there is nothing to scope against, so the old wording stays and nothing is recognized. */
export function movedHeadReceipt(oldHead: string, newHead: string, carry: ReviewCarry): string {
  const why = carry.reason.slice(0, 300);
  return carry.mainParent && SHA.test(carry.mainParent) && SHA.test(oldHead) && SHA.test(newHead)
    ? `update-branch 改了 head：原 head ${oldHead} → 新 head ${newHead}，main 父提交 ${carry.mainParent}，${why}，旧审查失效`
    : `update-branch 改了 head：${newHead.slice(0, 12)}，${why}，旧审查失效`;
}

/** The driver's head-change record, or null for anything else (a PM note, a peer copy, a receipt without a main parent). */
function rebaseRecord(events: readonly LedgerEvent[], e: LedgerEvent): RebaseHead | null {
  if (e.kind !== "scheduler" || e.actor !== "scheduler" || e.data.op !== "merge_phase" || e.data.from !== "updating" ||
    e.data.to !== "await_review" || typeof e.data.receipt !== "string") return null;
  const m = RECEIPT.exec(e.data.receipt);
  const stage = events.find((x) => x.seq === e.seq - 1);
  if (!m || stage?.kind !== "stage" || stage.actor !== "scheduler" || stage.target !== e.target || stage.data.from !== "merge" ||
    stage.data.to !== "review" || stage.data.head !== m[2] || typeof stage.data.round !== "number") return null;
  return { oldHead: m[1]!, newHead: m[2]!, mainParent: m[3]!, round: stage.data.round };
}

/** The newest delivery or driver head change before `seq`, as the event and (for a head change) its record. */
function lastHandIn(events: readonly LedgerEvent[], seq: number): { e: LedgerEvent; rebase: RebaseHead | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq >= seq) continue;
    if (e.kind === "deliver") return { e, rebase: null };
    const rebase = rebaseRecord(events, e);
    if (rebase) return { e, rebase };
  }
  return null;
}

/** The head a review of `review.data.round` had to cover: the last deliver's, or the driver's new head for that same round. */
export function deliveredHead(events: readonly LedgerEvent[], review: LedgerEvent): unknown {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const last = lastHandIn(sorted, review.seq);
  if (!last) return undefined;
  return last.rebase ? (last.rebase.round === review.data.round ? last.rebase.newHead : undefined) : last.e.data.headSHA;
}

/** The head change this round's review order answers to: the newest hand-in is the driver's, for this round and head. */
export function currentRebase(round: number, events: readonly LedgerEvent[], head: string): (RebaseHead & { taskId: string }) | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const last = lastHandIn(sorted, Number.POSITIVE_INFINITY);
  return last?.rebase && last.rebase.round === round && last.rebase.newHead.toLowerCase() === head.toLowerCase()
    ? { ...last.rebase, taskId: last.e.target } : null;
}

type DiffRunner = (dir: string, from: string, to: string) => string[] | null;
/** Same checkouts as review-converge-scope.ts diffDirs (not imported: that module sits above scheduler-review.ts). */
const diffDirs = (taskId: string): string[] => [statePath("worktrees", `rv-${taskId.toLowerCase()}`), statePath("worktrees", taskId.toLowerCase()), REPO_ROOT]
  .filter((d) => existsSync(d));
const gitPrFiles: DiffRunner = (dir, from, to) => {
  const r = Bun.spawnSync(["git", "-C", dir, "diff", "--name-only", "--no-renames", "-z", `${from}...${to}`], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : null;
};
/** Seam for tests; local git only (no fetch), the same checkouts the planner's fix-diff reads. */
export const rebaseDiff: { run: DiffRunner; dirs: (taskId: string) => string[] } = { run: gitPrFiles, dirs: diffDirs };
const cache = new Map<string, string[]>();

/** The PR's own files against main: `main parent...new head`, i.e. what `gh pr diff --name-only` lists; null if no checkout has both. */
function prFiles(r: RebaseHead & { taskId: string }): string[] | null {
  const key = `${r.mainParent}...${r.newHead}`;
  const hit = cache.get(key);
  if (hit) return hit;
  for (const dir of rebaseDiff.dirs(r.taskId)) {
    let files: string[] | null = null;
    try { files = rebaseDiff.run(dir, r.mainParent, r.newHead); } catch { continue; }
    if (!files) continue;
    cache.set(key, files);
    return files;
  }
  return null;
}

/**
 * The planner's fix diff (review-converge-scope.ts fixDiffOf) on a driver re-review: the PR's files against main, the same list
 * the order hands the reviewer, so a P1 the order put in scope is never demoted as outside "last head → new head" and code main
 * brought in stays out. undefined = not such a round (ordinary rule); null = no checkout can answer (nothing is demoted).
 */
export function rebaseFixDiff(round: number, events: readonly LedgerEvent[], from: string, to: string): FixDiff | null | undefined {
  const r = currentRebase(round, events, to);
  if (!r) return undefined;
  const files = prFiles(r);
  return files ? { from, to, files } : null;
}

const LIST_BYTES = 1700;
function fileList(files: string[]): string {
  const shown: string[] = [];
  let bytes = 0;
  for (const f of files) {
    const item = JSON.stringify(f);
    if (bytes + Buffer.byteLength(item) + 2 > LIST_BYTES) break;
    shown.push(item);
    bytes += Buffer.byteLength(item) + 2;
  }
  const rest = files.length - shown.length;
  return `PR 自己的文件（${files.length} 个，相对 main）：${shown.join("、") || "（无）"}${rest ? `，另有 ${rest} 个见 gh pr diff --name-only` : ""}`;
}

/**
 * Review order lines for a re-review after the driver moved the head; null on an ordinary round (its order stays as it was).
 * Short refs only: order free text is scanned by the peer secret gate, full heads travel in structured fields.
 */
export function rebaseScopeLines(round: number, events: readonly LedgerEvent[], head: string): string[] | null {
  const r = currentRebase(round, events, head);
  if (!r) return null;
  const [o, n, m] = [r.oldHead, r.newHead, r.mainParent].map((s) => s.slice(0, 12));
  const files = prFiles(r);
  return [
    `本轮是合并驱动把 main 合进分支后的重审（head ${o} → ${n}，合入的 main 父提交 ${m}）：审查范围 = PR 相对当前 main 的净改动，` +
      `比较基线是 main，不是上一轮审过的 head（等价于 gh pr diff --name-only / git diff ${m}...${n}）。`,
    "合并 main 带进来的别卡代码不在范围内：在那里发现的问题记 P2，并在 probe 里注明归属的卡，不判 P1。",
    files ? fileList(files) : "PR 文件清单本机未能算出：自己用 gh pr diff --name-only 取，只审清单里的文件。",
  ];
}
