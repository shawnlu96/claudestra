/** Offline Actions reader: no production ledger, recovery policy or GitHub mutation port. */
export interface CiRow {
  id?: number; run_id?: number; run_attempt?: number; head_sha?: string; head_branch?: string; event?: string;
  name?: string; number?: number; status?: string; conclusion?: string | null;
  run_started_at?: string | null; started_at?: string | null; completed_at?: string | null; created_at?: string | null; updated_at?: string | null;
  steps?: CiRow[];
}
interface CiAttempt {
  runId: number; attempt: number; run: CiRow | null; jobs: CiRow[]; jobsComplete: boolean; log: string | null; errors: string[];
}
export interface CiSnapshot { repo: string; runs: CiRow[]; attempts: CiAttempt[]; runsComplete?: boolean; errors?: string[] }
export interface MetricsReadPort {
  json(path: string): Promise<unknown>;
  failedLog(repo: string, runId: number, attempt: number): Promise<string>;
}
interface CollectOptions { repo: string; pageSize?: number; since?: string; until?: string; runs?: CiRow[] }
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Drop API actor, commit messages and opaque URLs; logs are never persisted by the CLI. */
export function ciMetricRow(x: unknown): CiRow {
  if (!object(x)) throw new Error('invalid_row');
  const aliases: Record<string, string> = { databaseId: 'id', attempt: 'run_attempt', headBranch: 'head_branch', headSha: 'head_sha',
    startedAt: 'run_started_at', createdAt: 'created_at', updatedAt: 'updated_at', workflowName: 'name' };
  const source = { ...x };
  for (const [from, to] of Object.entries(aliases)) if (!(to in source) && from in source) source[to] = source[from];
  const row: CiRow = {};
  for (const key of ['id', 'run_id', 'run_attempt', 'number'] as const) if (positive(source[key])) row[key] = source[key];
  for (const key of ['head_sha', 'head_branch', 'event', 'name', 'status', 'conclusion', 'run_started_at',
    'started_at', 'completed_at', 'created_at', 'updated_at'] as const) {
    const value = source[key];
    if (typeof value === 'string' || value === null) (row as Record<string, unknown>)[key] = value;
  }
  if (Array.isArray(source.steps)) row.steps = source.steps.map(ciMetricRow);
  return row;
}

async function pages(port: MetricsReadPort, path: string, field: string, size: number) {
  const rows = new Map<number, CiRow>();
  let complete = false;
  for (let page = 1; page <= 10000; page++) {
    const raw = await port.json(`${path}${path.includes('?') ? '&' : '?'}per_page=${size}&page=${page}`);
    if (!object(raw) || !Array.isArray(raw[field])) throw new Error('invalid_page');
    const batch = (raw[field] as unknown[]).map(ciMetricRow);
    const before = rows.size;
    for (const row of batch) {
      if (!positive(row.id)) throw new Error('missing_row_id');
      rows.set(row.id, row);
    }
    const total = typeof raw.total_count === 'number' ? raw.total_count : null;
    if (total !== null ? rows.size >= total : batch.length < size) { complete = true; break; }
    if (!batch.length || rows.size === before) break;
  }
  return { rows: [...rows.values()], complete };
}

async function readAttempt(port: MetricsReadPort, repo: string, seed: CiRow, attempt: number, size: number): Promise<CiAttempt> {
  const out: CiAttempt = { runId: seed.id!, attempt, run: null, jobs: [], jobsComplete: false, log: null, errors: [] };
  const path = `repos/${repo}/actions/runs/${seed.id}/attempts/${attempt}`;
  try {
    const run = ciMetricRow(await port.json(path));
    if (run.id !== seed.id || run.run_attempt !== attempt || run.head_sha !== seed.head_sha) throw new Error('identity_mismatch');
    out.run = run;
  } catch { out.errors.push('attempt_read_failed'); } // Fixed error codes keep credential-bearing subprocess errors out of reports.
  try {
    const jobs = await pages(port, `${path}/jobs`, 'jobs', size);
    out.jobs = jobs.rows.filter(j => j.run_id === seed.id && j.run_attempt === attempt && j.head_sha === seed.head_sha);
    out.jobsComplete = jobs.complete && out.jobs.length === jobs.rows.length;
    if (!jobs.complete) out.errors.push('jobs_pagination_incomplete');
    if (out.jobs.length !== jobs.rows.length) out.errors.push('job_identity_mismatch');
  } catch { out.errors.push('jobs_read_failed'); } // Failed reads remain unknown instead of exposing raw gh errors or implying zero jobs.
  if (out.run?.status === 'completed' && ['failure', 'timed_out', 'action_required'].includes(out.run.conclusion ?? '')) {
    try { out.log = await port.failedLog(repo, seed.id!, attempt); }
    catch { out.errors.push('log_read_failed'); } // Expired logs are a measurable unknown, not a reason to mutate or retry CI.
  }
  return out;
}

export async function collectCiMetrics(port: MetricsReadPort, options: CollectOptions): Promise<CiSnapshot> {
  const { repo, since, until } = options, size = options.pageSize ?? 100;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid_repo');
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('invalid_page_size');
  for (const bound of [since, until]) if (bound && !/^\d{4}-\d\d-\d\d$/.test(bound)) throw new Error('invalid_date_bound');
  if (since && until && since > until) throw new Error('invalid_date_range');
  const created = since || until ? `?created=${encodeURIComponent(`${since ?? '*'}..${until ?? '*'}`)}` : '';
  const listed = options.runs ? { rows: options.runs.map(ciMetricRow), complete: true }
    : await pages(port, `repos/${repo}/actions/runs${created}`, 'workflow_runs', size);
  const runs = [...new Map(listed.rows.map(r => [r.id, r])).values()];
  const attempts: CiAttempt[] = [];
  for (const run of runs) {
    if (positive(run.id) && !run.head_sha) {
      const detail = ciMetricRow(await port.json(`repos/${repo}/actions/runs/${run.id}`));
      if (detail.id !== run.id) throw new Error('run_identity_mismatch');
      run.head_sha = detail.head_sha;
      run.run_attempt ??= detail.run_attempt;
    }
    if (!positive(run.id) || !positive(run.run_attempt) || !/^[a-fA-F0-9]{40}$/.test(run.head_sha ?? '')) throw new Error('invalid_run_identity');
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) attempts.push(await readAttempt(port, repo, run, attempt, size));
  }
  return { repo, runs, attempts, runsComplete: listed.complete, errors: listed.complete ? [] : ['runs_pagination_incomplete'] };
}
