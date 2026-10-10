/** Offline GitHub REST jobs snapshot diagnostics. Case sums are never wall-clock estimates.
 * Input: {expected_shards, jobs: [...REST jobs], shards: [{job_id, shard}], artifacts?:
 * [{job_id, run_id, head_sha, shard, format: 'bun-log'|'junit', content: string}]}.
 * Select one run attempt and only the jobs being measured before supplying the snapshot.
 */
import { z } from 'zod';
import { record, positive } from './shared-ledger-contract-schema.js';

type Row = Record<string, unknown>;
type Metric = { ms: number | null; reason: string | null };
type Phase = 'unit_tests' | 'typecheck' | 'guard' | 'build';
type Counts = { pass: number; fail: number; skip: number; reportedCaseMs: number; untimedCases: number };
const metric = (ms: number): Metric => ({ ms, reason: null });
const unknown = (reason: string): Metric => ({ ms: null, reason });
const emptyCounts = (): Counts => ({ pass: 0, fail: 0, skip: 0, reportedCaseMs: 0, untimedCases: 0 });
const phases: Phase[] = ['unit_tests', 'typecheck', 'guard', 'build'];
const isoTime = z.iso.datetime({ offset: true });
const conclusions = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale'];

function reject(code: string): never { throw new Error(code); }
function rows(value: unknown, code: string): Row[] {
  if (!Array.isArray(value)) return reject(code);
  return value.map(record);
}
function jobId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function headOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
}
function stamp(value: unknown): number | null {
  const parsed = isoTime.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : null;
}
function interval(start: unknown, end: unknown): Metric {
  if (start == null || end == null) return unknown('missing_time');
  const a = stamp(start), b = stamp(end);
  if (a === null || b === null) return unknown('invalid_time');
  return b < a ? unknown('negative_interval') : metric(b - a);
}
function state(row: Row): string {
  if (row.status !== 'completed') return row.status === 'queued' || row.status === 'in_progress' ? row.status : 'unknown';
  return typeof row.conclusion === 'string' && conclusions.includes(row.conclusion) ? row.conclusion : 'unknown';
}
function execution(row: Row): Metric {
  return row.status === 'completed' ? interval(row.started_at, row.completed_at) : unknown('not_completed');
}
function phaseOf(name: unknown): Phase | null {
  if (name === 'Unit tests') return 'unit_tests';
  if (name === 'Typecheck (tsc --noEmit)' || name === 'Typecheck') return 'typecheck';
  if (name === 'Guard (ratchets)' || name === 'Guard') return 'guard';
  if (name === 'Build entrypoints' || name === 'Build') return 'build';
  return null;
}
function phaseReport(job: Row) {
  const steps = job.steps == null ? [] : rows(job.steps, 'invalid_steps');
  return Object.fromEntries(phases.map(phase => {
    const matches = steps.filter(s => phaseOf(s.name) === phase);
    if (matches.length !== 1) return [phase, { state: 'unknown', duration: unknown(matches.length ? 'duplicate_phase' : 'missing_phase') }];
    const step = matches[0];
    let duration = execution(step);
    const a = stamp(step.started_at), b = stamp(step.completed_at), ja = stamp(job.started_at), jb = stamp(job.completed_at);
    if (a !== null && b !== null && ((ja !== null && a < ja) || (jb !== null && b > jb))) duration = unknown('outside_job_interval');
    return [phase, { state: state(step), duration }];
  })) as Record<Phase, { state: string; duration: Metric }>;
}

