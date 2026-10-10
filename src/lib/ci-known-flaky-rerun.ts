/**
 * Merge gate side of the known flaky list (dispatch-recovery-CIF8): a red CI whose failing test files are all on the valid list
 * (ci-known-flaky.ts) and outside the PR is re-run once through CIF1's own claim (scheduler-merge-ci-rerun.ts), so the once per
 * head rule, the wait for the new attempt and the second-red bounce are CIF1's, not copies.
 * - Driver (knownFlakyRerun): runs where CIF1 would bounce for a non-timeout failure. It reads the PR files, then sends CIF1's
 *   claim with the failing files appended. It has no ledger handle, so the list and the switch are judged by the ledger side.
 * - Ledger (knownFlakyClaim), inside closeMergeRun's transaction: on + every file valid → the claim goes through, its event
 *   names the entries and their fixing nodes. observe → one event saying what on would do. Anything else → nothing.
 *   A claim that does not go through leaves the run untouched (same rev), and the driver then bounces exactly as before, through
 *   the same call, so CIF2's layer still sees that bounce. Every doubt bounces (fail-closed).
 * tests/ci-known-flaky-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import { activeKnownFlaky, isKnownFlakyFile, knownFlakyMode, type KnownFlakyEntry } from "./ci-known-flaky.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { EventKind } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import type { CiFailure } from "./scheduler-merge-ci-rerun-log.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

/** closeMergeRun refuses a longer receipt. */
const RECEIPT_MAX = 600;
/** More failing files than this is not "the one test somebody is fixing". */
const MAX_FILES = 5;
const MARK = "，已知偶发 ";
const SUFFIX = /，已知偶发 (\[[^\]]*\])$/;
/** CIF1's receipt ends like this when it lists no cases; only such a base may carry the suffix. */
const BASE_END = "超时用例 []";

function split(receipt: string): { base: string; files: string[] } | null {
  const m = SUFFIX.exec(receipt);
  if (!m || !receipt.slice(0, m.index).endsWith(BASE_END)) return null;
  try {
    const files = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES || !files.every(isKnownFlakyFile)) return null;
    return new Set(files).size === files.length ? { base: receipt.slice(0, m.index), files } : null;
  } catch {
    return null; // Not this module's suffix (a test name may end like one): the receipt is read as it always was.
  }
}
/**
 * CIF1's claim inside a known flaky claim; any other receipt unchanged. Only CIF1's own claim and pending readers look through
 * it: to CIF2's ledger layer the claim is not a rerun claim, so it reaches knownFlakyClaim and is judged there.
 */
export const knownFlakyBase = (receipt: string): string => split(receipt)?.base ?? receipt;

/** What CIF1's `decide` hands over when it bounces for a non-timeout failure: the run it read and every failure of its log. */
export interface KnownFlakyRed { repo: string; runId: string; failures: CiFailure[] }
interface Driver {
  run: MergeRun;
  prHead: string;
  checks: string[];
  gh: { prFiles(prRef: string): Promise<string[]>; rerunFailed(repo: string, runId: string): Promise<void> };
  step: (to: MergePhase, receipt?: string) => Promise<MergeRun>;
  /** CIF1's rerunReceipt, passed in so this file imports nothing from the module that imports it */
  receiptOf: (prHead: string, plan: { link: string; checks: string[]; cases: string[] }) => string;
}
const oneLine = (e: unknown) => (e as Error).message.trim().split("\n")[0]?.slice(0, 300) ?? "";

/**
 * The claimed run when the ledger accepted the rerun (or ended the run itself); null = not a known flaky rerun, the caller
 * bounces as it did before this layer. Null as well when the rerun call fails after the claim: the head is then spent like a
 * failed CIF1 rerun and the caller's bounce sends the card to fix.
 */
