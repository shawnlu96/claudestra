import { parseFailedLog } from './scheduler-merge-ci-rerun-log.js';
import type { CiRow, CiSnapshot } from './ci-run-metrics.js';

type Mode = 'off' | 'observe' | 'on';
type Failure = 'code' | 'known-flaky-candidate' | 'environment-candidate' | 'timeout' | 'unknown' | null;
interface Metric { ms: number | null; reason: string | null }
interface Identity { repo: string; runId: number; head: string; train: string; verified: boolean }
interface ReportOptions { mode?: Mode; identities?: Identity[]; knownFlaky?: string[] }
interface MetricRow {
  kind: 'run' | 'attempt' | 'job' | 'step'; repo: string; runId: number; attempt: number | null;
  head: string | null; group: string; identityVerified: boolean; jobId?: number; stepNumber?: number; name: string;
  status: string; conclusion: string; duration: Metric; legacyRunEstimate?: Metric; jobs?: number | 'unknown';
  failure: Failure; errors: string[];
}
const unknown = (reason: string): Metric => ({ ms: null, reason });
function interval(start: string | null | undefined, end: string | null | undefined): Metric {
  if (!start || !end) return unknown('missing_time');
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
  const a = Date.parse(start), b = Date.parse(end);
  if (!iso.test(start) || !iso.test(end) || !Number.isFinite(a) || !Number.isFinite(b)) return unknown('invalid_time');
  return b < a ? unknown('negative_interval') : { ms: b - a, reason: null };
}
function duration(row: CiRow): Metric {
  if (row.status !== 'completed') return unknown('incomplete');
  if (row.conclusion === 'cancelled' || row.conclusion === 'skipped') return unknown(row.conclusion);
  return interval(row.started_at ?? row.run_started_at, row.completed_at);
}
function failure(row: CiRow, log: string | null, known: readonly string[]): Failure {
  if (row.status !== 'completed' || !['failure', 'timed_out', 'action_required'].includes(row.conclusion ?? '')) return null;
  if (row.conclusion === 'timed_out') return 'timeout';
  if (!log) return 'unknown';
  const parsed = parseFailedLog(log);
  if (parsed?.length) {
    if (parsed.every(f => f.timedOut)) return 'timeout';
    return parsed.every(f => known.includes(f.file)) ? 'known-flaky-candidate' : 'code';
  }
  if (/error TS\d+:|##\[error\].*(?:Typecheck|Guard).*(?:failed|violation)/i.test(log)) return 'code';
  if (/##\[error\].*(?:Failed to download action|ECONNRESET|ENOSPC|The runner has lost communication|Internal server error)/i.test(log)) {
    return 'environment-candidate';
  }
  return 'unknown';
}
function base(repo: string, run: CiRow, options: ReportOptions) {
  const identities = (options.identities ?? []).filter(i => i.repo === repo && i.runId === run.id && i.head === run.head_sha);
  const identity = identities.length === 1 ? identities[0] : undefined;
  const train = identity?.train || (/^train\/(.+)$/.exec(run.head_branch ?? '')?.[1]);
  return { repo, runId: run.id!, head: run.head_sha ?? null, group: train ? `train:${train}` : `event:${run.event ?? 'unknown'}`,
    identityVerified: identity?.verified === true };
}
function attemptBound(run: CiRow, a: CiSnapshot['attempts'][number] | undefined): boolean {
  return !!a?.run && a.runId === run.id && a.run.id === run.id && a.run.run_attempt === a.attempt &&
    !!run.head_sha && a.run.head_sha === run.head_sha;
}
function measured(row: CiRow) {
  return { name: row.name ?? 'unknown', status: row.status ?? 'unknown', conclusion: row.conclusion ?? 'unknown', duration: duration(row) };
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
  return { count: sorted.length, totalMs: sorted.reduce((a, b) => a + b, 0), p50Ms: p(.5), p90Ms: p(.9), p95Ms: p(.95), maxMs: p(1) };
}
function summarize(rows: MetricRow[]) {
  const success = rows.filter(r => r.status === 'completed' && r.conclusion === 'success' && r.duration.ms !== null);
  const count = (f: (r: MetricRow) => boolean) => rows.filter(f).length;
  return { samples: rows.length, success: stats(success.map(r => r.duration.ms!)),
    cancelled: count(r => r.conclusion === 'cancelled'), incomplete: count(r => r.status !== 'completed'),
    skipped: count(r => r.conclusion === 'skipped'), unknownDuration: count(r => r.duration.ms === null &&
      r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion)),
    failures: Object.fromEntries(['code', 'known-flaky-candidate', 'environment-candidate', 'timeout', 'unknown']
      .map(f => [f, count(r => r.failure === f)])) };
}

