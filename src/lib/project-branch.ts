/**
 * Branch context carried by dispatch, lend, reborrow, remote fix and local author plans (generality-BRANCH1).
 * The merge target (PR base) and the work start are separate facts: a start ref never stands in for the target, and no
 * downstream step fills in "main". Pure resolution lives here; local Git reads are in project-branch-git.ts.
 * Recovery key projectBranchContext (schema class, default observe): observe keeps every legacy action and only reports the
 * difference, off stops the new propagation but still refuses a recorded non-main target. docs/architecture/project-decl-branch1.md.
 */
import { isBaseBranch } from "./lend-git.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

/** The Floka configuration value. Only a legacy path or a Floka repository may use it; it is never a guess for another target. */
export const LEGACY_TARGET = "main";
export const FLOKA_REMOTE = "shawnlu96/claudestra";

type BranchContextSource = "declared" | "config" | "pr" | "remoteHead" | "legacy";
export interface BranchContext {
  v: 1;
  /** Canonical owner/repo identity of origin. */
  remote: string;
  /** origin/HEAD as fixed in local Git metadata; null when it was not needed (explicit target). */
  defaultBranch: string | null;
  /** Merge target, i.e. the PR base. */
  targetBranch: string;
  /** Where the work starts; may differ from the target (for example a feature branch merging into develop). */
  workStartRef: string;
  workStartSha: string | null;
  targetHead: string | null;
  source: BranchContextSource;
}
type BranchErrorCode = "REMOTE_UNKNOWN" | "REMOTE_MISMATCH" | "REMOTE_HEAD_MISSING" | "PR_BASE_CONFLICT" | "INVALID_BRANCH"
  | "DECLARATION_INCONSISTENT" | "BASIS_STALE" | "CONTEXT_CHANGED" | "CONTEXT_MISSING";
export type BranchContextResult = { ok: true; context: BranchContext } | { ok: false; code: BranchErrorCode; reason: string };

/** Everything resolution may consult. Declaration facts must already be self-consistent (project-branch-git.ts). */
export interface BranchFacts {
  remote: string | null;
  /** The order / card repository; a different origin is an identity conflict, never a fallback. */
  expectedRemote?: string | null;
  defaultBranch: string | null;
  declaredTarget?: string | null;
  declaredRemote?: string | null;
  /** Configuration value (Floka keeps "main" here). Same rank as a declaration. */
  configTarget?: string | null;
  /** Base of the card's existing PR. */
  prBase?: string | null;
  workStartRef?: string | null;
  workStartSha?: string | null;
  targetHead?: string | null;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const fail = (code: BranchErrorCode, reason: string): BranchContextResult => ({ ok: false, code, reason });

export function resolveBranchContext(f: BranchFacts): BranchContextResult {
  if (!f.remote) return fail("REMOTE_UNKNOWN", "origin 的仓库身份识别不了");
  if (f.expectedRemote && f.expectedRemote !== f.remote) return fail("REMOTE_MISMATCH", `订单仓库 ${f.expectedRemote} 与本地 origin ${f.remote} 不是同一个`);
  if (f.declaredRemote && f.declaredRemote !== f.remote) return fail("REMOTE_MISMATCH", `声明的仓库 ${f.declaredRemote} 与本地 origin ${f.remote} 不是同一个`);
  if (f.declaredTarget && f.configTarget && f.declaredTarget !== f.configTarget) {
    return fail("DECLARATION_INCONSISTENT", `声明目标 ${f.declaredTarget} 与配置目标 ${f.configTarget} 不一致`);
  }
  const explicit = f.declaredTarget ?? f.configTarget ?? null;
  if (explicit && f.prBase && explicit !== f.prBase) return fail("PR_BASE_CONFLICT", `已有 PR 的 base ${f.prBase} 与声明目标 ${explicit} 冲突`);
  const target = explicit ?? f.prBase ?? f.defaultBranch;
  if (!target) return fail("REMOTE_HEAD_MISSING", "没有目标分支声明、已有 PR，也没有固定的 origin/HEAD；不按 main 猜");
  const source: BranchContextSource = f.declaredTarget ? "declared" : f.configTarget ? "config" : f.prBase ? "pr" : "remoteHead";
  const start = f.workStartRef ?? target;
  for (const b of [target, start, f.defaultBranch].filter((x): x is string => !!x)) {
    if (!isBaseBranch(b)) return fail("INVALID_BRANCH", `${b} 不是能用的分支名`);
  }
  for (const s of [f.workStartSha, f.targetHead]) if (s != null && !SHA.test(s)) return fail("INVALID_BRANCH", "起点或目标 head 不是完整提交号");
  return { ok: true, context: { v: 1, remote: f.remote, defaultBranch: f.defaultBranch, targetBranch: target, workStartRef: start,
    workStartSha: f.workStartSha ?? null, targetHead: f.targetHead ?? null, source } };
}

const KEYS = ["v", "remote", "defaultBranch", "targetBranch", "workStartRef", "workStartSha", "targetHead", "source"];
const SOURCES: readonly string[] = ["declared", "config", "pr", "remoteHead", "legacy"];
/** Strict reader for a context carried on a card or order; anything malformed is null (stop), never a partial context. */
export function parseBranchContext(v: unknown): BranchContext | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(o, k)) || o.v !== 1) return null;
  const branch = (x: unknown) => typeof x === "string" && isBaseBranch(x);
  const sha = (x: unknown) => x === null || (typeof x === "string" && SHA.test(x));
  if (typeof o.remote !== "string" || !o.remote.includes("/") || !(o.defaultBranch === null || branch(o.defaultBranch)) || !branch(o.targetBranch)
    || !branch(o.workStartRef) || !sha(o.workStartSha) || !sha(o.targetHead) || !SOURCES.includes(String(o.source))) return null;
  return o as unknown as BranchContext;
}

