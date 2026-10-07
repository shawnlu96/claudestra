/**
 * Pending cleanups only a person can resolve (LIFE4, used by agent-lifecycle-cleanup-gate.ts and agent-lifecycle-run.ts): every checkout
 * left was kept because it has uncommitted change, or because it is the main repository rather than a linked worktree. Retrying cannot
 * make either better, so such a debt is retried at most every MANUAL_BACKOFF_MS — at once when its `git status --porcelain=v2` changes —
 * and PM is told once per (agent, regAt, kind). Nothing here touches disk: the cleanup rules themselves (agent-lifecycle-cleanup.ts) stay.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CleanupEntry, RetireRecord } from "./agent-lifecycle-store.js";
import type { Action } from "./agent-lifecycle.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { Git } from "./scheduler-review-worktree.js";

export const MANUAL_BACKOFF_MS = 6 * 3_600_000;
export type ManualKind = "dirty" | "main_repo";

/**
 * The reasons agent-lifecycle-cleanup.ts / -scan.ts give for a checkout kept until a person acts. Anchored at the start of the reason
 * (the text after `worktree 没删 <checkout>：`), so a directory or file name quoted later in a step never passes for one.
 */
const KINDS: readonly [ManualKind, RegExp][] = [
  ["dirty", /^(有已跟踪改动|未跟踪资料超过)/],
  ["main_repo", /^是主仓库而不是 linked worktree/],
];
const LABEL: Record<ManualKind, string> = { dirty: "有未提交改动", main_repo: "是主仓库而不是 linked worktree" };

const keptPrefix = (e: CleanupEntry) => `worktree 没删 ${e.checkout}：`;
/** The reason agent-lifecycle-run.ts wrote for a checkout it kept (the text after the checkout). */
const keptWhy = (steps: readonly string[], e: CleanupEntry): string | undefined =>
  steps.find((s) => s.startsWith(keptPrefix(e)))?.slice(keptPrefix(e).length);

/**
 * The kind when every entry left was kept for a manual-only reason (dirty wins over main_repo when both occur); null = any entry
 * may still clear by itself (a holder, a write lease, a read error, a temp folder), so it is retried as usual.
 */
export function manualKind(r: Pick<RetireRecord, "pending" | "steps">): ManualKind | null {
  if (!r.pending.length) return null;
  const kinds = r.pending.map((e) => {
    const why = keptWhy(r.steps, e);
    return why === undefined ? null : KINDS.find(([, re]) => re.test(why))?.[0] ?? null;
  });
  if (kinds.some((k) => k === null)) return null;
  return kinds.includes("dirty") ? "dirty" : "main_repo";
}

export interface Porcelain { digest: string; each: { checkout: string; digest: string }[]; files: string[] }

/**
 * The paths of a `git status --porcelain=v2 -z` output: NUL-separated records, the path unquoted after a fixed number of fields
 * (ordinary 8, rename / copy 9 and then one more record with the original path, unmerged 10, untracked / ignored 1); headers skipped.
 */
export function v2Paths(out: string): string[] {
  const recs = out.split("\0"), paths: string[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i], skip = ({ "1": 8, "2": 9, u: 10, "?": 1, "!": 1 } as Record<string, number>)[r[0]];
    if (!skip) continue;
    paths.push(r.split(" ").slice(skip).join(" "));
    if (r[0] === "2") i++; // the original path of a rename / copy
  }
  return paths;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** `git status --porcelain=v2 -z` of each checkout; null = any of them could not be read (the caller then retries as usual). */
export async function porcelainOf(git: Git, checkouts: readonly string[]): Promise<Porcelain | null> {
  const each: Porcelain["each"] = [], files: string[] = [];
  for (const c of checkouts) {
    const r = await git(["-C", c, "status", "--porcelain=v2", "-z"]).catch(() => null);
    if (!r || r.code !== 0) return null;
    each.push({ checkout: c, digest: sha(r.out) });
    files.push(...v2Paths(r.out).map((p) => join(c, p)));
  }
  return { digest: sha(each.map((e) => `${e.checkout}\0${e.digest}`).join("\n")), each, files };
}

/**
 * One step per checkout naming its uncommitted content's fingerprint: a staged content change that keeps the same file names and
 * kinds still changes the event's steps, so it is recorded (gate digest and the store's no-progress check both read steps).
 */
const fingerprintSteps = (p: Porcelain): string[] => p.each.map((e) => `未提交内容 ${e.checkout}：指纹 ${e.digest.slice(0, 12)}`);

