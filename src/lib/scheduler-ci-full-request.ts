/**
 * Serial / manual merge full re-check (merge-arch-SELECT1). A PR whose CI ran only the related tests (ci.yml `scope` job reads
 * `ci scope related`) has a green required check that proves nothing about the rest of the suite, so before the serial driver's
 * merge claim it asks for one explicit full run of the same workflow through workflow_dispatch on main, bound to the PR's
 * current head, base (main tip), GitHub test-merge commit and its tree; the workflow refuses to run on any other checkout.
 * A passed "ci scope full" (or no scope check: pre-SELECT1 runs were full) skips this; any other scope check needs it.
 * The request id is a digest of that binding: a moved head / base is a new request, a repeated tick finds the same run (or the
 * dispatch noted below) and never dispatches twice. Waits are bounded; each failure is classified and goes to PM via the driver's
 * unknown. Train-cleared members never get here (the train ran full). tests/scheduler-ci-full-request.test.ts.
 */
import { createHash } from "node:crypto";
import type { MergeRun } from "./scheduler-merge.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";

export const CI_SCOPE_FULL = "ci scope full";
export const CI_SCOPE_RELATED = "ci scope related";
const CI_FULL_WORKFLOW = "ci.yml";
/** A full run takes ~8 min after CISHARD1; this bounds queueing on top of it. Past it the request is a timeout for PM. */
export const FULL_WAIT_MS = 45 * 60_000;
/** A dispatch whose run never shows up in the run list within this long is lost (not re-sent silently). */
export const DISPATCH_VISIBLE_MS = 10 * 60_000;
const FULL_OWNER = "PM";

export interface FullSubject { repo: string; pr: number; head: string; base: string; merge: string; tree: string }
export interface FullRunFact { id: number; title: string; status: string; conclusion: string | null; createdAt: string }
type FullFailClass = "dispatch_failed" | "dispatch_lost" | "run_failed" | "timeout" | "subject_invalid";
export type FullDecision = { kind: "pass"; runId: number } | { kind: "wait"; why: string } | { kind: "dispatch"; id: string }
  | { kind: "fail"; cls: FullFailClass; detail: string };

const SHA = /^[0-9a-f]{40}$/i;
export const fullRequestId = (s: FullSubject): string => `cifull-${createHash("sha256")
  .update([s.repo.toLowerCase(), s.pr, s.head, s.base, s.merge, s.tree].map(String).map((x) => x.toLowerCase()).join("\n")).digest("hex").slice(0, 24)}`;
/** The dispatched run's name (ci.yml run-name); the only way a run list ties a run back to its request. */
export const fullRunTitle = (id: string): string => `ci full ${id}`;
const fullFailReason = (cls: FullFailClass, detail: string): string => `串行 full 补验失败（${cls}，责任人 ${FULL_OWNER}）：${detail}`;

/**
 * Any "ci scope …" check other than a passed "ci scope full" (related, an empty scope from a failed plan, pending) needs the re-check.
 * A run with no scope check at all is a workflow from before SELECT1, which always ran the full suite.
 */
export const needsFullRecheck = (checks: PrSnapshot["checks"]): boolean =>
  checks.some((c) => c.name.startsWith("ci scope")) && !checks.some((c) => c.name === CI_SCOPE_FULL && c.bucket === "pass");

function subjectProblems(s: FullSubject): string[] {
  const out: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(s.repo)) out.push(`repo 不合法：${s.repo}`);
  if (!Number.isSafeInteger(s.pr) || s.pr <= 0) out.push(`PR 号不合法：${s.pr}`);
  for (const k of ["head", "base", "merge", "tree"] as const) if (!SHA.test(s[k])) out.push(`${k} 不是完整 SHA`);
  return out;
}

