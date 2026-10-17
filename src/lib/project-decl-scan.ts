/**
 * generality-PROJSCAN1 · AI-assisted declaration draft and confirmation PR (docs/architecture/project-decl-projscan1.md).
 * Discovery (read-only, Git objects) → optional summary (refused unless reads are confined) → one bounded run per candidate in
 * the isolation area → a PROJDECL1 version 1 draft → a PR that changes only `.floka/project.json`. Nothing takes effect until a
 * PM or owner merges it. Recovery key projectDeclScan: off refuses, observe returns the draft and records a sample without any
 * repository or remote write, on also opens the PR.
 */
import { createHash } from "node:crypto";
import type { ProjectDef } from "./projects.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode } from "./recovery-policy.js";
import { DeclReadError, resolveDeclRepository, type DeclRepository } from "./project-decl-git.js";
import { parseProjectDeclaration, type DeclCommand, type ProjectDeclaration } from "./project-decl-schema.js";
import { discoverProject, type CandidateGroup, type DeclCandidate, type DiscoveryResult } from "./project-decl-discovery.js";
import { CODEX_READ_ISOLATION, summarizeDiscovery, type SummaryOutcome, type SummaryPorts } from "./project-decl-scan-ai.js";
import { createIsolationArea, darwinBoundary, removeIsolationArea, scanGit, verifyCandidates, type CandidateRun, type ExecBoundary,
  type IsolationArea, type ScanRunner } from "./project-decl-scan-run.js";
import { DECL_FILE, openDeclarationPr, type DeclPrOutcome } from "./project-decl-gh.js";
import { runBounded } from "./run-bounded.js";