/** What a manual-only debt remembers: its kind, the porcelain at that time (null = unread), and when it was last tried. */
export interface ManualMark { kind: ManualKind; porcelain: string | null; at: number }

const isKind = (v: unknown): v is ManualKind => v === "dirty" || v === "main_repo";
const isManualMark = (v: unknown): v is ManualMark => !!v && typeof v === "object" && isKind((v as ManualMark).kind)
  && ((v as ManualMark).porcelain === null || typeof (v as ManualMark).porcelain === "string")
  && typeof (v as ManualMark).at === "number" && Number.isFinite((v as ManualMark).at);
/** The kinds PM was told of for this debt, as stored (anything malformed reads as "not told": at worst one more notice). */
const notifiedOf = (v: unknown): ManualKind[] => (Array.isArray(v) ? v.filter(isKind) : []);

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
  const why = entries.map((e) => `${e.checkout}：${keptWhy(steps, e) ?? "?"}`).join("；");
  const list = files === null ? "未提交文件读不出" : files.length
    ? `未提交文件 ${files.length} 项（前 5：${files.slice(0, 5).join(", ")}）${mb(bytes)}` : "没有未提交文件";
  return (`${agent} 的落地物要人工处理（${LABEL[kind]}），改为至少 ${MANUAL_BACKOFF_MS / 3_600_000} 小时重试一次、未提交内容一变即恢复每轮重试。`
    + `目录：${entries.map((e) => e.checkout).join(", ")}；${list}；原因：${why}`).slice(0, 1500);
}

/** What the gate passes in: git to read porcelain, du to size the uncommitted files (both absent in some tests: then no back-off). */
export interface ManualDeps {
  git?: Git; du?(paths: string[]): Promise<number | null>; now(): number;
  /** the existing PM notice channel (production: notifyProjectPm); absent = the notice goes out through the pass's failed list */
  notifyPm?(a: Action, text: string): Promise<void>;
}

/**
 * dueRetries' rule for a slot with a valid manual mark whose kind PM was told of; null = not manual, PM not told yet (retried with
 * the usual back-off so the notice is sent again soon), or no git to check it.
 */
export async function manualDueFor(mark: unknown, notified: unknown, entries: readonly CleanupEntry[], now: number, git: Git | undefined): Promise<boolean | null> {
  if (!isManualMark(mark) || !git || !notifiedOf(notified).includes(mark.kind)) return null;
  return manualDue(mark, now, (await porcelainOf(git, entries.map((e) => e.checkout)))?.digest ?? null);
}

/** Before the ledger write: the kind of this result and its porcelain, and the record with the fingerprint steps added. */
export async function withFingerprint(deps: ManualDeps, r: RetireRecord): Promise<{ r: RetireRecord; kind: ManualKind | null; por: Porcelain | null }> {
  const kind = manualKind(r);
  const por = kind && deps.git ? await porcelainOf(deps.git, r.pending.map((e) => e.checkout)) : null;
  return { r: por ? { ...r, steps: [...r.steps, ...fingerprintSteps(por)] } : r, kind, por };
}

/**
 * After a retire that left disk: the mark to store (none = not manual-only), the kinds PM has now been told of for this debt (kept
 * apart from the mark, so a kind switch or a non-manual result in between never makes PM hear of the same kind twice), and whether
 * the pass should stay quiet about it. A notice is sent once per kind; only a delivered one is counted as told (a failed send is
 * reported in the pass's failed list and tried again next time).
 */
export async function manualOutcome(deps: ManualDeps, a: Action, seen: Pick<RetireRecord, "pending" | "steps"> & { kind: ManualKind | null; por: Porcelain | null },
  prevNotified: unknown): Promise<{ mark?: ManualMark; notified: ManualKind[]; told: boolean; notice?: string }> {
  const notified = notifiedOf(prevNotified), kind = seen.kind;
  if (!kind) return { notified, told: false };
  const mark: ManualMark = { kind, porcelain: seen.por?.digest ?? null, at: deps.now() };
  if (notified.includes(kind)) return { mark, notified, told: true };
  const bytes = seen.por?.files.length && deps.du ? await deps.du(seen.por.files).catch(() => null) : null;
  const notice = manualNotice(a.agent, kind, seen.pending, seen.steps, seen.por?.files ?? null, bytes);
  if (!deps.notifyPm) return { mark, notified: [...notified, kind], told: false, notice };
  try { await deps.notifyPm(a, notice); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return { mark, notified, told: false, notice: `${notice}（报 PM 没送达，下轮再报：${(e as Error).message}）` };
  }
  return { mark, notified: [...notified, kind], told: true };
}