export async function knownFlakyRerun(d: Driver, red: KnownFlakyRed): Promise<MergeRun | null> {
  if (knownFlakyMode(d.run.project) === "off") return null;
  const files = [...new Set(red.failures.map((f) => f.file))];
  if (files.length > MAX_FILES || !files.every(isKnownFlakyFile)) return null;
  const receipt = `${d.receiptOf(d.prHead, { link: `https://github.com/${red.repo}/actions/runs/${red.runId}`, checks: d.checks, cases: [] })}${MARK}${JSON.stringify(files)}`;
  if (receipt.length > RECEIPT_MAX || !split(receipt)) return null;
  const rev = d.run.rev;
  let claimed: MergeRun;
  try {
    const touched = new Set(await d.gh.prFiles(d.run.prRef));
    if (files.some((f) => touched.has(f))) return null;
    claimed = await d.step("resolved", receipt);
  } catch (e) {
    console.error(`⚠️ [merge] ${d.run.taskId} 已知偶发重跑没有判成，按原路退回：${oneLine(e)}`);
    return null;
  }
  if (claimed.phase === "resolved") return claimed;
  if (claimed.rev === rev) return null; // observe, off, or a file the list does not excuse: nothing was claimed
  try {
    await d.gh.rerunFailed(red.repo, red.runId);
    return claimed;
  } catch (e) {
    console.error(`⚠️ [merge] ${d.run.taskId} 已知偶发重跑的 gh run rerun 失败，退回 fix：${oneLine(e)}`);
    return null;
  }
}

/** This merge run already merged main in for a red CI (i28-CIF2): the new head's red goes to fix, never a rerun. */
const mergedMain = (db: Database, row: MergeRun): boolean => !!db.query(`SELECT 1 FROM events WHERE target=? AND kind='scheduler'
  AND json_extract(data,'$.op')='merge_ci_behind' AND json_extract(data,'$.intentId')=? LIMIT 1`).get(row.taskId, row.intentId);

type WriteEvent = (db: Database, ctx: WriteCtx, e: { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> },
  primary: boolean) => unknown;
const label = (e: KnownFlakyEntry): string => `${e.file}（${e.featureId}/${e.node}）`;

/**
 * Ledger side, called by ciRerunClaim for a first claim on a head (`spent` = the head was re-run before: never a second one).
 * undefined = not a known flaky claim, CIF1 goes on as it was. null = not claimed: nothing changed but, in observe, the one
 * event per run and head. Otherwise the text and data CIF1's rerun event is written with.
 */
export function knownFlakyClaim(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, claim: { prHead: string; link: string }, spent: boolean,
  writeEvent: WriteEvent): { text: string; data: Record<string, unknown> } | null | undefined {
  const files = split(receipt)?.files;
  if (!files) return undefined;
  const mode = knownFlakyMode(row.project);
  if (spent || mode === "off" || mergedMain(db, row)) return null;
  const list = activeKnownFlaky(db, row.project);
  const hits = files.map((f) => list.get(f));
  if (!hits.every((e): e is KnownFlakyEntry => !!e)) return null;
  const knownFlaky = hits.map((e) => ({ file: e.file, featureId: e.featureId, node: e.node, entrySeq: e.seq }));
  const names = hits.map(label).join("、");
  if (mode === "on") {
    return { text: `合并队列：CI 只红在已知偶发测试（${names}），本卡没碰，自动重跑一次 ${claim.link}`,
      data: { cases: files, knownFlaky, reason: "失败的测试文件都在有效的已知偶发清单里，且都不在本 PR 改动里" } };
  }
  const dedupKey = `scheduler:${row.intentId}:merge:ci_known_flaky_observe:${claim.prHead.toLowerCase()}`;
  if (!getEventByDedup(db, dedupKey)) {
    writeEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey }, { project: row.project, target: row.taskId, kind: "scheduler",
      text: `合并队列：[观察] on 时会按已知偶发重跑：${names}；现在照旧退回 fix ${claim.link}`,
      data: { op: "merge_ci_known_flaky_observe", intentId: row.intentId, prHead: claim.prHead, run: claim.link, files, knownFlaky,
        reason: "开关是 observe：只记录，不重跑" } }, true);
  }
  return null;
}
