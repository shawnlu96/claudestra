/**
 * Serial / manual merge full re-check (merge-arch-SELECT1). A PR whose CI ran only the related tests (ci.yml `scope` job reads
 * `ci scope related`) has a green required check that proves nothing about the rest of the suite, so before the serial driver's
 * merge claim it asks for one explicit full run of the same workflow through workflow_dispatch on main, bound to the PR's
 * current head, base (main tip), GitHub test-merge commit and its tree; the workflow refuses to run on any other checkout.
 * A passed "ci scope full" (or no scope check: pre-SELECT1 runs were full) skips this; any other scope check needs it.
 * The request id is a digest of that binding: a moved head / base is a new request, a repeated tick finds the same run (or the
 * dispatch noted below) and never dispatches twice. Waits are bounded from the first tick that needed the re-check (a test merge
 * GitHub never computes included); each failure is classified and goes to PM via the driver's unknown. A passed run's binding is
 * re-read right after the run lookup (drift = a new request) and once more right before the merge API call (drift = merge not sent).
 * Train-cleared members never get here (the train ran full). tests/scheduler-ci-full-request.test.ts.
 */
import { createHash } from "node:crypto";
import type { MergeRun } from "./scheduler-merge.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import { ciSelectedFullPass } from "./scheduler-ci-selected-gate.js";

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
type FullFailClass = "dispatch_failed" | "dispatch_lost" | "run_failed" | "timeout" | "subject_invalid" | "subject_timeout" | "binding_drift" | "pass_expired";
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
/** PR + head → when this process first needed its re-check; bounds a test merge GitHub never computes (subject stays "wait"). */
const entered = new Map<string, number>();
/** PR + head → the binding whose full run passed (and when); the merge call of that same tick re-reads it right before sending. */
const passed = new Map<string, { subject: FullSubject; at: number }>();
/** A pass older than this belongs to a tick that did not merge: its merge call is refused, never sent unbound; fullRecheck re-binds. */
const PASS_FRESH_MS = 5 * 60_000;
const prKey = (prRef: string, head: string): string => `${prRef}\n${head.toLowerCase()}`;
const sameBinding = (a: FullSubject, b: FullSubject | "wait"): boolean => b !== "wait" && fullRequestId(a) === fullRequestId(b);
/** Tests only. */
export const resetFullDispatches = (): void => { dispatched.clear(); entered.clear(); passed.clear(); };

/** Driver hook: null = merge may go on; "wait" = keep the run as is this tick; any other string = unknown with that reason. */
export async function fullRecheck(run: MergeRun, pr: PrSnapshot, port: FullRequestPort, now = Date.now()): Promise<null | "wait" | string> {
  const key = prKey(run.prRef, run.reviewedHead);
  passed.delete(key);
  if (!needsFullRecheck(pr.checks)) return null;
  const since = entered.get(key) ?? now;
  entered.set(key, since);
  const fail = (cls: FullFailClass, detail: string): string => { entered.delete(key); return fullFailReason(cls, detail); };
  const subject = await port.subject(run.prRef, run.reviewedHead);
  if (subject === "wait") {
    return now - since > FULL_WAIT_MS ? fail("subject_timeout", `GitHub 测试合并 ${Math.round((now - since) / 60_000)} 分钟仍未对上当前 main 与 head`) : "wait";
  }
  const bad = subjectProblems(subject);
  if (bad.length) return fail("subject_invalid", bad.join("；"));
  if (subject.head.toLowerCase() !== run.reviewedHead.toLowerCase() || subject.head.toLowerCase() !== pr.head.toLowerCase()) return "wait"; // the driver handles a moved head
  const id = fullRequestId(subject);
  const d = decideFull({ id, runs: await port.runs(subject.repo), dispatchedAt: dispatched.get(id), now });
  if (d.kind === "pass") { const sel = await ciSelectedFullPass(run, subject, d.runId); if (sel) return sel === "wait" ? "wait" : fail("run_failed", sel); } // CISEL2
  if (d.kind === "pass") {
    // main may have moved while the runs were read: the pass only counts for a binding that is still the current one
    if (!sameBinding(subject, await port.subject(run.prRef, run.reviewedHead))) return "wait"; // next tick binds the new base: a new request
    entered.delete(key);
    passed.set(key, { subject, at: Date.now() });
    return null;
  }
  if (d.kind === "wait") return "wait";
  if (d.kind === "fail") return fail(d.cls, d.detail);
  dispatched.set(id, now); // noted before the call: a failed or hung call is never re-sent by the next tick
  try { await port.dispatch(subject, id); } catch (e) { return fail("dispatch_failed", `${id}：${(e as Error).message.slice(0, 300)}`); }
  return "wait";
}

/**
 * The merge call of a PR whose full run passed: re-reads the binding right before sending (the merge API pins only the head, so a
 * base moved since the pass would merge untested content). Drift or an expired pass throws before anything is sent; the driver records it as unknown.
 */
export async function fullBoundMerge(prRef: string, head: string, port: FullRequestPort, send: () => Promise<string>, at = Date.now()): Promise<string> {
  const key = prKey(prRef, head), pass = passed.get(key);
  passed.delete(key);
  if (!pass) return send(); // fullRecheck found no re-check needed (no scope check, or a passed full scope)
  if (at - pass.at > PASS_FRESH_MS) {
    throw new Error(fullFailReason("pass_expired", `合并未发出：补验通过已 ${Math.round((at - pass.at) / 60_000)} 分钟，须重新核对绑定`));
  }
  const bound = pass.subject;
  const now = await port.subject(prRef, head);
  if (!sameBinding(bound, now)) {
    throw new Error(fullFailReason("binding_drift", `合并未发出：补验通过的 base ${bound.base.slice(0, 12)} 已不是当前测试合并（${now === "wait" ? "GitHub 重算中" : now.base.slice(0, 12)}）`));
  }
  return send();
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

/** Adds the hook and the bound merge to a merge external (the same object, so wrappers relying on their own closures keep working). */
export function withCiFullRequest(external: MergeExternal, gh: Gh): MergeExternal {
  const port = ghFullRequestPort(gh);
  const merge = external.merge.bind(external);
  external.fullRecheck = (run, pr) => fullRecheck(run, pr, port);
  external.merge = (pr, expectedHead) => fullBoundMerge(pr, expectedHead, port, () => merge(pr, expectedHead));
  return external;
}
