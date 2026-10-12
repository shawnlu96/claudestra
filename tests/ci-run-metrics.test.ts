import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCiMetrics, type MetricsReadPort, type CiSnapshot } from '../src/lib/ci-run-metrics.js';
import { ciMetricsReport } from '../src/lib/ci-run-metrics-report.js';
import { runCiMetricsCli } from '../scripts/ci-run-metrics.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 1) + s * 1000).toISOString();
const head = 'a'.repeat(40), repo = 'fixture/project';
function run(id = 42, attempt = 1) {
  return { id, run_attempt: attempt, head_sha: head, head_branch: 'train/car-1', event: 'pull_request',
    status: 'completed', conclusion: 'success', run_started_at: at(0), updated_at: at(60) };
}
function job(id = 9, attempt = 1) {
  return { id, run_id: 42, run_attempt: attempt, head_sha: head, name: 'tests (1)', status: 'completed', conclusion: 'success',
    started_at: at(5), completed_at: at(55), steps: [{ number: 1, name: 'Install dependencies', status: 'completed',
      conclusion: 'success', started_at: at(5), completed_at: at(15) }] };
}
function fake() {
  const calls: string[] = [], writes: string[] = [];
  const port: MetricsReadPort & { rerun(): void; cancel(): void } = {
    async json(path) {
      calls.push(path);
      if (path.includes('/jobs?')) return { total_count: 2, jobs: path.endsWith('page=1')
        ? [job(9, path.includes('/2/') ? 2 : 1)] : [job(9, path.includes('/2/') ? 2 : 1), job(10, path.includes('/2/') ? 2 : 1)] };
      if (path.includes('/attempts/')) return run(42, Number(path.split('/attempts/')[1]));
      return { total_count: 1, workflow_runs: [run(42, 2)] };
    },
    async failedLog() { return ''; },
    rerun() { writes.push('rerun'); }, cancel() { writes.push('cancel'); },
  };
  return { port, calls, writes };
}
const snapshot = (runs = [run()], attempts: CiSnapshot['attempts'] = []) => ({ repo, runs, attempts });
const bunFailure = (file: string, timeout = false) => `tests (1)\tUnit tests\t##[group]${file}:\n(fail) fixture case\n` +
  (timeout ? '    ^ this test timed out after 5000ms.\n' : '') + '##[endgroup]\n 1 fail\n';

