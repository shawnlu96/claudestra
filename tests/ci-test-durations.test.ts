import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ciTestDurations } from '../src/lib/ci-test-durations.js';

const head = 'a'.repeat(40);
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 5) + seconds * 1000).toISOString();
function job(id = 1, start = 10, end = 110) {
  return { id, run_id: 42, head_sha: head, run_attempt: 1, name: 'private job name',
    status: 'completed', conclusion: 'success', created_at: at(0), started_at: at(start), completed_at: at(end),
    steps: ['Typecheck (tsc --noEmit)', 'Unit tests', 'Guard (ratchets)', 'Build entrypoints'].map((name, i) => ({
      name, number: i + 1, status: 'completed', conclusion: 'success', started_at: at(start + i * 10), completed_at: at(start + (i + 1) * 10),
    })) };
}
function manifest(jobs = [job()], expected = jobs.length) {
  return { expected_shards: expected, jobs, shards: jobs.map((j, i) => ({ job_id: j.id, shard: i + 1 })) };
}
const log = `bun test v1.3.14 (fixture)

tests/alpha.test.ts:
(pass) alpha [2.00ms]
(skip) optional

tests/beta.test.ts:
(pass) beta [3.00ms]
 2 pass
 1 skip
 0 fail
Ran 3 tests across 2 files. [1.00s]
`;
function withLog(content = log, format = 'bun-log') {
  return { ...manifest(), artifacts: [{ job_id: 1, run_id: 42, head_sha: head, shard: 1, format, content }] };
}
const testsOf = (content = log) => ciTestDurations(withLog(content)).jobs[0].tests;

