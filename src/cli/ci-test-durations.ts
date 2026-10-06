#!/usr/bin/env bun
/** Run with `bun --no-env-file src/cli/ci-test-durations.ts <manifest.json|->`.
 * This entry is deliberately independent of manager and all production-state readers.
 */
import { readFile } from 'node:fs/promises';
import { ciTestDurations } from '../lib/ci-test-durations.js';
import { record } from '../lib/shared-ledger-contract-schema.js';

const HELP = `Offline CI diagnostics (JSON output; no network, no CI gate).
Usage: bun --no-env-file src/cli/ci-test-durations.ts <manifest.json|->
Manifest: {expected_shards: 1, jobs: [GitHub REST job objects],
  shards: [{job_id: 123, shard: 1}], artifacts?: [
    {job_id: 123, run_id: 456, head_sha: "40 lowercase hex", shard: 1,
     format: "bun-log", path: "explicit log file"} ]}
Jobs retain id/run_id/head_sha/status/conclusion/created_at/started_at/
completed_at/steps; run_attempt is optional. Supply one run attempt only.
Each artifact supplies either content (inline text) or path (relative to cwd).
Only explicit input paths/stdin are read. JUnit XML is reported unsupported.
Case sums are reported case time, never file wall time or estimated speedup.
Null metrics carry fixed reasons. Missing/failed jobs cannot imply success.
Exit 0: diagnostic produced (even for failed CI); exit 2: invalid input or I/O.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  if (args.length !== 1) throw new Error('usage');
  let text: string;
  try { text = args[0] === '-' ? await Bun.stdin.text() : await readFile(args[0], 'utf8'); }
  catch { throw new Error('input_read_failed'); } // OS messages contain private absolute paths.
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error('malformed_json'); } // JSON diagnostics can include arbitrary input text.
  const input = record(raw);
  if (Array.isArray(input.artifacts)) {
    input.artifacts = await Promise.all(input.artifacts.map(async value => {
      const artifact = record(value);
      if (artifact.path === undefined) return artifact;
      if (typeof artifact.path !== 'string' || artifact.content !== undefined) throw new Error('invalid_artifact_path');
      try { return { ...artifact, content: await readFile(artifact.path, 'utf8') }; }
      catch { throw new Error('artifact_read_failed'); } // Do not echo paths or log bodies on read errors.
    }));
  }
  console.log(JSON.stringify(ciTestDurations(input), null, 2));
}

if (import.meta.main) {
  main().catch(error => {
    // Only our fixed codes are emitted; external/schema error messages never pass through.
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'invalid_input';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 2;
  });
}
