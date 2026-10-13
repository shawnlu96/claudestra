/**
 * merge-arch-CARRYCNT1 · git side of the count carry: is the head the merge queue now sees (H1) the reviewed head (H0) plus exactly
 * one effect-site count commit? Read only, in the scheduler's repoDir: nothing is checked out and no PR code is imported or run.
 * a. H1 has the single parent H0; b. its subject is EFFAUTO1's REFRESH_SUBJECT (either missing: `none`, not a count commit at all);
 * c. the raw diff H0 → H1 is one `M 100644 → 100644` record of SKIP_EFFECTS_INVENTORY (its blobs B0 → B1 kept);
 * d. SKIPAUTO1 (checkSkipEffectsAutoScope over readScopeGit's raw-byte objects, PR headRefOid = H1) classes H0 → H1 as a pure count
 *    change matching this process's trusted scan, merge base H0;
 * e. every changed entry's new value is COUNT_VALUE (no backslash or anything else that changes how TS reads the literal).
 * Every command is bounded (scopeRunIn / scopeBytesIn deadlines); any failure, timeout or mismatch is a refusal, never a carry.
 * The record checks (rawInventoryChange, badCountValues) are shared with the post-merge verify. tests/review-count-carry*.test.ts.
 */
import { REFRESH_SUBJECT } from "./effect-count-refresh-git.js";
import { readScopeGit, scopeBytesIn, scopeRunIn, type ScopeRun, type ScopeRunBytes } from "./order-deliver-scope-git.js";
import { checkSkipEffectsAutoScope, SKIP_EFFECTS_INVENTORY } from "./skip-effects-auto-scope.js";

const SHA = /^[a-f0-9]{40}$/;
/** A count string as the inventory holds it (`sql=2 stmt=3`); all 91 entries on main match it. */
const COUNT_VALUE = /^[a-z]+=[1-9]\d*( [a-z]+=[1-9]\d*)*$/;
/** One raw record is under 200 bytes: anything longer is more than one record (or a read gone wrong) and refuses. */
const RAW_DIFF_MAX = 4096;
/** The SKIPAUTO1 read (gh pr view, numstat, a few hundred blobs) gets its own deadline, as order-deliver-scope-git.ts gives it. */
const SCAN_TIMEOUT_MS = 90_000;

interface CountEntry { file: string; gate: string; from: string; to: string }
export interface CountProofInput { repoDir: string; repository: string; prNumber: string; oldHead: string; newHead: string }
export type CountProof = Readonly<
  | { kind: "none"; reason: string }
  | { kind: "refused"; reason: string; blobFrom?: string; blobTo?: string; entries?: readonly CountEntry[] }
  | { kind: "ok"; blobFrom: string; blobTo: string; entries: readonly CountEntry[] }>;
/** The commands the proof runs; tests stand in a fake `gh` and keep git real. */
export interface CountProofIo { run: ScopeRun; scanRun: ScopeRun; objectsRun: ScopeRun; bytes: ScopeRunBytes }

const countProofIo = (dir: string): CountProofIo =>
  ({ run: scopeRunIn(dir), scanRun: scopeRunIn(dir), objectsRun: scopeRunIn(dir, SCAN_TIMEOUT_MS), bytes: scopeBytesIn(dir, SCAN_TIMEOUT_MS) });

/** Replacement refs could make git report another parent or tree than the objects hold; every proof read ignores them. */
const git = (run: ScopeRun, ...args: string[]) => run("git", ["--no-replace-objects", ...args]);

/** `git diff --raw -z --no-abbrev --no-renames` output → the inventory's two blobs, or why it is not exactly that one change. */
export function rawInventoryChange(out: string): { blobFrom: string; blobTo: string } | string {
  const parts = out.split("\0");
  if (parts.length !== 3 || parts[2] !== "") return "H0 → H1 不是恰好一条文件改动";
  const m = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z]\d*)$/.exec(parts[0]!);
  if (!m) return "H0 → H1 的改动记录读不懂";
  if (parts[1] !== SKIP_EFFECTS_INVENTORY) return `改的不是效果点清单：${parts[1]!.slice(0, 120)}`;
  if (m[5] !== "M" || m[1] !== "100644" || m[2] !== "100644") return `清单不是 100644 → 100644 的修改（${m[1]} → ${m[2]} ${m[5]}）`;
  return { blobFrom: m[3]!, blobTo: m[4]! };
}

