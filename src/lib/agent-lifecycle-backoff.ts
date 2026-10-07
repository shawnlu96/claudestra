/**
 * Pending cleanups only a person can resolve (LIFE4, used by agent-lifecycle-cleanup-gate.ts and agent-lifecycle-run.ts): every checkout
 * left was kept because it has uncommitted change, or because it is the main repository rather than a linked worktree. Retrying cannot
 * make either better, so such a debt is retried at most every MANUAL_BACKOFF_MS — at once when its `git status --porcelain=v2` changes —
 * and PM is told once per (agent, regAt, kind). Nothing here touches disk: the cleanup rules themselves (agent-lifecycle-cleanup.ts) stay.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CleanupEntry, RetireRecord } from "./agent-lifecycle-store.js";
import type { Git } from "./scheduler-review-worktree.js";

export const MANUAL_BACKOFF_MS = 6 * 3_600_000;
export type ManualKind = "dirty" | "main_repo";

/** The reasons agent-lifecycle-cleanup.ts / -scan.ts give for a checkout kept until a person acts. */
const KINDS: readonly [ManualKind, RegExp][] = [
  ["dirty", /有已跟踪改动|未跟踪资料超过/],
  ["main_repo", /是主仓库而不是 linked worktree/],
];
const LABEL: Record<ManualKind, string> = { dirty: "有未提交改动", main_repo: "是主仓库而不是 linked worktree" };

/** The step agent-lifecycle-run.ts writes for a checkout it kept. */
const keptStep = (steps: readonly string[], e: CleanupEntry): string | undefined => steps.find((s) => s.startsWith(`worktree 没删 ${e.checkout}：`));

/**
 * The kind when every entry left was kept for a manual-only reason (dirty wins over main_repo when both occur); null = any entry
 * may still clear by itself (a holder, a write lease, a read error, a temp folder), so it is retried as usual.
 */
export function manualKind(r: Pick<RetireRecord, "pending" | "steps">): ManualKind | null {
  if (!r.pending.length) return null;
  const kinds = r.pending.map((e) => {
    const step = keptStep(r.steps, e);
    return step ? KINDS.find(([, re]) => re.test(step))?.[0] ?? null : null;
  });
  if (kinds.some((k) => k === null)) return null;
  return kinds.includes("dirty") ? "dirty" : "main_repo";
}

interface Porcelain { digest: string; files: string[] }

/** The path of one `--porcelain=v2` line (no leading blank, so a trimmed output parses): ordinary 8 fields, rename 9 (+ tab + old), unmerged 10. */
const v2Path = (l: string): string => {
  const f = l.split(" "), skip = ({ "1": 8, "2": 9, u: 10 } as Record<string, number>)[f[0]] ?? 1;
  return f.slice(skip).join(" ").split("\t")[0];
};

/** `git status --porcelain=v2` of each checkout; null = any of them could not be read (the caller then retries as usual). */
async function porcelainOf(git: Git, checkouts: readonly string[]): Promise<Porcelain | null> {
  const parts: string[] = [], files: string[] = [];
  for (const c of checkouts) {
    const r = await git(["-C", c, "status", "--porcelain=v2"]).catch(() => null);
    if (!r || r.code !== 0) return null;
    parts.push(`${c}\0${r.out}`);
    for (const l of r.out.split("\n")) if (l.trim()) files.push(join(c, v2Path(l)));
  }
  return { digest: createHash("sha256").update(parts.join("\n")).digest("hex"), files };
}

/** What a manual-only debt remembers: its kind, the porcelain at that time (null = unread), and when it was last tried. */
export interface ManualMark { kind: ManualKind; porcelain: string | null; at: number }

const isKind = (v: unknown): v is ManualKind => v === "dirty" || v === "main_repo";
const isManualMark = (v: unknown): v is ManualMark => !!v && typeof v === "object" && isKind((v as ManualMark).kind)
  && ((v as ManualMark).porcelain === null || typeof (v as ManualMark).porcelain === "string")
  && typeof (v as ManualMark).at === "number" && Number.isFinite((v as ManualMark).at);

/**
 * Due again: MANUAL_BACKOFF_MS since the last try, or the uncommitted content changed (or cannot be read / was not read: no proof it
 * stayed the same), or the clock went back past the last try.
 */
export function manualDue(m: ManualMark, now: number, porcelain: string | null): boolean {
  return now - m.at >= MANUAL_BACKOFF_MS || now < m.at || porcelain === null || m.porcelain === null || porcelain !== m.porcelain;
}

const mb = (n: number | null): string => (n === null ? "大小未知" : `共 ${(n / 1048576).toFixed(1)}MB`);

/** The one PM notice for a debt that fell into a manual-only kind: directories, reason, the first 5 uncommitted files and their size. */
export function manualNotice(agent: string, kind: ManualKind, entries: readonly CleanupEntry[], steps: readonly string[],
  files: readonly string[] | null, bytes: number | null): string {
  const why = entries.map((e) => keptStep(steps, e)?.replace(/^worktree 没删 /, "") ?? e.checkout).join("；");
  const list = files === null ? "未提交文件读不出" : files.length
    ? `未提交文件 ${files.length} 项（前 5：${files.slice(0, 5).join(", ")}）${mb(bytes)}` : "没有未提交文件";
  return (`${agent} 的落地物要人工处理（${LABEL[kind]}），改为至少 ${MANUAL_BACKOFF_MS / 3_600_000} 小时重试一次、未提交内容一变即恢复每轮重试。`
    + `目录：${entries.map((e) => e.checkout).join(", ")}；${list}；原因：${why}`).slice(0, 1500);
}

/** What the gate passes in: git to read porcelain, du to size the uncommitted files (both absent in some tests: then no back-off). */
export interface ManualDeps { git?: Git; du?(paths: string[]): Promise<number | null>; now(): number }

/** dueRetries' rule for a slot that carries a valid manual mark; null = not manual (or no git to check it), use the usual back-off. */
export async function manualDueFor(mark: unknown, entries: readonly CleanupEntry[], now: number, git: Git | undefined): Promise<boolean | null> {
  if (!isManualMark(mark) || !git) return null;
  return manualDue(mark, now, (await porcelainOf(git, entries.map((e) => e.checkout)))?.digest ?? null);
}

/**
 * After a retire that left disk: the mark to store (none = not manual-only), whether PM was already told of this kind for this debt
 * (`quiet`), else the one notice. The ledger event is still written whenever the result changed (the gate decides that).
 */
export async function manualOutcome(deps: ManualDeps, agent: string, seen: Pick<RetireRecord, "pending" | "steps">, prev: unknown):
  Promise<{ mark?: ManualMark; quiet: boolean; notice?: string }> {
  const kind = manualKind(seen);
  if (!kind) return { quiet: false };
  const por = deps.git ? await porcelainOf(deps.git, seen.pending.map((e) => e.checkout)) : null;
  const mark: ManualMark = { kind, porcelain: por?.digest ?? null, at: deps.now() };
  if (isManualMark(prev) && prev.kind === kind) return { mark, quiet: true };
  const bytes = por?.files.length && deps.du ? await deps.du(por.files).catch(() => null) : null;
  return { mark, quiet: false, notice: manualNotice(agent, kind, seen.pending, seen.steps, por?.files ?? null, bytes) };
}