function category(r: CiRow) {
  return r.head_branch?.startsWith('train/') ? 'train'
    : r.head_branch === 'main' ? 'main' : r.event === 'pull_request' ? 'pr' : 'other';
}
function historicalBaseline(runs: CiRow[]) {
  return [...new Set(runs.map(category))].sort().map(c => {
    const selected = runs.filter(r => category(r) === c), terminal = selected.filter(r => r.status === 'completed');
    const estimates = (field: 'created_at' | 'run_started_at') => terminal.flatMap(r => {
      const value = interval(r[field], r.updated_at).ms;
      return value === null ? [] : [value];
    });
    return { category: c, runs: selected.length, terminal: terminal.length, failure: terminal.filter(r => r.conclusion === 'failure').length,
      cancelled: terminal.filter(r => r.conclusion === 'cancelled').length, rerunRuns: selected.filter(r => (r.run_attempt ?? 0) > 1).length,
      createdToUpdated: stats(estimates('created_at')), startedToUpdated: stats(estimates('run_started_at')),
      definition: 'historical_update_proxy_including_cancelled_not_execution' };
  });
}

function dailyJst(runs: CiRow[]) {
  const days = new Map<string, { date: string; pr: number; train: number; main: number; other: number; total: number }>();
  for (const r of runs) {
    const time = r.created_at ? Date.parse(r.created_at) : NaN;
    const date = Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 10) : 'unknown';
    const day = days.get(date) ?? { date, pr: 0, train: 0, main: 0, other: 0, total: 0 };
    day[category(r)]++;
    day.total++;
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function ciMetricsReport(snapshot: CiSnapshot, options: ReportOptions = {}) {
  const rows: MetricRow[] = [], known = options.knownFlaky ?? [];
  const runs = [...new Map(snapshot.runs.map(r => [r.id, r])).values()];
  for (const run of runs) {
    const b = base(snapshot.repo, run, options);
    const attempt = snapshot.attempts.find(a => a.runId === run.id && a.attempt === run.run_attempt);
    const legacyRunEstimate = run.status === 'completed' && !['cancelled', 'skipped'].includes(run.conclusion ?? '')
      ? interval(run.run_started_at, run.updated_at) : unknown(run.conclusion === 'cancelled' ? 'cancelled' : 'incomplete');
    rows.push({ ...b, ...measured(run), kind: 'run', attempt: run.run_attempt ?? null, legacyRunEstimate,
      jobs: attempt?.jobsComplete && attemptBound(run, attempt) ? attempt.jobs.length : 'unknown',
      failure: failure(run, attemptBound(run, attempt) ? attempt?.log ?? null : null, known), errors: [] });
    const seen = new Set<number>();
    for (const a of snapshot.attempts.filter(a => a.runId === run.id)) {
      if (seen.has(a.attempt)) continue;
      seen.add(a.attempt);
      const bound = attemptBound(run, a), subject = bound ? a.run! : { status: 'unknown', conclusion: null };
      rows.push({ ...b, ...measured(subject), kind: 'attempt', attempt: a.attempt, jobs: a.jobsComplete && bound ? a.jobs.length : 'unknown',
        failure: failure(subject, bound ? a.log : null, known), errors: bound ? a.errors : [...a.errors, 'attempt_identity_unknown'] });
      const jobs = [...new Map(a.jobs.map(j => [j.id, j])).values()];
      for (const j of jobs) {
        if (j.run_id !== run.id || j.run_attempt !== a.attempt || j.head_sha !== run.head_sha) continue;
        rows.push({ ...b, ...measured(j), kind: 'job', attempt: a.attempt, jobId: j.id,
          failure: failure(j, null, known), errors: [] });
        const steps = [...new Map((j.steps ?? []).map(s => [s.number, s])).values()];
        for (const s of steps) rows.push({ ...b, ...measured(s), kind: 'step', attempt: a.attempt, jobId: j.id, stepNumber: s.number,
          failure: failure(s, null, known), errors: [] });
      }
    }
  }
  const buckets = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.kind, row.group, row.identityVerified, ['job', 'step'].includes(row.kind) ? row.name : 'all']);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const groups = [...buckets.values()].map(rs => ({ kind: rs[0].kind, group: rs[0].group, identityVerified: rs[0].identityVerified,
    name: ['job', 'step'].includes(rs[0].kind) ? rs[0].name : 'all', ...summarize(rs) }));
  return { schema: 1, mode: options.mode ?? 'observe', rows, groups, errors: snapshot.errors ?? [], runsComplete: snapshot.runsComplete ?? null,
    baseline: { runs: runs.length, rerunRuns: runs.filter(r => (r.run_attempt ?? 0) > 1).length,
      dailyJst: dailyJst(runs), historical: historicalBaseline(runs), conclusions: Object.fromEntries([...new Set(runs.map(r => r.conclusion ?? 'unknown'))]
      .map(c => [c, runs.filter(r => (r.conclusion ?? 'unknown') === c).length])),
      duration: stats(rows.filter(r => r.kind === 'run' && r.conclusion === 'success' && r.legacyRunEstimate?.ms !== null)
        .flatMap(r => r.legacyRunEstimate?.ms == null ? [] : [r.legacyRunEstimate.ms])) },
    comparison: (['off', 'observe', 'on'] as const).map(mode => ({ mode, effect: 'report_only', githubWrites: 0, ledgerWrites: 0,
      rerunAuthorized: false, candidateAttempts: rows.filter(r => r.kind === 'attempt' && r.failure?.endsWith('-candidate')).length })) };
}
