/** Explicit offline output only; the injected port deliberately exposes no rerun/cancel/ledger methods. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ciMetricRow, collectCiMetrics, type CiSnapshot, type MetricsReadPort } from '../src/lib/ci-run-metrics.js';
import { ciMetricsReport } from '../src/lib/ci-run-metrics-report.js';

type Options = Parameters<typeof ciMetricsReport>[1];
async function gh(argv: string[]): Promise<string> {
  const p = Bun.spawn(['gh', ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (await p.exited !== 0) throw new Error('github_read_failed');
  return out;
}
const github: MetricsReadPort = {
  async json(path) {
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs(?:\?|\/|$)/.test(path)) throw new Error('invalid_read_path');
    return JSON.parse(await gh(['api', '--method', 'GET', path]));
  },
  failedLog(repo, runId, attempt) {
    return gh(['run', 'view', String(runId), '--repo', repo, '--attempt', String(attempt), '--log-failed']);
  },
};
function args(argv: string[]) {
  const out: Record<string, string> = {};
  const allowed = new Set(['repo', 'out', 'since', 'until', 'mode', 'input', 'runs', 'identities', 'known-flaky']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, ''), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--') || key in out) throw new Error('invalid_arguments');
    out[key] = value;
  }
  if (!out.out || !out.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(out.repo)) throw new Error('repo_and_output_required');
  if (out.mode && !['off', 'observe', 'on'].includes(out.mode)) throw new Error('invalid_mode');
  if (out.input && (out.runs || out.since || out.until)) throw new Error('input_conflicting_filters');
  return out;
}
async function jsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); }
  catch { return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } // JSONL is an explicit alternate input format.
}
function runRows(raw: unknown) {
  const rows = Array.isArray(raw) ? raw : (raw as { workflow_runs?: unknown[] })?.workflow_runs;
  if (!Array.isArray(rows)) throw new Error('invalid_runs_input');
  return rows.map(ciMetricRow);
}
function inputSnapshot(raw: unknown, repo: string): CiSnapshot {
  if (Array.isArray(raw) || (raw as { workflow_runs?: unknown[] })?.workflow_runs) return { repo, runs: runRows(raw), attempts: [] };
  const data = raw as CiSnapshot;
  if (data?.repo !== repo || !Array.isArray(data.runs) || !Array.isArray(data.attempts)) throw new Error('invalid_snapshot');
  return { ...data, runs: data.runs.map(ciMetricRow), attempts: data.attempts.map(a => ({ ...a,
    run: a.run ? ciMetricRow(a.run) : null, jobs: a.jobs.map(ciMetricRow) })) };
}
function markdown(report: ReturnType<typeof ciMetricsReport>): string {
  const lines = ['# Offline CI baseline', '', `Mode: ${report.mode}; all modes report only.`, '',
    `Runs: ${report.baseline.runs}; run listing complete: ${report.runsComplete ?? 'unknown'}.`,
    `Conclusions: ${JSON.stringify(report.baseline.conclusions)}.`,
    `JST daily counts: ${JSON.stringify(report.baseline.dailyJst)}.`,
    `Runs with multiple attempts: ${report.baseline.rerunRuns}/${report.baseline.runs}.`,
    `Historical category estimates (including cancelled): ${JSON.stringify(report.baseline.historical)}.`,
    `Legacy successful run estimate (started→updated): ${JSON.stringify(report.baseline.duration)}.`, '',
    'Exact duration uses started/completed only. Missing completion is unknown; estimates never supply job/step time.',
    'Candidate failure labels do not authorize reruns. Unknown and cancelled/incomplete samples are excluded from success percentiles.', '',
    '| Kind | Group | Verified | Name | Success samples | p50 ms | p95 ms | Cancelled | Incomplete | Unknown time |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const cell = (s: string) => s.replace(/[|\r\n]/g, ' ');
  for (const g of report.groups) lines.push(`| ${g.kind} | ${cell(g.group)} | ${g.identityVerified} | ${cell(g.name)} | ` +
    `${g.success.count} | ${g.success.p50Ms ?? 'unknown'} | ${g.success.p95Ms ?? 'unknown'} | ${g.cancelled} | ${g.incomplete} | ${g.unknownDuration} |`);
  lines.push('', 'Failure counts and mode comparisons are in report.json; per-subject evidence is in metrics.jsonl.');
  return lines.join('\n') + '\n';
}

export async function runCiMetricsCli(argv: string[], port: MetricsReadPort = github) {
  const a = args(argv);
  const options: Options = { mode: (a.mode ?? 'observe') as 'off' | 'observe' | 'on' };
  if (a.identities) options.identities = await jsonFile(a.identities) as NonNullable<Options>['identities'];
  if (a['known-flaky']) options.knownFlaky = await jsonFile(a['known-flaky']) as string[];
  if (options.identities && !Array.isArray(options.identities)) throw new Error('invalid_identities');
  if (options.knownFlaky && (!Array.isArray(options.knownFlaky) || !options.knownFlaky.every(f => typeof f === 'string'))) throw new Error('invalid_known_flaky');
  const out = resolve(a.out);
  await mkdir(out); // A fresh directory prevents overwriting a previous baseline or any production state file.
  const data = a.input ? inputSnapshot(await jsonFile(a.input), a.repo)
    : await collectCiMetrics(port, { repo: a.repo, since: a.since, until: a.until, runs: a.runs ? runRows(await jsonFile(a.runs)) : undefined });
  const report = ciMetricsReport(data, options);
  await writeFile(join(out, 'metrics.jsonl'), report.rows.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(out, 'report.md'), markdown(report), { flag: 'wx' });
  // Keep only normalized rows, not raw actors, API metadata or potentially credential-bearing failed logs.
  await writeFile(join(out, 'snapshot.json'), JSON.stringify({ ...data, attempts: data.attempts.map(a => ({ ...a, log: null })) }), { flag: 'wx' });
  return report;
}
if (import.meta.main) {
  runCiMetricsCli(process.argv.slice(2)).then(report => console.log(`Reported ${report.baseline.runs} runs; no GitHub/ledger writes.`))
    .catch(() => { console.error('CI metrics collection failed; check arguments, fresh output directory and GitHub read access.'); process.exitCode = 1; });
}
