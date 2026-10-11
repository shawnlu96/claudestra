/**
 * What a merge train car's CI was doing when it ran past the car timeout (dispatch-recovery-TRAINHANG1): for each job still
 * running at the timeout, its shard (job name `test shard <n> of 4`, .github/workflows/ci.yml) and the last test file the job log
 * opened (`bun test` prints `::group::<path>:` per file in Actions; the log shows it as `##[group]`). The last file is observed
 * evidence, never the culprit by itself: the train still pins a card only by bisecting. Anything not read says 「未取到」 with
 * why, and a failed read never stops the bounce. tests/train-ci-timeout-diag.test.ts.
 */

/** A job that had not finished when the car timed out; `started` = in_progress (a queued job never ran any test). */
export interface HungJob { run: number; runUrl: string; job: number; name: string; started: boolean }
export interface JobLog { text: string; truncated: boolean }
export type JobLogReader = (job: number) => Promise<JobLog>;

const MISSING = "未取到";
/** Room left for the diagnosis in the single-line bounce receipt (scheduler-merge-conflict.ts RECEIPT_MAX 600) next to the link. */
export const DIAG_MAX = 300;
const TEST_FILE = /^[\w@+.-]+(?:\/[\w@+.-]+)*\.(?:test|spec)\.[cm]?[jt]sx?$/;

export const shardOf = (jobName: string): string | null => /\btest shard (\d+) of \d+\b/.exec(jobName)?.[1] ?? null;

/** The last `::group::<test file>` the log opened; null when it opened none (or the log is in another format). */
export function lastTestFile(log: string): string | null {
  let last: string | null = null;
  for (const line of log.split(/\r?\n/)) {
    const m = /(?:::group::|##\[group\])(.*)$/.exec(line);
    const path = m?.[1]!.trim().replace(/:$/, "");
    if (path && TEST_FILE.test(path)) last = path;
  }
  return last;
}

const flat = (t: string, max: number) => [...t.replace(/[\s\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim()].slice(0, max).join("");
export const errText = (e: unknown, max = 80): string => flat(e instanceof Error ? e.message : String(e), max) || "（无错误信息）";

async function fileOf(h: HungJob, read: JobLogReader): Promise<string> {
  let log: JobLog;
  try { log = await read(h.job); }
  catch (e) { return `${MISSING}（日志取不到：${errText(e, 60)}）`; }
  if (log.truncated) return `${MISSING}（日志超过读取上限被截断）`;
  return lastTestFile(log.text) ?? `${MISSING}（日志里没有测试文件分组）`;
}

/**
 * One line per job still running at the timeout (the queued ones only when none had started), shard, last file and run.
 * `notes` are earlier read failures (job list of a run); the result is cut to DIAG_MAX characters.
 */
export async function diagnose(hung: readonly HungJob[], read: JobLogReader, notes: readonly string[] = []): Promise<string> {
  const started = hung.filter((h) => h.started), pick = (started.length ? started : hung).slice(0, 3);
  const parts: string[] = [];
  for (const h of pick) {
    const shard = shardOf(h.name) ?? `${MISSING}（job「${flat(h.name, 40)}」不是测试分片）`;
    const file = h.started ? await fileOf(h, read) : `${MISSING}（job 还在排队，没开跑）`;
    parts.push(`分片号：${shard}；最后在跑的测试文件：${file}；run：${h.runUrl}`);
  }
  if (!parts.length) parts.push(`分片号：${MISSING}；最后在跑的测试文件：${MISSING}（${notes.length ? "job 列表没取到" : "超时时没有在跑的 job"}）`);
  return flat([...parts, ...notes].join(" | "), DIAG_MAX);
}

/**
 * The bounce link of a timed-out single card, `<run> 列车 <train> 超时诊断：<diag>`, fitted to the receipt: the run is said once
 * (its `；run：<run>` leaves the diagnosis), whole job parts drop from the end, and last the first part is cut, until `keeps`
 * (the receipt still holds the link) passes. bounceReceipt blanks a link that does not fit, losing shard, file and run at once.
 */
export function fitTimeoutLink(run: string, train: string, diag: string, keeps: (link: string) => boolean): string {
  const lead = `${run} 列车 ${train} 超时诊断：`.trim();
  const parts = diag.split(" | ").map((p) => (run ? p.replace(`；run：${run}`, "") : p));
  for (let n = parts.length; n > 0; n--) {
    const link = `${lead}${parts.slice(0, n).join(" | ")}`;
    if (keeps(link)) return link;
  }
  const first = [...parts[0]!];
  let lo = 0, hi = first.length; // the longest prefix of the first part that still fits
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keeps(lead + first.slice(0, mid).join(""))) lo = mid; else hi = mid - 1;
  }
  return lo ? lead + first.slice(0, lo).join("") : run;
}
