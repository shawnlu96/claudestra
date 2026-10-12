/**
 * What a red CI log is (merge-arch-CLASS1), pure: no GitHub, no ledger. The serial gate (scheduler-merge-ci-rerun.ts, i28-CIF1 /
 * CIF8) and the merge train (scheduler-train-ci-rerun.ts) ask the same questions of the same parse (scheduler-merge-ci-rerun-log.ts):
 * - timeout: every failure is a bun test timeout in a test file outside the changed files (CIF1's rule, unchanged: a hung job has
 *   no such log and is never read as one);
 * - known_flaky: some failure is not a timeout and no failing file is in the changed files; whether the files are on the valid
 *   known flaky list is the ledger's answer, not this file's;
 * - env: every failed step is an environment fault with a definite signature: a network error inside an install / download
 *   step, or the runner itself shutting down in a step that reports no test failure;
 * - code / unknown: everything else. An environment fault next to any other failed step is code (mixed), never env.
 * Every doubt is code or unknown, which never earns a re-run. tests/ci-failure-class.test.ts.
 */
import { parseFailedLog, type CiFailure } from "./scheduler-merge-ci-rerun-log.js";

/** The first failure that is not a timeout: CIF1 does not re-run for it (CIF8 may). */
export const firstAsserted = (failures: readonly CiFailure[]): CiFailure | undefined => failures.find((f) => !f.timedOut);
/** The first failure whose test file is among the changed files: such a red is the change's own, never a re-run. */
export const firstTouched = (failures: readonly CiFailure[], touched: ReadonlySet<string>): CiFailure | undefined =>
  failures.find((f) => touched.has(f.file));

export type FailureClass =
  | { kind: "timeout"; files: string[]; cases: string[] }
  | { kind: "known_flaky"; files: string[] }
  | { kind: "env"; signature: string; step: string }
  | { kind: "code"; why: string }
  | { kind: "unknown"; why: string };

/** gh prefixes each line with `job<TAB>step<TAB>`, then the runner's ISO timestamp (as scheduler-merge-ci-rerun-log.ts reads it). */
const PREFIX = /^([^\t]*)\t([^\t]*)\t/;
const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** ci.yml's gate job fails with this one verdict whenever a shard did; the shard's own step carries the real failure. */
const GATE = { job: "typecheck + test + guard", step: "All shards succeeded" };
const GATE_ERROR = /^##\[error\](?:分片没有全部成功：\w+|Process completed with exit code \d+\.?)\s*$/;

/** Steps that only install or download: named `run` steps of ci.yml and the `uses:` actions that fetch tools, caches or artifacts. */
const FETCH_STEP = new RegExp("^(?:Set up job|Install (?:web )?dependencies|Install tmux|" +
  "Run (?:actions/(?:checkout|setup-node|cache|cache/restore|download-artifact|upload-artifact)|oven-sh/setup-bun|dtolnay/rust-toolchain|Swatinem/rust-cache)@\\S+)$");
/** Network faults as bun / npm / curl / git / apt print them; nothing a test or a build of the change's own code prints by itself in a fetch step. */
const NETWORK = new RegExp("\\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ConnectionRefused|ConnectionReset|ConnectionClosed|FailedToOpenSocket)\\b" +
  "|socket hang up|Could not resolve host|\\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)\\b|Temporary failure (?:in name resolution|resolving)");
/** The runner ending the job itself, whatever step it was in. */
const RUNNER = /^##\[error\]The (?:runner has received a shutdown signal|(?:self-)?hosted runner (?:lost communication with the server|encountered an error))/;
const TEST_FAIL = /^\(fail\) /;

interface Step { job: string; step: string; lines: string[] }
function failedSteps(log: string): Step[] {
  const steps = new Map<string, Step>();
  let key = "";
  for (const raw of log.split(/\r?\n/)) {
    const p = PREFIX.exec(raw);
    if (p) key = `${p[1]}\t${p[2]}`;
    const step = steps.get(key) ?? steps.set(key, { job: p?.[1] ?? "", step: p?.[2] ?? "", lines: [] }).get(key)!;
    step.lines.push((p ? raw.slice(p[0].length) : raw).replace(STAMP, ""));
  }
  return [...steps.values()].filter((s) => s.lines.some((l) => l.trim()));
}
const isGate = (s: Step): boolean => s.job === GATE.job && s.step === GATE.step && s.lines.filter((l) => l.startsWith("##[error]")).every((l) => GATE_ERROR.test(l));

/** The definite environment signature of one failed step, or null. */
function envSignature(s: Step): string | null {
  const runner = s.lines.find((l) => RUNNER.test(l));
  if (runner) return s.lines.some((l) => TEST_FAIL.test(l)) ? null : `runner 中断：${runner.replace("##[error]", "").trim().slice(0, 80)}`;
  if (!FETCH_STEP.test(s.step)) return null;
  const net = s.lines.map((l) => NETWORK.exec(l)?.[0]).find(Boolean);
  return net ? `安装/下载失败：${net}` : null;
}

/** env only when every failed step (the gate's verdict aside) has a signature; "mixed" when only some do. */
function envFault(log: string): { signature: string; step: string } | "mixed" | null {
  const steps = failedSteps(log).filter((s) => !isGate(s));
  const marks = steps.map(envSignature);
  if (!steps.length || marks.every((m) => !m)) return null;
  if (marks.some((m) => !m)) return "mixed";
  return { signature: [...new Set(marks as string[])].join("；").slice(0, 200), step: [...new Set(steps.map((s) => `${s.job} / ${s.step}`))].join("；").slice(0, 200) };
}

/** `touched` = every file the tested change holds (a train car: the union over all of its members). */
export function classifyFailedLog(log: string, touched: ReadonlySet<string>): FailureClass {
  const env = envFault(log);
  if (env === "mixed") return { kind: "code", why: "环境故障签名之外还有别的失败步骤（混合红）" };
  if (env) return { kind: "env", ...env };
  const failures = parseFailedLog(log);
  if (!failures) return { kind: "unknown", why: "失败日志解析不出 bun test 的失败用例，也没有确定的环境故障签名" };
  const own = firstTouched(failures, touched);
  if (own) return { kind: "code", why: `失败的测试文件 ${own.file} 在改动里` };
  const files = [...new Set(failures.map((f) => f.file))].sort();
  if (firstAsserted(failures)) return { kind: "known_flaky", files };
  return { kind: "timeout", files, cases: failures.map((f) => `${f.file} > ${f.name}`) };
}