describe('offline CI job measurements', () => {
  test('serial timings bind run/head/job/shard and distinguish skips from jobs', () => {
    const input = withLog(), before = JSON.stringify(input), report = ciTestDurations(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(report.outcome).toBe('success');
    expect(report.totalRunnerTime.ms).toBe(100_000);
    expect(report.wallClockWait.ms).toBe(110_000);
    expect(report.jobs[0]).toMatchObject({ jobId: 1, runId: 42, head, shard: 1, queue: { ms: 10_000 } });
    for (const phase of Object.values(report.jobs[0].phases)) expect(phase.duration.ms).toBe(10_000);
    expect(report.jobs[0].tests).toMatchObject({ status: 'reported', totals: { pass: 2, skip: 1, reportedCaseMs: 5 },
      files: [{ path: 'tests/alpha.test.ts', skip: 1 }, { path: 'tests/beta.test.ts' }],
      wallClockUnattributed: { ms: 10_000 }, attribution: 'case_times_are_not_wall_clock' });
  });
  test('four imbalanced shards use measured extremes, runner sum and queue-inclusive wait', () => {
    const report = ciTestDurations(manifest([job(1, 10, 70), job(2, 20, 100), job(3, 40, 340), job(4, 15, 75)]));
    expect(report.slowestShard).toMatchObject({ shard: 3, duration: { ms: 300_000 } });
    expect(report.totalRunnerTime.ms).toBe(500_000);
    expect(report.executionWallClock.ms).toBe(330_000);
    expect(report.wallClockWait.ms).toBe(340_000);
    expect(report.totalQueueTime.ms).toBe(85_000);
  });
  test('queue can dominate tests', () => {
    const report = ciTestDurations(manifest([job(1, 500, 550)]));
    expect(report.jobs[0].queue.ms).toBe(500_000);
    expect(report.jobs[0].phases.unit_tests.duration.ms).toBe(10_000);
    expect(report.wallClockWait.ms).toBe(550_000);
  });
  test.each(['failure', 'cancelled', 'skipped', 'timed_out'])('job %s is not success; observed times stay diagnostic', conclusion => {
    const input = manifest([job(1), job(2), job(3), job(4)]);
    input.jobs[2].conclusion = conclusion;
    const report = ciTestDurations(input);
    expect(report.outcome).toBe('incomplete_or_unsuccessful');
    expect(report.jobs[2].state).toBe(conclusion);
    expect(report.totalRunnerTime.ms).toBe(400_000);
  });
  test('missing shard and empty jobs never imply zero or success', () => {
    for (const input of [manifest([job(1), job(2), job(3)], 4), manifest([], 4)]) {
      const report = ciTestDurations(input);
      expect(report.missingShards).toContain(4);
      expect(report.outcome).toBe('incomplete_or_unsuccessful');
      expect(report.totalRunnerTime.ms).toBeNull();
      expect(report.slowestShard).toBeNull();
      expect(report.wallClockWait.ms).toBeNull();
    }
  });
  test('missing identity and shard bindings remain unknown', () => {
    const input: any = manifest();
    delete input.jobs[0].run_id; delete input.jobs[0].head_sha; input.shards = [];
    const report = ciTestDurations(input);
    expect(report.jobs[0]).toMatchObject({ runId: null, head: null, shard: null });
    expect(report.totalRunnerTime.ms).toBeNull();
    expect(report.outcome).toBe('incomplete_or_unsuccessful');
  });
  test.each(['run_id', 'head_sha', 'run_attempt'])('rejects mixed %s', field => {
    const input: any = manifest([job(1), job(2)]);
    input.jobs[1][field] = field === 'head_sha' ? 'b'.repeat(40) : 2;
    expect(() => ciTestDurations(input)).toThrow(field === 'head_sha' ? 'mixed_head' : field === 'run_id' ? 'mixed_run' : 'mixed_attempt');
  });
  test('duplicates and invalid shard bindings are rejected', () => {
    expect(() => ciTestDurations(manifest([job(), job()]))).toThrow('duplicate_job');
    const input = manifest([job(1), job(2)]);
    input.shards[1].shard = 1;
    expect(() => ciTestDurations(input)).toThrow('duplicate_shard');
    input.shards[1].shard = 3;
    expect(() => ciTestDurations(input)).toThrow('invalid_shard_binding');
  });
  test.each(['created_at', 'started_at', 'completed_at'])('missing %s does not default to zero', field => {
    const input: any = manifest(); delete input.jobs[0][field];
    const report = ciTestDurations(input);
    expect(report.wallClockWait.ms).toBeNull();
    expect(field === 'completed_at' ? report.jobs[0].execution.ms : report.jobs[0].queue.ms).toBeNull();
  });
  test.each(['nonsense', '2026-02-30T00:00:00Z', '2026-10-05T01:00:00', '', 0])('invalid timestamp %s', value => {
    const input: any = manifest(); input.jobs[0].started_at = value;
    expect(ciTestDurations(input).jobs[0].execution).toEqual({ ms: null, reason: 'invalid_time' });
  });
  test('negative interval, incomplete step, and missing phase have fixed reasons', () => {
    const input = manifest(); input.jobs[0].completed_at = at(1);
    expect(ciTestDurations(input).jobs[0].execution.reason).toBe('negative_interval');
    input.jobs[0] = job(); input.jobs[0].steps[1].status = 'in_progress'; input.jobs[0].steps.pop();
    const report = ciTestDurations(input);
    expect(report.jobs[0].phases.unit_tests.duration.reason).toBe('not_completed');
    expect(report.outcome).toBe('incomplete_or_unsuccessful');
    expect(report.jobs[0].phases.build.duration.reason).toBe('missing_phase');
  });
  test('phase duplicates and out-of-job timestamps are not summed', () => {
    const input = manifest(); input.jobs[0].steps.push(input.jobs[0].steps[0]);
    input.jobs[0].steps[1].completed_at = at(999);
    const report = ciTestDurations(input);
    expect(report.jobs[0].phases.typecheck.duration.reason).toBe('duplicate_phase');
    expect(report.jobs[0].phases.unit_tests.duration.reason).toBe('outside_job_interval');
  });
  test('in-progress job does not invent an end from step durations', () => {
    const input = manifest(); input.jobs[0].status = 'in_progress';
    expect(ciTestDurations(input).jobs[0].execution.reason).toBe('not_completed');
    expect(ciTestDurations(input).totalRunnerTime.ms).toBeNull();
  });
});

describe('bounded attribution and safe output', () => {
  test('hook error time cannot become file wall time', () => {
    const content = log.replace('(skip) optional', 'error: beforeAll hook timed out after 5000ms\n(skip) optional');
    expect(testsOf(content)).toMatchObject({ hookErrors: 1, unassigned: { skip: 1 }, wallClockUnattributed: { ms: 10_000 } });
    expect(JSON.stringify(testsOf(content))).not.toContain('5000');
  });
  test('unknown/missing logs and XML explicitly refuse attribution', () => {
    expect(ciTestDurations(manifest()).jobs[0].tests.status).toBe('missing_log');
    expect(testsOf('arbitrary body')).toMatchObject({ status: 'unsupported_log' });
    for (const xml of ['<testsuites><', '<testsuites/>', '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secret">]><x>&a;</x>']) {
      expect(ciTestDurations(withLog(xml, 'junit')).jobs[0].tests.status).toBe('unsupported_xml');
    }
  });
  test('truncated or repeated reports remain incomplete', () => {
    for (const text of [log.split('Ran ')[0], log + log, log.replace('2 pass', '3 pass'), log + '(pass) late [1ms]\n', log.replace('[1.00s]', '[..s]')]) {
      expect(testsOf(text).status).toBe('incomplete_log');
    }
  });
  test('raw Github timestamps and ANSI decoration are supported', () => {
    const content = log.split('\n').map(line => `${at(0)} \x1b[32m${line}\x1b[0m`).join('\n');
    expect(testsOf(content).status).toBe('reported');
  });
  test('logs, env values, arbitrary job names and private paths are never echoed', () => {
    const content = log.replace('tests/alpha.test.ts:', '/Users/private/project/tests/alpha.test.ts:') + '\nTOKEN=do-not-output\n';
    const input = withLog(content); input.jobs[0].name = '/private/owner-name';
    const serialized = JSON.stringify(ciTestDurations(input));
    for (const privateText of ['Users', 'private', 'TOKEN', 'do-not-output', 'optional', 'fixture']) expect(serialized).not.toContain(privateText);
    expect(testsOf(content)).toMatchObject({ unassigned: { pass: 1, skip: 1 } });
  });
  test.each(['../tests/alpha.test.ts', 'tests/../../alpha.test.ts', 'C:/tests/alpha.test.ts', 'tests//alpha.test.ts'])('rejects unsafe path %s', path => {
    const result = testsOf(log.replace('tests/alpha.test.ts', path));
    expect(result).toMatchObject({ unassigned: { pass: 1 } });
    expect(JSON.stringify(result)).not.toContain(path);
  });
  test.each(['head_sha', 'run_id', 'job_id', 'shard'])('artifact %s must match', field => {
    const input: any = withLog(); input.artifacts[0][field] = field === 'head_sha' ? 'b'.repeat(40) : 9;
    expect(() => ciTestDurations(input)).toThrow(field === 'job_id' ? 'unbound_artifact' : 'artifact_binding_mismatch');
  });
  test('repository test paths need not live under tests/', () => {
    expect(testsOf(log.replace('tests/alpha.test.ts', './desktop/ui.spec.ts'))).toMatchObject({
      files: [{ path: 'desktop/ui.spec.ts' }, { path: 'tests/beta.test.ts' }],
    });
  });
  test('duplicate artifacts cannot inflate timing', () => {
    const input = withLog(); input.artifacts.push(input.artifacts[0]);
    expect(() => ciTestDurations(input)).toThrow('duplicate_artifact');
  });
});

const cli = resolve('src/cli/ci-test-durations.ts');
async function runCli(args: string[], stdin = '') {
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
describe('CLI is offline and reads only explicit inputs', () => {
  test('stdin and help need no local state', async () => {
    const result = await runCli(['-'], JSON.stringify(withLog()));
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).jobs[0].tests.status).toBe('reported');
    expect((await runCli(['--help'])).stdout).toContain('no network');
  });
  test('files remain unchanged and explicit log path is not emitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-duration-'));
    try {
      const path = join(dir, 'input.json'), logPath = join(dir, 'raw.log');
      const input = { ...manifest(), artifacts: [{ job_id: 1, run_id: 42, head_sha: head, shard: 1, format: 'bun-log', path: logPath }] };
      const text = JSON.stringify(input); await writeFile(path, text); await writeFile(logPath, log);
      const result = await runCli([path]);
      expect(result.code).toBe(0); expect(result.stdout).not.toContain(dir);
      expect(JSON.parse(result.stdout).jobs[0].tests.status).toBe('reported');
      expect(await readFile(path, 'utf8')).toBe(text); expect(await readFile(logPath, 'utf8')).toBe(log);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('malformed JSON and read errors do not reveal the offending text or path', async () => {
    const result = await runCli(['-'], '{"secret":"private value"');
    expect(result).toEqual({ code: 2, stdout: '', stderr: '{"error":"malformed_json"}\n' });
    expect((await runCli(['/missing/private/ci.json'])).stderr).toBe('{"error":"input_read_failed"}\n');
    const input = { ...manifest(), artifacts: [{ path: '/missing/private/log' }] };
    expect((await runCli(['-'], JSON.stringify(input))).stderr).toBe('{"error":"artifact_read_failed"}\n');
  });
  test('failed CI is a diagnostic result, not a new CLI gate', async () => {
    const input = manifest(); input.jobs[0].conclusion = 'failure';
    const result = await runCli(['-'], JSON.stringify(input));
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).outcome).toBe('incomplete_or_unsuccessful');
  });
});
