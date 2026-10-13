/**
 * CIRES1 · the leased GitHub snapshot ciManualResume (manual-recovery-ci.ts) proves on: the card's PR, every check on its head,
 * the Actions runs behind them with their attempt, and what the first attempt of a re-run run failed with (classified by
 * ci-failure-class.ts against the PR's files). Read-only: it never sends a re-run, and a failed read throws so the leased CLI
 * refuses the card. The lease lives on the object this process read, so a copied or re-parsed snapshot is no evidence.
 * tests/manual-recovery-ci*.test.ts.
 */
import { createHash } from "node:crypto";
import { classifyFailedLog, type FailureClass } from "./ci-failure-class.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { ExternalSnapshot } from "./manual-recovery-release.js";
import { runBounded } from "./run-bounded.js";
import { ciRerunGh } from "./scheduler-merge-ci-rerun.js";
import type { PrSnapshot } from "./scheduler-merge-driver.js";
import { isTestProcess } from "./test-guard.js";

type PrRead = Pick<PrSnapshot, "state" | "head" | "base" | "branch" | "draft" | "crossRepository" | "checks">;
/** The reads this needs; a test puts its own in with setCiEvidenceGh. There is no re-run call on it. */
export interface CiEvidenceGh {
  inspect(prRef: string): Promise<PrRead>;
  runAttempt(repo: string, runId: string): Promise<{ attempt: number; status: string; conclusion: string }>;
  /** `gh run view --attempt 1 --log-failed`: the red the re-run was authorized for, not the latest attempt's */
  firstFailedLog(repo: string, runId: string): Promise<string>;
  prFiles(prRef: string): Promise<string[]>;
}

interface RunFacts {
  link: string; attempt: number; status: string; conclusion: string;
  /** set when the run was re-run: its first attempt's failure class and failing test files */
  first: { kind: FailureClass["kind"]; files: string[]; why: string } | null;
}
interface CiFacts {
  pr: { ref: string; state: string; head: string; base: string; branch: string; draft: boolean; crossRepository: boolean };
  checks: { name: string; bucket: string; run: string | null }[];
  runs: RunFacts[];
}
/** `facts` and their digest enter the proof; when it was read stays off the JSON, so the same facts prove the same fingerprint. */
export interface CiSnapshot extends ExternalSnapshot { facts: CiFacts }

/** How long a snapshot may stand between its read and the hand-back it proves; past it the next tick reads again. */
export const CI_SNAPSHOT_LEASE_MS = 2 * 60_000;
/** A PR's checks normally sit on one workflow run; more than a few means this is not the card the claim was made for. */
const MAX_RUNS = 4;
/** runBounded stops reading at 1 MiB: a log near that may be cut, and the cut part could hold the failure that matters. */
const LOG_LIMIT = 900 * 1024;
const RUN_LINK = /^(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+))(?:\/\S*)?$/;
const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";
const sameSha = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const digestOf = (facts: CiFacts): string => createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);