function safeTestPath(value: string): string | null {
  const path = value.replace(/^\.\//, '');
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return null;
  return path.split('/').some(p => !p || p === '.' || p === '..') ? null : path;
}
function caseLine(line: string) {
  const match = /^\((pass|fail|skip|todo)\) (.*)$/.exec(line);
  if (!match) return null;
  const timing = / \[(\d+(?:\.\d+)?)(ms|s)\]$/.exec(match[2]);
  const ms = timing ? Number(timing[1]) * (timing[2] === 's' ? 1000 : 1) : null;
  return { unnamed: /(?:^| > )\(unnamed\)(?: \[|$)/.test(match[2]),
    kind: match[1] === 'todo' ? 'skip' : match[1] as 'pass' | 'fail' | 'skip', ms: ms !== null && Number.isFinite(ms) ? ms : null };
}
function addCase(counts: Counts, entry: NonNullable<ReturnType<typeof caseLine>>) {
  counts[entry.kind]++;
  if (entry.ms === null) counts.untimedCases++;
  else counts.reportedCaseMs += entry.ms;
}

/** Only Bun's text reporter is recognized. Arbitrary output is counted, never echoed.
 * Non-TTY output omits passing cases; summary counts remain separate from observed timings.
 * Hooks and file runtimes have no reliable per-file wall-clock boundaries in this format.
 */
function parseBunLog(content: string) {
  const files = new Map<string, Counts>(), unassigned = emptyCounts(), totals = emptyCounts();
  let current: string | null = null, banners = 0, endings = 0, ignoredLines = 0, hookErrors = 0, afterEnd = false;
  const summary: Partial<Record<'pass' | 'fail' | 'skip' | 'todo', number>> = {};
  let duplicateSummary = false;
  let summaryTests: number | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trimEnd();
    if (/^bun test v\d/.test(line)) { banners++; current = null; continue; }
    const end = /^Ran (\d+) tests? across \d+ files?\. \[\d+(?:\.\d+)?(?:ms|s)\]$/.exec(line);
    if (end) { endings++; summaryTests = Number(end[1]); afterEnd = true; current = null; continue; }
    const count = /^\s*(\d+) (pass|fail|skip|todo)\s*$/.exec(line);
    if (count) {
      const key = count[2] as 'pass' | 'fail' | 'skip' | 'todo';
      if (summary[key] !== undefined || afterEnd) duplicateSummary = true;
      summary[key] = Number(count[1]); continue;
    }
    if (/^error:.*(?:beforeAll|afterAll|beforeEach|afterEach|hook)/i.test(line)) { hookErrors++; current = null; }
    const entry = caseLine(line);
    if (entry) {
      if (afterEnd) endings++;
      addCase(totals, entry);
      if (entry.unnamed) { hookErrors++; current = null; }
      const target = current ? files.get(current)! : unassigned;
      addCase(target, entry); continue;
    }
    // Every apparent file header clears attribution, including absolute or unsafe paths.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line)) {
      current = safeTestPath(line.slice(0, -1));
      if (current && !files.has(current)) files.set(current, emptyCounts());
      continue;
    }
    if (line.trim()) ignoredLines++;
  }
  const summaryCounts = { pass: summary.pass ?? null, fail: summary.fail ?? null, skip: summary.skip ?? 0, todo: summary.todo ?? 0 };
  const skipped = summaryCounts.skip + summaryCounts.todo;
  const validSummary = summary.pass !== undefined && summary.fail !== undefined && !duplicateSummary &&
    summaryTests === summary.pass + summary.fail + skipped;
  const boundedCases = totals.pass <= (summary.pass ?? 0) && totals.fail === summary.fail && totals.skip <= skipped;
  const complete = banners === 1 && endings === 1 && validSummary && boundedCases;
  const allCases = complete && totals.pass === summary.pass && totals.skip === skipped;
  const status = complete ? allCases ? 'reported' : 'summary_only' : banners ? 'incomplete_log' : 'unsupported_log';
  return { status, summary: summaryCounts, totals, unassigned,
    perCaseAvailability: allCases ? 'reported' : 'per_case_unavailable',
    reportedCaseTime: allCases && !totals.untimedCases ? metric(totals.reportedCaseMs) : unknown('per_case_unavailable'),
    files: [...files].map(([path, counts]) => ({ path, ...counts })), ignoredLines, hookErrors };
}
function artifactReport(artifact: Row | undefined, unit: Metric) {
  const base = { wallClockUnattributed: unit, attribution: 'case_times_are_not_wall_clock' };
  if (!artifact) return { ...base, status: 'missing_log' };
  if (artifact.format === 'junit') return { ...base, status: 'unsupported_xml' };
  if (artifact.format !== 'bun-log') return { ...base, status: 'unsupported_format' };
  if (typeof artifact.content !== 'string') return { ...base, status: 'missing_log' };
  return { ...base, ...parseBunLog(artifact.content) };
}