describe('read-only CI baseline [acceptance 1-3]', () => {
  test('multiple attempts and overlapping job pages remain scoped and deduplicated', async () => {
    const { port, calls, writes } = fake();
    const data = await collectCiMetrics(port, { repo, pageSize: 1 });
    expect(data.runs).toHaveLength(1);
    expect(data.attempts.map(a => a.jobs.map(j => j.id))).toEqual([[9, 10], [9, 10]]);
    expect(calls.filter(p => p.includes('/jobs?'))).toHaveLength(4);
    const report = ciMetricsReport(data);
    expect(report.rows.filter(r => r.kind === 'step')).toHaveLength(4);
    expect(writes).toEqual([]);
  });
  test('gh run list camelCase baseline retains historical terminal estimates including cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-historical-'));
    try {
      const file = join(root, 'runs.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(file, JSON.stringify([{ databaseId: 42, attempt: 2, headBranch: 'train/car-1', event: 'pull_request',
        status: 'completed', conclusion: 'cancelled', createdAt: at(0), startedAt: at(10), updatedAt: at(60), workflowName: 'CI' }]));
      const { port, calls } = fake();
      const report = await runCiMetricsCli(['--repo', repo, '--input', file, '--out', join(root, 'report')], port);
      expect(report.baseline.dailyJst).toEqual([{ date: '2026-10-01', pr: 0, train: 1, main: 0, other: 0, total: 1 }]);
      expect(report.baseline.rerunRuns).toBe(1);
      expect(report.baseline.historical[0]).toMatchObject({ category: 'train', runs: 1, terminal: 1, cancelled: 1, rerunRuns: 1,
        createdToUpdated: { count: 1, p50Ms: 60000 }, startedToUpdated: { count: 1, p50Ms: 50000 } });
      expect(report.rows[0]).toMatchObject({ runId: 42, duration: { ms: null, reason: 'cancelled' }, jobs: 'unknown' });
      expect(calls).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('historical headless run seeds can be enriched without changing selected runs', async () => {
    const { port, calls } = fake(), read = port.json;
    port.json = p => p === `repos/${repo}/actions/runs/42` ? Promise.resolve(run()) : read(p);
    const data = await collectCiMetrics(port, { repo, runs: [{ ...run(), head_sha: undefined }] });
    expect(data.runs[0].head_sha).toBe(head);
    expect(data.attempts[0].jobs).toHaveLength(2);
    expect(calls.some(c => !c.includes('/42/'))).toBe(false);
  });
  test('run-only baseline never invents jobs, steps or attempt completion', () => {
    const report = ciMetricsReport(snapshot());
    expect(report.baseline).toMatchObject({ runs: 1, conclusions: { success: 1 }, duration: { count: 1, p50Ms: 60000 } });
    expect(report.rows.find(r => r.kind === 'run')).toMatchObject({ jobs: 'unknown', duration: { ms: null }, legacyRunEstimate: { ms: 60000 } });
    expect(report.rows.some(r => r.kind === 'job' || r.kind === 'step')).toBe(false);
  });
  test('cancelled, unfinished and missing timestamps have separate buckets', () => {
    const jobs = [job(), { ...job(10), conclusion: 'cancelled' }, { ...job(11), status: 'in_progress', conclusion: null },
      { ...job(12), completed_at: null }, { ...job(13), completed_at: at(1) }];
    const report = ciMetricsReport(snapshot([run()], [{ runId: 42, attempt: 1, run: run(), jobs, jobsComplete: true, log: null, errors: [] }]));
    const summary = report.groups.find(g => g.kind === 'job');
    expect(summary).toMatchObject({ success: { count: 1, p50Ms: 50000 }, cancelled: 1, incomplete: 1, unknownDuration: 2 });
    expect(report.rows.find(r => r.jobId === 12 && r.kind === 'job')?.duration.ms).toBeNull();
  });
  test('train wins over event, but only head-bound evidence verifies identity', () => {
    const input = snapshot();
    const rows = ciMetricsReport(input, { identities: [{ repo, runId: 42, head, train: 'car-1', verified: true }] }).rows;
    expect(rows[0]).toMatchObject({ group: 'train:car-1', identityVerified: true });
    expect(ciMetricsReport(input).rows[0]).toMatchObject({ group: 'train:car-1', identityVerified: false });
    expect(ciMetricsReport(input, { identities: [{ repo, runId: 42, head: 'b'.repeat(40), train: 'wrong', verified: true }] }).rows[0].identityVerified).toBe(false);
    expect(ciMetricsReport(snapshot([{ ...run(), head_branch: 'main' }])).rows[0].group).toBe('event:pull_request');
  });
  test('missing/error pages remain unknown; mismatched job identity is rejected', async () => {
    const { port } = fake();
    port.json = async p => p.includes('/jobs?') ? { total_count: 2, jobs: [] } : p.includes('/attempts/') ? run() : { total_count: 1, workflow_runs: [run()] };
    const data = await collectCiMetrics(port, { repo });
    expect(data.attempts[0].jobsComplete).toBe(false);
    expect(ciMetricsReport(data).rows.find(r => r.kind === 'attempt')?.jobs).toBe('unknown');
    port.json = async p => p.includes('/jobs?') ? { total_count: 1, jobs: [{ ...job(), run_id: 999 }] }
      : p.includes('/attempts/') ? run() : { total_count: 1, workflow_runs: [run()] };
    expect((await collectCiMetrics(port, { repo })).attempts[0].jobs).toEqual([]);
  });
  test('offline mismatched attempt cannot attribute logs or claim job coverage', () => {
    const r = { ...run(), conclusion: 'failure' };
    const report = ciMetricsReport(snapshot([r], [{ runId: 42, attempt: 1, run: { ...r, head_sha: 'b'.repeat(40) },
      jobs: [job()], jobsComplete: true, log: bunFailure('tests/known.test.ts'), errors: [] }]), { knownFlaky: ['tests/known.test.ts'] });
    expect(report.rows.find(r => r.kind === 'run')).toMatchObject({ jobs: 'unknown', failure: 'unknown' });
    expect(report.rows.find(r => r.kind === 'attempt')).toMatchObject({ jobs: 'unknown', failure: null, status: 'unknown' });
  });
  test('read exceptions and repeated full pages do not masquerade as complete', async () => {
    const { port } = fake();
    port.json = async p => { if (p.includes('/jobs?')) throw new Error('private credential');
      return p.includes('/attempts/') ? run() : { workflow_runs: [run()], total_count: 1 }; };
    const data = await collectCiMetrics(port, { repo });
    expect(data.attempts[0].errors).toContain('jobs_read_failed');
    expect(JSON.stringify(data)).not.toContain('private credential');
    port.json = async p => p.includes('/jobs?') ? { jobs: [job()], total_count: 500 }
      : p.includes('/attempts/') ? run() : { workflow_runs: [run()], total_count: 1 };
    expect((await collectCiMetrics(port, { repo, pageSize: 1 })).attempts[0].errors).toContain('jobs_pagination_incomplete');
  });
  test('failure parser candidates, code, timeout and unknown never authorize actions', () => {
    function category(log: string | null, knownFlaky: string[] = [], conclusion = 'failure') {
      const r = { ...run(), conclusion };
      return ciMetricsReport(snapshot([r], [{ runId: 42, attempt: 1, run: r, jobs: [], jobsComplete: true, log, errors: [] }]),
        { knownFlaky }).rows.find(x => x.kind === 'attempt')!.failure;
    }
    expect(category(bunFailure('tests/known.test.ts'), ['tests/known.test.ts'])).toBe('known-flaky-candidate');
    expect(category(bunFailure('tests/code.test.ts'), ['tests/known.test.ts'])).toBe('code');
    expect(category(bunFailure('tests/code.test.ts', true))).toBe('timeout');
    expect(category('##[error]Failed to download action: ECONNRESET')).toBe('environment-candidate');
    expect(category('some unrecognized red log')).toBe('unknown');
    expect(category(null, [], 'timed_out')).toBe('timeout');
  });
  test('all modes only report with zero writes, preserving external runtime state', async () => {
    const state = { train: 'running', serial: 'await_ci', manual: 'queued', pm: 'review' };
    const before = JSON.stringify(state);
    for (const mode of ['off', 'observe', 'on'] as const) {
      const { port, writes } = fake();
      const report = ciMetricsReport(await collectCiMetrics(port, { repo }), { mode });
      expect(report.mode).toBe(mode);
      expect(report.comparison.every(c => c.githubWrites === 0 && c.ledgerWrites === 0 && c.rerunAuthorized === false)).toBe(true);
      expect(writes).toEqual([]);
    }
    expect(JSON.stringify(state)).toBe(before);
  });
  test('real CLI adapter explicitly issues GET with a fake gh binary and no mutation argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-gh-read-'));
    try {
      const { writeFile, chmod } = await import('node:fs/promises');
      const exe = join(root, 'gh'), trace = join(root, 'trace');
      await writeFile(exe, '#!/bin/sh\nprintf "%s\n" "$*" >> "$METRICS_TRACE"\n' +
        `case "$*" in "api --method GET "*) printf '{"total_count":0,"workflow_runs":[]}\\n' ;; *) exit 71 ;; esac\n`);
      await chmod(exe, 0o700);
      const p = Bun.spawn([process.execPath, 'scripts/ci-run-metrics.ts', '--repo', repo, '--out', join(root, 'report')], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, METRICS_TRACE: trace }, stdout: 'pipe', stderr: 'pipe',
      });
      await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(await p.exited).toBe(0);
      expect(await readFile(trace, 'utf8')).toBe(`api --method GET repos/${repo}/actions/runs?per_page=100&page=1\n`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('offline CLI writes explicit output JSONL and refuses to overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-metric-'));
    try {
      const { port, writes } = fake(), out = join(root, 'report');
      await runCiMetricsCli(['--repo', repo, '--out', out], port);
      const lines = (await readFile(join(out, 'metrics.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      expect(lines.some(r => r.kind === 'step')).toBe(true);
      expect(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).mode).toBe('observe');
      await expect(runCiMetricsCli(['--repo', repo, '--out', out], port)).rejects.toThrow();
      expect(writes).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