/** Structured argv, `--repo` / the PR URL name the repository, so no checkout is needed. Run attempt and PR files are CIF1's own reads. */
function ciEvidenceGh(command: typeof runBounded = runBounded): CiEvidenceGh {
  const { runAttempt, prFiles } = ciRerunGh(command);
  const read = async (what: string, argv: string[]): Promise<string> => {
    const r = await command(["gh", ...argv], { timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" } });
    if (r.timedOut || r.code !== 0) throw new Error(`${what} 失败：${firstLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  return {
    runAttempt, prFiles,
    async inspect(prRef) {
      const pr = JSON.parse(await read("gh pr view", ["pr", "view", prRef, "--json", "state,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository"])) as Record<string, unknown>;
      if (typeof pr.state !== "string" || typeof pr.headRefOid !== "string") throw new Error("gh pr view 没给出 PR 状态或 head");
      // a pending check makes gh exit 8, which is refused with the rest: a snapshot is only evidence once every check has ended
      const checks = JSON.parse(await read("gh pr checks", ["pr", "checks", prRef, "--json", "bucket,name,link"])) as PrRead["checks"];
      if (!Array.isArray(checks) || checks.some((c) => typeof c?.name !== "string" || typeof c?.bucket !== "string")) throw new Error("gh pr checks 输出无效");
      return { state: pr.state as PrRead["state"], head: pr.headRefOid, base: String(pr.baseRefName ?? ""), branch: String(pr.headRefName ?? ""),
        draft: pr.isDraft === true, crossRepository: pr.isCrossRepository !== false, checks };
    },
    async firstFailedLog(repo, runId) {
      const log = await read("gh run view --attempt 1", ["run", "view", runId, "--repo", repo, "--attempt", "1", "--log-failed"]);
      if (Buffer.byteLength(log) >= LOG_LIMIT) throw new Error("首次失败日志太长，可能被截断");
      return log;
    },
  };
}

let injected: CiEvidenceGh | null = null;
/** Tests only. Without it a test process never reaches the real gh: the read throws and the card is refused. */
export function setCiEvidenceGh(gh: CiEvidenceGh | null): void { injected = gh; }

const LEASES = new WeakMap<object, number>();

/**
 * One snapshot for the leased CLI. The PR is read before and after the runs: a head or state that moved in between is no
 * snapshot at all. Every doubt throws (fail-closed); nothing here writes or re-runs.
 */
export async function readCiEvidence(task: LedgerTask): Promise<CiSnapshot> {
  const gh = injected ?? (isTestProcess() ? null : ciEvidenceGh());
  if (!gh) throw new Error("测试进程没有注入 gh 读取口，不读真实 GitHub");
  const ref = task.pr;
  if (!ref || !task.headSHA) throw new Error("卡上没有 PR 或 head");
  const readAt = Date.now(), pr = await gh.inspect(ref);
  const checks = pr.checks.map((c) => ({ name: c.name, bucket: c.bucket, run: RUN_LINK.exec(c.link ?? "")?.[1] ?? null }));
  const links = [...new Set(checks.map((c) => c.run).filter((l): l is string => !!l))].sort();
  if (links.length > MAX_RUNS) throw new Error(`检查分属 ${links.length} 个 run，超过 ${MAX_RUNS} 个不读`);
  const touched = new Set(await gh.prFiles(ref));
  const runs: RunFacts[] = [];
  for (const link of links) {
    const [, , repo, runId] = RUN_LINK.exec(link)!;
    const now = await gh.runAttempt(repo!, runId!);
    const c = now.attempt > 1 ? classifyFailedLog(await gh.firstFailedLog(repo!, runId!), touched) : null;
    runs.push({ link, attempt: now.attempt, status: now.status, conclusion: now.conclusion,
      first: c && { kind: c.kind, files: "files" in c ? c.files : [], why: "why" in c ? c.why : "" } });
  }
  const after = await gh.inspect(ref);
  if (after.state !== pr.state || !sameSha(after.head, pr.head)) throw new Error("读取期间 PR 状态或 head 变了");
  const facts: CiFacts = { pr: { ref, state: pr.state, head: pr.head, base: pr.base, branch: pr.branch, draft: pr.draft, crossRepository: pr.crossRepository }, checks, runs };
  const snapshot = { source: `gh:${ref}`, digest: digestOf(facts), facts } as CiSnapshot;
  // readAt off the JSON (non-enumerable): the proof fingerprint and the observe note's key must not change with every read
  Object.defineProperty(snapshot, "readAt", { value: readAt, enumerable: false });
  LEASES.set(snapshot, readAt + CI_SNAPSHOT_LEASE_MS);
  return snapshot;
}

export interface CiWanted {
  pr: string; head: string;
  /** the merge run's required checks, and the ones the authorized re-run was claimed for */
  required: readonly string[]; claimed: readonly string[];
  /** the one run the ledger authorized a re-run of */
  run: string;
  kind: "timeout" | "known_flaky"; files: readonly string[];
  now: number;
}

/** The first attempt, read again today, must still be the red the re-run was authorized for. */
function firstGap(first: RunFacts["first"], want: CiWanted): string | null {
  if (!first) return "授权重跑的 run 没有首次失败的归类";
  if (first.kind !== want.kind) return `首次失败现在归类为 ${first.kind}${first.why ? `（${first.why}）` : ""}，不是授权时的 ${want.kind}`;
  const got = new Set(first.files), all = want.files.every((f) => got.has(f));
  if (!all || (want.kind === "known_flaky" && got.size !== want.files.length)) return "首次失败的测试文件和授权重跑时登记的不一致";
  return null;
}

/**
 * null = the snapshot shows exactly what the ledger's claim needs: this process's live lease, the open PR on the card's head, every
 * required check passed and no check red or pending, the claimed run re-run exactly once (attempt 2, completed, success) with the
 * claimed checks on it, no other run re-run, and the first attempt still classified as the claim says. Otherwise the gap.
 */
export function ciSnapshotGap(external: ExternalSnapshot | null, want: CiWanted): string | null {
  const lease = external ? LEASES.get(external) : undefined, facts = (external as CiSnapshot | null)?.facts;
  if (!external || !facts || lease === undefined) return "缺本进程带租约读出的外部快照";
  if (want.now > lease) return "外部快照的租约已过期，下一轮重读";
  if (external.digest !== digestOf(facts) || external.source !== `gh:${want.pr}` || facts.pr.ref !== want.pr) return "外部快照不是这张卡的 PR，或内容与摘要不符";
  const pr = facts.pr;
  if (pr.state !== "OPEN" || pr.base !== "main" || pr.draft || pr.crossRepository) return `PR 不是 main 上打开的本仓 PR（${pr.state}/${pr.base}）`;
  if (!sameSha(pr.head, want.head)) return `PR head 已漂移（${pr.head.slice(0, 12)}），不是卡上的 head`;
  const named = (n: string) => facts.checks.filter((c) => c.name === n);
  const missing = want.required.find((n) => !named(n).length || named(n).some((c) => c.bucket !== "pass"));
  if (missing) return `必过检查 ${missing} 缺失或没有完成 success`;
  const open = facts.checks.find((c) => ["fail", "cancel", "pending"].includes(c.bucket));
  if (open) return `检查 ${open.name} 是 ${open.bucket}`;
  const run = facts.runs.find((r) => r.link === want.run);
  if (!run || want.claimed.some((n) => named(n).some((c) => c.run !== want.run))) return "授权重跑的检查现在不在那个 run 上";
  if (run.attempt !== 2) return run.attempt < 2 ? "授权的重跑没有发生（run 仍是第 1 次）" : `run 被重跑了不止一次（第 ${run.attempt} 次），超出一次正式授权`;
  if (run.status !== "completed" || run.conclusion !== "success") return `重跑没有成功完成（${run.status}/${run.conclusion || "-"}）`;
  const other = facts.runs.find((r) => r.link !== want.run && r.attempt > 1);
  if (other) return `另一个 run 也被重跑过（${other.link}），没有正式授权`;
  return firstGap(run.first, want);
}