const MANUAL_ENTRY = "Author .floka/project.json by hand on a branch and open a PR for PM / owner review, or rerun with --without-ai.";
export interface ProjectDeclScanOptions {
  project: ProjectDef; repoDir: string; targetBranch?: string; mode?: RecoveryMode;
  /** false = operator chose the deterministic draft; no model is involved at all. */
  ai?: boolean;
  /** A rescan proposal: always a separate branch and PR, never an update of an existing one. */
  rescan?: boolean;
  now?: () => number; run?: ScanRunner; boundary?: ExecBoundary; summary?: Partial<SummaryPorts>;
  observe?: (action: ObservedAction) => void;
}
export interface ProjectDeclScanResult {
  status: "refused" | "failed" | "observed" | "created" | "existing";
  reasonCode: string | null; mode: RecoveryMode; targetHead: string | null; manualEntry?: string;
  summary?: SummaryOutcome["status"] | "skipped_by_operator";
  discovery?: { sources: string[]; rejected: { path: string; reason: string }[] };
  runs?: CandidateRun[]; draft?: ProjectDeclaration; branch?: string; pr?: { number: number; url: string; state: string };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const refused = (reasonCode: string, mode: RecoveryMode, targetHead: string | null = null): ProjectDeclScanResult =>
  ({ status: "refused", reasonCode, mode, targetHead, manualEntry: MANUAL_ENTRY });

function regroup(candidates: DeclCandidate[], summary: SummaryOutcome | null): DeclCandidate[] {
  if (summary?.status !== "applied") return candidates;
  return candidates.flatMap((c) => {
    const g = summary.groups[c.id];
    if (g === "skip") return [];
    return [{ ...c, group: (g ?? c.group) as CandidateGroup }];
  });
}

/** PROJDECL1 version 1 shape; provenance is verified only for a successful bounded run at the target head. */
function buildDraft(repo: DeclRepository, defaultBranch: string, d: DiscoveryResult, candidates: DeclCandidate[], runs: CandidateRun[],
  verifiedAt: string): ProjectDeclaration {
  const command = (c: DeclCandidate): DeclCommand => {
    const run = runs.find((r) => r.id === c.id);
    const provenance = run?.status === "verified" ? { status: "verified" as const, verifiedHead: repo.targetHead, verifiedAt } : { status: "inferred" as const };
    return { id: c.id, argv: c.argv, cwd: c.cwd, timeoutSec: c.timeoutSec, provenance };
  };
  const group = (g: CandidateGroup) => candidates.filter((c) => c.group === g).map(command);
  const used = new Set([...candidates.map((c) => c.source), ...d.workflows]);
  return {
    version: 1,
    repository: { remote: repo.remote.split("/").length === 2 ? repo.remote : `https://${repo.remote}`, defaultBranch, targetBranch: repo.targetBranch },
    validation: { author: group("author"), review: group("review"), build: group("build") },
    tests: { rules: group("tests").map(({ cwd, ...c }) => ({ ...c, dir: cwd, fullWhen: ["**"] })), globs: d.testGlobs },
    ci: { provider: d.workflows.length ? "github" : "none", workflows: d.workflows, requiredChecks: [], testAdapter: null, reports: [] },
    ui: { renderInputs: d.renderInputs }, verification: { probes: [] }, deploy: { adapter: "none", provenance: { status: "inferred" } },
    basis: d.sources.filter((s) => used.has(s.path)).map((s) => ({ path: s.path, sha256: s.sha256 })),
  };
}

/** Stable across retries: volatile timestamps are excluded, so the same head and results always map to the same branch. */
function branchFor(head: string, draft: ProjectDeclaration, rescan: boolean): string {
  const stable = JSON.stringify(draft, (k, v) => k === "verifiedAt" ? undefined : v);
  return `floka/project-decl-${rescan ? "rescan" : "scan"}/${head.slice(0, 12)}-${sha256(stable).slice(0, 10)}`;
}
function prBody(draft: ProjectDeclaration, runs: CandidateRun[], summary: ProjectDeclScanResult["summary"], rescan: boolean): string {
  const rows = runs.map((r) => `| \`${r.id}\` | ${r.status} | ${r.reason} | ${r.exitCode ?? "-"} | ${r.timedOut ? "yes" : "no"} |`);
  return [`**AI draft${rescan ? " (rescan)" : ""}** of \`${DECL_FILE}\`. Not in effect until a PM or owner reviews and merges it; this tool never merges.`,
    "", `Model summary: ${summary}. Every command ran once in an isolated worktree of the target head with a timeout, a minimal`,
    "environment and an execution boundary (writes confined, network denied). Deploy is never probed and stays inferred.",
    "", "| command | provenance | result | exit | timed out |", "| --- | --- | --- | --- | --- |", ...rows,
    "", "Basis (relative path · sha256):", ...draft.basis.map((b) => `- \`${b.path}\` · \`${b.sha256}\``)].join("\n");
}

async function defaultBranchOf(run: ScanRunner, repo: DeclRepository): Promise<string> {
  const r = await scanGit(run, repo.root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const ref = r.stdout.trim(), prefix = "refs/remotes/origin/";
  return r.code === 0 && ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : repo.targetBranch;
}
function resolveRepo(o: ProjectDeclScanOptions): DeclRepository | string {
  try { return resolveDeclRepository(o.project, o.repoDir, o.targetBranch); }
  catch (error) {
    return error instanceof DeclReadError && error.reasonCode !== "GIT_READ_FAILED" ? error.reasonCode : "TARGET_HEAD_UNAVAILABLE";
  }
}

interface ScanContext { o: ProjectDeclScanOptions; repo: DeclRepository; mode: RecoveryMode; run: ScanRunner; discovery: DiscoveryResult }
async function draftInArea(ctx: ScanContext, area: IsolationArea, summary: SummaryOutcome | null): Promise<ProjectDeclScanResult> {
  const { o, repo, mode, run, discovery } = ctx;
  const candidates = regroup(discovery.candidates, summary);
  const runs = await verifyCandidates(candidates, area, { run, boundary: o.boundary ?? darwinBoundary(), clock: o.now });
  const draft = buildDraft(repo, await defaultBranchOf(run, repo), discovery, candidates, runs, new Date((o.now ?? Date.now)()).toISOString());
  const base: ProjectDeclScanResult = { status: "observed", reasonCode: null, mode, targetHead: repo.targetHead,
    summary: o.ai === false ? "skipped_by_operator" : summary?.status, runs, draft, branch: branchFor(repo.targetHead, draft, !!o.rescan),
    discovery: { sources: discovery.sources.map((s) => s.path), rejected: discovery.rejected } };
  if (!parseProjectDeclaration(draft).declaration) return { ...base, status: "failed", reasonCode: "DRAFT_INVALID", manualEntry: MANUAL_ENTRY };
  if (mode === "observe") {
    o.observe?.({ project: o.project.id, mechanism: "projectDeclScan", target: repo.targetHead, actionKey: "draft-pr",
      action: "open a project declaration draft PR", data: { previous: "no scan", candidate: base.branch,
        verified: runs.filter((r) => r.status === "verified").length, inferred: runs.filter((r) => r.status === "inferred").length } });
    return base;
  }
  const outcome: DeclPrOutcome = await openDeclarationPr(run, { repoRoot: repo.root, repo: repo.remote, base: repo.targetBranch,
    head: repo.targetHead, branch: base.branch ?? "", content: `${JSON.stringify(draft, null, 2)}\n`, controlDir: area.control,
    title: `${o.rescan ? "Rescan" : "AI draft"}: project declaration (${DECL_FILE})`, body: prBody(draft, runs, base.summary, !!o.rescan) });
  if ("fail" in outcome) return { ...base, status: "failed", reasonCode: "PR_FAILED", manualEntry: `${outcome.fail}. ${MANUAL_ENTRY}` };
  return { ...base, status: outcome.status, pr: outcome.pr };
}

export async function scanProjectDeclaration(o: ProjectDeclScanOptions): Promise<ProjectDeclScanResult> {
  const mode = o.mode ?? recoveryPolicy(o.project.id, "projectDeclScan").mode;
  if (mode === "off") return refused("RECOVERY_OFF", mode);
  const repo = resolveRepo(o);
  if (typeof repo === "string") return refused(repo, mode);
  const discovery = discoverProject(repo);
  if (!discovery.candidates.length && !discovery.workflows.length) return refused("NOTHING_DISCOVERED", mode, repo.targetHead);
  const isolation = o.summary?.isolation ?? CODEX_READ_ISOLATION;
  if (o.ai !== false && !isolation.confined) return refused("READ_ISOLATION_UNAVAILABLE", mode, repo.targetHead);
  const run = o.run ?? runBounded;
  const runId = `${repo.targetHead.slice(0, 12)}-${(o.now ?? Date.now)().toString(36)}-${process.pid}`;
  let area: IsolationArea;
  try { area = await createIsolationArea(run, repo.root, repo.targetHead, runId); }
  catch { return refused("ISOLATION_UNAVAILABLE", mode, repo.targetHead); /* no area means no run and no draft */ }
  try {
    const summary = o.ai === false ? null : await summarizeDiscovery(discovery, area.root, { codex: o.summary?.codex, isolation });
    return await draftInArea({ o, repo, mode, run, discovery }, area, summary);
  } finally {
    await removeIsolationArea(run, repo.root, area);
  }
}