function prepare(raw: unknown) {
  const input = record(raw), expected = positive(input.expected_shards);
  if (expected > 256) return reject('too_many_shards');
  const jobs = rows(input.jobs, 'invalid_jobs'), bindings = rows(input.shards, 'invalid_shards');
  const artifacts = input.artifacts == null ? [] : rows(input.artifacts, 'invalid_artifacts');
  const ids = new Set<number>(), shards = new Map<number, number>(), seenShards = new Set<number>();
  for (const job of jobs) {
    const id = jobId(job.id);
    if (id === null) return reject('invalid_job_id');
    if (ids.has(id)) return reject('duplicate_job');
    ids.add(id);
  }
  for (const binding of bindings) {
    const id = jobId(binding.job_id), shard = jobId(binding.shard);
    if (id === null || shard === null || shard > expected || !ids.has(id)) return reject('invalid_shard_binding');
    if (shards.has(id) || seenShards.has(shard)) return reject('duplicate_shard');
    shards.set(id, shard); seenShards.add(shard);
  }
  const runs = new Set(jobs.map(j => jobId(j.run_id)).filter(x => x !== null));
  const heads = new Set(jobs.map(j => headOf(j.head_sha)).filter(x => x !== null));
  const attempts = new Set(jobs.map(j => jobId(j.run_attempt)).filter(x => x !== null));
  if (runs.size > 1) return reject('mixed_run');
  if (heads.size > 1) return reject('mixed_head');
  if (attempts.size > 1) return reject('mixed_attempt');
  const attached = new Map<number, Row>();
  for (const artifact of artifacts) {
    const id = jobId(artifact.job_id), job = jobs.find(j => j.id === id);
    if (!job || !jobId(job.run_id) || !headOf(job.head_sha) || !shards.has(id!)) return reject('unbound_artifact');
    if (artifact.run_id !== job.run_id || artifact.head_sha !== job.head_sha || artifact.shard !== shards.get(id!)) return reject('artifact_binding_mismatch');
    if (attached.has(id!)) return reject('duplicate_artifact');
    attached.set(id!, artifact);
  }
  return { expected, jobs, shards, attached, seenShards };
}
function sumMetrics(values: Metric[]): Metric {
  return values.some(v => v.ms === null) ? unknown('incomplete_intervals') : metric(values.reduce((sum, v) => sum + v.ms!, 0));
}
function aggregate(jobs: ReturnType<typeof reportJob>[], expected: number) {
  const bound = jobs.every(j => j.runId !== null && j.head !== null && j.shard !== null);
  const complete = jobs.length === expected && bound && jobs.every(j => j.state === 'success' &&
    j.phases.unit_tests.state === 'success' && Object.values(j.phases).every(p => p.duration.reason === 'missing_phase' || p.state === 'success'));
  const measured = jobs.length === expected && bound && jobs.every(j => j.execution.ms !== null);
  const queueMeasured = measured && jobs.every(j => j.queue.ms !== null);
  const unavailable = unknown('incomplete_shard_set_or_timing');
  const slowest = measured ? jobs.reduce((a, b) => a.execution.ms! >= b.execution.ms! ? a : b) : null;
  return { outcome: complete ? 'success' : 'incomplete_or_unsuccessful',
    slowestShard: slowest ? { shard: slowest.shard, jobId: slowest.jobId, duration: slowest.execution } : null,
    totalRunnerTime: measured ? sumMetrics(jobs.map(j => j.execution)) : unavailable,
    totalQueueTime: queueMeasured ? sumMetrics(jobs.map(j => j.queue)) : unavailable,
    executionWallClock: measured ? metric(Math.max(...jobs.map(j => j.end!)) - Math.min(...jobs.map(j => j.start!))) : unavailable,
    wallClockWait: queueMeasured ? metric(Math.max(...jobs.map(j => j.end!)) - Math.min(...jobs.map(j => j.created!))) : unavailable };
}
function reportJob(job: Row, shard: number | undefined, artifact: Row | undefined) {
  const stages = phaseReport(job), queue = interval(job.created_at, job.started_at);
  return { jobId: jobId(job.id)!, runId: jobId(job.run_id), head: headOf(job.head_sha), runAttempt: jobId(job.run_attempt), shard: shard ?? null,
    state: state(job), queue, execution: execution(job), phases: stages,
    tests: artifactReport(artifact, stages.unit_tests.duration),
    created: stamp(job.created_at), start: stamp(job.started_at), end: stamp(job.completed_at) };
}

/** All errors are fixed codes; neither parser exceptions nor untrusted names/paths escape. */
export function ciTestDurations(raw: unknown) {
  const { jobs, expected, shards, attached, seenShards } = prepare(raw);
  const reports = jobs.map(j => reportJob(j, shards.get(j.id as number), attached.get(j.id as number)));
  return { schema: 1, diagnosticOnly: true, expectedShards: expected,
    missingShards: Array.from({ length: expected }, (_, i) => i + 1).filter(i => !seenShards.has(i)),
    ...aggregate(reports, expected), jobs: reports };
}