/**
 * Every stage after dispatch must hand on the same identity, target and start. A start SHA may be filled in once (dispatch fixes
 * it from the start ref) but never changed afterwards.
 */
export function carryBranchContext(prev: BranchContext, next: BranchContext): BranchContextResult {
  const changed: string[] = (["remote", "targetBranch", "workStartRef"] as const).filter((k) => prev[k] !== next[k]);
  if (prev.workStartSha !== null && prev.workStartSha !== next.workStartSha) changed.push("workStartSha");
  if (changed.length) return fail("CONTEXT_CHANGED", `订单链上的 ${changed.join(" / ")} 变了`);
  return { ok: true, context: next };
}

/**
 * An old order without a context: completed only when repository, PR base and order base agree on one target.
 * Anything ambiguous is null and stops for a human.
 */
export function legacyBranchContext(o: { repo: string | null; base: string | null; prBase?: string | null; headSha?: string | null }): BranchContext | null {
  if (!o.repo || !o.repo.includes("/") || !o.base || !isBaseBranch(o.base)) return null;
  if (o.prBase !== undefined && o.prBase !== null && o.prBase !== o.base) return null;
  if (o.base !== LEGACY_TARGET && !o.prBase) return null; // a non-main target needs a second witness
  return { v: 1, remote: o.repo, defaultBranch: null, targetBranch: o.base, workStartRef: o.base,
    workStartSha: o.headSha && SHA.test(o.headSha) ? o.headSha : null, targetHead: null, source: "legacy" };
}

let policyPath = RECOVERY_POLICY_PATH;
/** Diagnostics and tests read another policy file through the same strict reader; null restores the state directory's file. */
export function setBranchContextPolicyPath(path: string | null): void { policyPath = path ?? RECOVERY_POLICY_PATH; }
export const branchContextMode = (project: string): RecoveryMode => recoveryPolicy(project, "projectBranchContext", policyPath).mode;

/**
 * The PR base a later stage must keep. on: the recorded target, or null (stop) if it is unusable. observe / off: the legacy main,
 * so a recorded non-main target fails the caller's equality check instead of silently becoming main.
 */
export function carriedTarget(project: string, recorded: string | null | undefined, mode = branchContextMode(project)): string | null {
  if (mode !== "on") return LEGACY_TARGET;
  return recorded && isBaseBranch(recorded) ? recorded : null;
}