/** The changed entries whose new value is not a plain count string. */
export const badCountValues = (entries: readonly { file: string; to: string }[]): string[] =>
  entries.filter((e) => !COUNT_VALUE.test(e.to)).map((e) => `${e.file}=${JSON.stringify(e.to).slice(0, 60)}`);

const short = (s: string) => s.slice(0, 12);
const oneLine = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").slice(0, 200);

/** a and b: a `none` means H1 is no count commit on H0, which the caller treats as if this proof did not exist. */
async function countCommit(run: ScopeRun, oldHead: string, newHead: string): Promise<string | null> {
  await git(run, "cat-file", "-e", `${newHead}^{commit}`).catch(() => git(run, "fetch", "--no-tags", "--quiet", "origin", newHead));
  if ((await git(run, "rev-list", "--parents", "-n", "1", newHead)).trim() !== `${newHead} ${oldHead}`) return `新 head 不是只接在 ${short(oldHead)} 上的单父提交`;
  if ((await git(run, "log", "-1", "--format=%s", newHead)).trim() !== REFRESH_SUBJECT) return "新 head 的提交主题不是效果点计数刷新";
  return null;
}

/** c–e, after a and b held. */
async function countOnly(io: CountProofIo, input: CountProofInput): Promise<CountProof> {
  const { oldHead, newHead } = input;
  const raw = await io.bytes("git", ["--no-replace-objects", "diff", "--raw", "-z", "--no-abbrev", "--no-renames", oldHead, newHead], RAW_DIFF_MAX);
  const change = rawInventoryChange(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (typeof change === "string") return { kind: "refused", reason: change };
  const diff = await readScopeGit(input.repository, input.prNumber, newHead, io.scanRun, io.objectsRun, io.bytes);
  const judged = await checkSkipEffectsAutoScope({ ...diff, base: oldHead }, [SKIP_EFFECTS_INVENTORY], newHead, { mode: "on", privateRepo: false });
  const entries = (judged?.entries ?? []).map(({ file, gate, from, to }) => ({ file, gate, from, to }));
  const more = { ...change, entries };
  if (!judged?.eligible) {
    const why = judged ? [...judged.reasons, ...(judged.error ? [judged.error.replace(/\s+/g, " ").slice(0, 200)] : [])] : ["清单不在 PR 改动里"];
    return { kind: "refused", reason: `SKIPAUTO1 不认是纯计数改动：${why.join("；").slice(0, 300)}`, ...more };
  }
  if (judged.mergeBase !== oldHead) return { kind: "refused", reason: "SKIPAUTO1 比对的 merge base 不是审过的 head", ...more };
  const bad = badCountValues(entries);
  if (bad.length) return { kind: "refused", reason: `计数值不是严格格式：${bad.slice(0, 5).join("、")}`, ...more };
  return { kind: "ok", ...more };
}

/** Never throws: a failed read before a and b are known is `none`, after them `refused`. */
export async function countCarryProof(input: CountProofInput, io: CountProofIo = countProofIo(input.repoDir)): Promise<CountProof> {
  const { oldHead, newHead } = input;
  if (!SHA.test(oldHead) || !SHA.test(newHead) || oldHead === newHead || !/^\d+$/.test(input.prNumber)) return { kind: "none", reason: "head 或 PR 号无效" };
  try {
    const not = await countCommit(io.run, oldHead, newHead);
    if (not) return { kind: "none", reason: not };
  } catch (e) { return { kind: "none", reason: `读不到提交：${oneLine(e)}` }; }
  try { return await countOnly(io, input); } catch (e) { return { kind: "refused", reason: `核对出错：${oneLine(e)}` }; }
}