/** Pure: what to do for one request id, given the runs carrying its title and when (if ever) this process dispatched it. */
export function decideFull(input: { id: string; runs: readonly FullRunFact[]; dispatchedAt?: number; now: number }): FullDecision {
  const mine = input.runs.filter((r) => r.title === fullRunTitle(input.id)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  const latest = mine[0];
  if (!latest) {
    if (input.dispatchedAt === undefined) return { kind: "dispatch", id: input.id };
    return input.now - input.dispatchedAt > DISPATCH_VISIBLE_MS
      ? { kind: "fail", cls: "dispatch_lost", detail: `${input.id} 已请求 ${Math.round((input.now - input.dispatchedAt) / 60_000)} 分钟仍不见运行` }
      : { kind: "wait", why: `${input.id} 已请求，等运行出现` };
  }
  if (latest.status === "completed") {
    return latest.conclusion === "success" ? { kind: "pass", runId: latest.id }
      : { kind: "fail", cls: "run_failed", detail: `${input.id} run ${latest.id} 结论 ${latest.conclusion ?? "未知"}` };
  }
  const since = input.dispatchedAt ?? Date.parse(latest.createdAt);
  if (Number.isFinite(since) && input.now - since > FULL_WAIT_MS) {
    return { kind: "fail", cls: "timeout", detail: `${input.id} run ${latest.id} 超过 ${FULL_WAIT_MS / 60_000} 分钟仍是 ${latest.status}` };
  }
  return { kind: "wait", why: `${input.id} run ${latest.id} ${latest.status}` };
}

/** The protected port: the only three GitHub calls this layer makes. subject = "wait" while GitHub has no current test merge. */
export interface FullRequestPort {
  subject(prRef: string, head: string): Promise<FullSubject | "wait">;
  runs(repo: string): Promise<FullRunFact[]>;
  dispatch(subject: FullSubject, id: string): Promise<void>;
}

/** Request id → when this process dispatched it. Module-level: mergeExternal is rebuilt every tick, the dedupe must outlive it. */
const dispatched = new Map<string, number>();
/** Tests only. */
export const resetFullDispatches = (): void => dispatched.clear();

/** Driver hook: null = merge may go on; "wait" = keep the run as is this tick; any other string = unknown with that reason. */
export async function fullRecheck(run: MergeRun, pr: PrSnapshot, port: FullRequestPort, now = Date.now()): Promise<null | "wait" | string> {
  if (!needsFullRecheck(pr.checks)) return null;
  const subject = await port.subject(run.prRef, run.reviewedHead);
  if (subject === "wait") return "wait";
  const bad = subjectProblems(subject);
  if (bad.length) return fullFailReason("subject_invalid", bad.join("；"));
  if (subject.head.toLowerCase() !== run.reviewedHead.toLowerCase() || subject.head.toLowerCase() !== pr.head.toLowerCase()) return "wait"; // the driver handles a moved head
  const id = fullRequestId(subject);
  const d = decideFull({ id, runs: await port.runs(subject.repo), dispatchedAt: dispatched.get(id), now });
  if (d.kind === "pass") return null;
  if (d.kind === "wait") return "wait";
  if (d.kind === "fail") return fullFailReason(d.cls, d.detail);
  dispatched.set(id, now); // noted before the call: a failed or hung call is never re-sent by the next tick
  try { await port.dispatch(subject, id); } catch (e) { return fullFailReason("dispatch_failed", `${id}：${(e as Error).message.slice(0, 300)}`); }
  return "wait";
}

type Gh = (...args: string[]) => Promise<string>;
const json = (s: string): Record<string, unknown> => {
  const v = JSON.parse(s) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("gh 输出不是 JSON 对象");
  return v as Record<string, unknown>;
};

/** gh-backed port. The test merge must sit exactly on the current main tip and the reviewed head, else GitHub is still recomputing. */
export function ghFullRequestPort(gh: Gh): FullRequestPort {
  return {
    async subject(prRef, head) {
      const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(prRef);
      if (!m) throw new Error("PR URL 不合法");
      const [repo, pr] = [m[1]!, Number(m[2])];
      const p = json(await gh("api", `repos/${repo}/pulls/${pr}`, "--jq", "{head: .head.sha, merge: .merge_commit_sha}"));
      if (typeof p.merge !== "string" || !SHA.test(p.merge) || String(p.head).toLowerCase() !== head.toLowerCase()) return "wait";
      const c = json(await gh("api", `repos/${repo}/commits/${p.merge}`, "--jq", "{tree: .commit.tree.sha, parents: [.parents[].sha]}"));
      const main = (await gh("api", `repos/${repo}/commits/main`, "--jq", ".sha")).trim();
      const parents = Array.isArray(c.parents) ? c.parents.map(String) : [];
      if (!SHA.test(main) || parents.length !== 2 || parents[0] !== main || parents[1]!.toLowerCase() !== head.toLowerCase()) return "wait";
      return { repo, pr, head, base: main, merge: p.merge, tree: String(c.tree) };
    },
    async runs(repo) {
      const list = JSON.parse(await gh("run", "list", "-R", repo, "--workflow", CI_FULL_WORKFLOW, "--event", "workflow_dispatch", "--limit", "100",
        "--json", "databaseId,displayTitle,status,conclusion,createdAt")) as unknown;
      if (!Array.isArray(list)) throw new Error("gh run list 输出无效");
      return list.map((r: Record<string, unknown>) => ({ id: Number(r.databaseId), title: String(r.displayTitle ?? ""), status: String(r.status ?? ""),
        conclusion: typeof r.conclusion === "string" && r.conclusion ? r.conclusion : null, createdAt: String(r.createdAt ?? "") }));
    },
    async dispatch(s, id) {
      await gh("workflow", "run", CI_FULL_WORKFLOW, "-R", s.repo, "--ref", "main", "-f", `request_id=${id}`, "-f", `pr=${s.pr}`,
        "-f", `head=${s.head}`, "-f", `base=${s.base}`, "-f", `merge=${s.merge}`, "-f", `tree=${s.tree}`);
    },
  };
}

/** Adds the hook to a merge external (the same object, so wrappers relying on their own closures keep working). */
export function withCiFullRequest(external: MergeExternal, gh: Gh): MergeExternal {
  const port = ghFullRequestPort(gh);
  external.fullRecheck = (run, pr) => fullRecheck(run, pr, port);
  return external;
}
