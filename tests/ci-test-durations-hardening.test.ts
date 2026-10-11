import { describe, expect, test } from 'bun:test';
import { ciTestDurations } from '../src/lib/ci-test-durations.js';

const head = 'a'.repeat(40);
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 5) + seconds * 1000).toISOString();
function job() {
  return { id: 1, run_id: 42, head_sha: head, run_attempt: 1, name: 'job',
    status: 'completed', conclusion: 'success', created_at: at(0), started_at: at(10), completed_at: at(110),
    steps: ['Typecheck (tsc --noEmit)', 'Unit tests', 'Guard (ratchets)', 'Build entrypoints'].map((name, i) => ({
      name, number: i + 1, status: 'completed', conclusion: 'success', started_at: at(10 + i * 10), completed_at: at(20 + i * 10),
    })) };
}
const testsOf = (content: string) => ciTestDurations({ expected_shards: 1, jobs: [job()], shards: [{ job_id: 1, shard: 1 }],
  artifacts: [{ job_id: 1, run_id: 42, head_sha: head, shard: 1, format: 'bun-log', content }] }).jobs[0].tests;

describe('CI log file attribution hardening', () => {
  test('assertion messages naming hooks stay in their file', () => {
    const content = `bun test v1.3.14 (0d9b296a)
tests/alpha.test.ts:
error: the beforeEach setup value was wrong
(fail) d > bad [0.20ms]
error: afterAll cleanup expected 1
(fail) d > worse [0.30ms]
(pass) d > after [1.00ms]
 1 pass
 2 fail
Ran 3 tests across 1 file. [6.04s]
`;
    expect(testsOf(content)).toMatchObject({ status: 'reported', hookErrors: 0,
      files: [{ path: 'tests/alpha.test.ts', pass: 1, fail: 2, reportedCaseMs: 1.5 }],
      unassigned: { pass: 0, fail: 0 } });
  });
  test.each([
    ['thrown', 'error: setup exploded\n(fail) (unnamed)'],
    ['timeout', '::error title=error: Test "(unnamed)" timed out after 5000ms::\n(fail) (unnamed) [5000.00ms]'],
  ])('Bun 1.3.14 hook failures (%s) stay unassigned', (_kind, hook) => {
    const content = `bun test v1.3.14 (0d9b296a)
::group::tests/alpha.test.ts:
(pass) d > ok [1.00ms]
${hook}
::endgroup::
 1 pass
 1 fail
Ran 2 tests across 1 file. [6.04s]
`;
    const tests = testsOf(content);
    expect(tests).toMatchObject({ hookErrors: 1, unassigned: { fail: 1 },
      files: [{ path: 'tests/alpha.test.ts', pass: 1, fail: 0, reportedCaseMs: 1 }] });
    expect('files' in tests && tests.files).toHaveLength(1);
  });
  test.each(['::group::', '##[group]'])('test stdout cannot spoof a file header after %s', prefix => {
    const ending = prefix === '::group::' ? '::endgroup::' : '##[endgroup]';
    const content = `bun test v1.3.14 (0d9b296a)
${prefix}tests/alpha.test.ts:
(pass) a1 [1.00ms]
tests/other.test.ts:
(pass) a2 [2.00ms]
${ending}
${prefix}tests/beta.test.ts:
tests/spoof.test.ts:
(pass) b1 [4.00ms]
${ending}
 3 pass
 0 fail
Ran 3 tests across 2 files. [6.04s]
`;
    const tests = testsOf(content);
    expect(tests).toMatchObject({ status: 'reported', ignoredLines: 2,
      files: [{ path: 'tests/alpha.test.ts', pass: 2, reportedCaseMs: 3 }, { path: 'tests/beta.test.ts', pass: 1, reportedCaseMs: 4 }],
      unassigned: { pass: 0 } });
    expect('files' in tests && tests.files).toHaveLength(2);
    expect(JSON.stringify(tests)).not.toMatch(/other|spoof/);
  });
  test('bare headers still attribute files when no prefixed header appears', () => {
    const content = `bun test v1.3.14 (0d9b296a)
tests/alpha.test.ts:
(pass) a1 [1.00ms]
tests/beta.test.ts:
(pass) b1 [2.00ms]
 2 pass
 0 fail
Ran 2 tests across 2 files. [6.04s]
`;
    expect(testsOf(content)).toMatchObject({ status: 'reported', ignoredLines: 0,
      files: [{ path: 'tests/alpha.test.ts', pass: 1, reportedCaseMs: 1 }, { path: 'tests/beta.test.ts', pass: 1, reportedCaseMs: 2 }] });
  });
});
