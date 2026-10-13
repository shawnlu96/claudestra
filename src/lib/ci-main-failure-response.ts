/** Exact related → full failure correlation; no I/O, culprit inference or git/deployment authorization. */
import { createHash } from "node:crypto";
import { mainCiSha } from "./scheduler-main-ci.js";
import type { RecoveryMode } from "./recovery-policy.js";

export interface FailureRun {
  origin: "actions-api"; repo: string; runId: number; attempt: number; latestAttempt: number;
  event: "pull_request" | "push" | "workflow_dispatch"; workflow: string; scope: "related" | "full";
  head: string; base: string; checkout: string; tree: string; completedAt: number; conclusion: string;
  checks: { name: string; conclusion: string | null }[];
}
interface Integration {
  origin: "github-api"; head: string; base: string; sha: string; tree: string; parents: string[]; mergedHead: string;
}
export interface FailureEvidence {
  key: string; project: string; repo: string; head: string; base: string; tree: string; integrationSha: string;
  relation: "correlation-only"; related: FailureRun; full: FailureRun; failedChecks: string[]; firstDiscoveredAt: number;
}
export interface CorrelationInput {
  project: string; repo: string; mainSha: string | null; now: number; requiredChecks: readonly string[];
  related: FailureRun; full: FailureRun; integration: Integration; previous?: FailureEvidence | null;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const time = (n: number) => Number.isSafeInteger(n) && n >= 0;
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const token = (s: string) => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(s);
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const failure = (v: string | null) => ["failure", "timed_out", "action_required", "startup_failure"].includes(v ?? "");

function validRun(r: FailureRun, repo: string, checks: readonly string[]): boolean {
  return r.origin === "actions-api" && same(r.repo, repo) && positive(r.runId) && positive(r.attempt) && r.attempt === r.latestAttempt &&
    r.workflow === ".github/workflows/ci.yml" && [r.head, r.base, r.checkout, r.tree].every(mainCiSha) && time(r.completedAt) &&
    r.checks.length > 0 && r.checks.every((c) => token(c.name)) && new Set(r.checks.map((c) => c.name)).size === r.checks.length &&
    checks.length > 0 && checks.every((c) => r.checks.some((j) => j.name === c));
}

/** Both runs must describe the same candidate, base and actual integration tree; provenance is supplied by the read adapter. */
export function correlateMainFailure(i: CorrelationInput): FailureEvidence | null {
  const { related: r, full: f, integration: s } = i;
  if (!time(i.now) || !mainCiSha(i.mainSha) || !/^[\w.-]+\/[\w.-]+$/.test(i.repo) || !token(i.project) ||
    !validRun(r, i.repo, i.requiredChecks.filter((c) => c !== "ci scope full")) || !validRun(f, i.repo, i.requiredChecks) || r.scope !== "related" || f.scope !== "full" ||
    r.event !== "pull_request" || !["push", "workflow_dispatch"].includes(f.event) || r.conclusion !== "success" ||
    r.checks.some((c) => c.conclusion !== "success") || !failure(f.conclusion) || r.completedAt > f.completedAt || f.completedAt > i.now) return null;
  if (s.origin !== "github-api" || ![s.head, s.base, s.sha, s.tree, s.mergedHead].every(mainCiSha) ||
    !same(s.sha, i.mainSha) || !same(s.sha, f.checkout) || !same(s.tree, f.tree) || !same(s.tree, r.tree) ||
    !same(s.head, r.head) || !same(s.head, f.head) || !same(s.head, s.mergedHead) || !same(s.base, r.base) || !same(s.base, f.base) ||
    !s.parents.length || !s.parents.every(mainCiSha) || !same(s.parents[0]!, s.base) ||
    (f.event === "workflow_dispatch" && (s.parents.length !== 2 || !same(s.parents[1]!, s.head)))) return null;
  const failedChecks = f.checks.filter((c) => failure(c.conclusion)).map((c) => c.name).sort();
  if (!failedChecks.length) return null;
  const key = `main-ci-failure:${digest([i.project, i.repo.toLowerCase(), s.sha.toLowerCase()])}`;
  return { key, project: i.project, repo: i.repo.toLowerCase(), head: s.head.toLowerCase(), base: s.base.toLowerCase(), tree: s.tree.toLowerCase(),
    integrationSha: s.sha.toLowerCase(), relation: "correlation-only", related: r, full: f, failedChecks,
    firstDiscoveredAt: i.previous?.key === key ? i.previous.firstDiscoveredAt : i.now };
}

export interface Receipt { owner: string; deadline: number; choice: "pending" | "repair" | "revert"; resume: "current-main-full-green" }
export function planFailureResponse(i: { mode: RecoveryMode; evidence: FailureEvidence | null; pm: string | null }) {
  const e = i.mode !== "off" ? i.evidence : null;
  return { reuseMainCi: i.mode === "on", notify: i.mode === "on" && !!e && !!i.pm,
    would: e ? ["main-ci-pause", "project-pm-notice"] : [],
    receipt: e && i.pm ? { owner: i.pm, deadline: e.firstDiscoveredAt + 30 * 60_000, choice: "pending",
      resume: "current-main-full-green" } as Receipt : null };
}

export const failureResponseValue = { time, positive, token, same };
