/**
 * MAINP2 验收线 7：merge 阶段、本轮有效 PASS（含正式沿用链）、当前 head 必需 CI 现查全绿、60 分钟没动的卡报 PM 并写明实际阻塞。
 * 与 ledger-audit.ts 同一套落库 / 去重 / 首轮基线静默。CI 只认 collectMergeCi 按当前 head 现查的结果：缓存 / 网络失败 / 旧 head 不算绿；
 * 这一轮没取到（null）整条规则 skipped、不 evaluated，不把上一轮的发现误标已解决。key = 卡 + head + 来源审查，换 mainCarry 模式不重推。
 * tests/ledger-audit-merge-ready*.test.ts。
 */
import type { AuditFinding, AuditRule, AuditSnapshot } from "./ledger-audit.js";
import { currentStageMark, stageTimeline } from "./ledger-metrics.js";
import { diagnoseManual } from "./manual-reason.js";
import { mainCarryMode } from "./recovery-main-carry-policy.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";
import { carriedReview } from "./review-main-carry-manual.js";
import { headChecks, type Run } from "./review-main-carry-manual-ci.js";
import { runBounded } from "./run-bounded.js";
import { parseRequiredChecks, readSchedulerConfig } from "./scheduler-config.js";

const MIN = 60_000;
export const MERGE_READY_RULES = ["merge_ready_idle"] as const;
export const MERGE_READY_IDLE_MS = 60 * MIN;

/** 当前 head 的 CI（collectMergeCi 按 head 现查 GitHub check runs 填）；missing = 必需检查里缺的 / 非 success 的名字 */
export interface MergeCiFact { head: string; state: "green" | "red" | "pending" | "unknown"; source: "live" | "cache"; checkedAt: number; missing?: readonly string[] }
export interface MergeReadyInputs {
  /** 按任务 id；null = 这一轮没取到（进 skipped）；undefined = 快照没带这个来源（规则不跑） */
  mergeCi?: Readonly<Record<string, MergeCiFact>> | null;
  /** 接线方另知的真实阻塞（UI 证据、测量输入等），按任务 id */
  mergeBlockers?: Readonly<Record<string, readonly string[]>>;
}
type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] }) => void;
interface Out { emit: Emit; evaluated: AuditRule[]; skip: (reason: string, ...rules: AuditRule[]) => void }

const green = (ci: MergeCiFact | undefined, head: string | null): boolean =>
  !!ci && !!head && ci.source === "live" && ci.state === "green" && ci.head === head && !(ci.missing?.length);

const validPass = (task: AuditSnapshot["tasks"][number]["task"], events: AuditSnapshot["tasks"][number]["events"]): boolean => {
  const r = carriedReview(task, events);
  return r.kind === "facts" && r.facts.verdict === "pass" && !r.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1");
};

export function mergeReadyAudit(s: AuditSnapshot & MergeReadyInputs, now: number, policy: RecoveryPolicyPort | undefined, out: Out): void {
  if (s.mergeCi === undefined) return; // 快照没带 CI 来源：规则不跑也不报 skipped
  if (s.mergeCi === null) return out.skip("当前 head CI 没取到（缓存 / 网络未知不算绿）", "merge_ready_idle");
  const unknown = new Set(s.mergeUnknown?.map((r) => r.taskId));
  const mode = mainCarryMode(s.project, policy).mode;
  for (const { task, events, blockedBy } of s.tasks) {
    if (task.stage !== "merge" || currentStageMark(events)?.data.approxTime === true) continue;
    const stageSince = stageTimeline(events, now).at(-1)?.from ?? null;
    if (stageSince === null) continue;
    const review = carriedReview(task, events);
    if (review.kind !== "facts" || !validPass(task, events)) continue;
    if (!green(s.mergeCi[task.id], task.headSHA)) continue;
    const since = Math.max(stageSince, events.at(-1)?.ts ?? stageSince);
    if (now - since <= MERGE_READY_IDLE_MS) continue;
    const blockers: string[] = [];
    if (s.queueFrozen) blockers.push("合并队列冻结");
    if (blockedBy?.length) blockers.push(`依赖未上线：${blockedBy.join("、")}`);
    if (unknown.has(task.id)) blockers.push("合并 journal 结果不明");
    if (diagnoseManual({ task, events })?.code === "owner_hold") blockers.push("owner hold");
    blockers.push(...(s.mergeBlockers?.[task.id] ?? []));
    const via = review.carries.length ? `（经 ${review.carries.length} 次正式沿用）` : "";
    out.emit({ rule: "merge_ready_idle", taskId: task.id, since, keyParts: [task.id, task.headSHA!, review.facts.eventSeq],
      detail: `${task.id} 在 merge，审查 #${review.facts.eventSeq} 已 PASS${via}、当前 head ${task.headSHA!.slice(0, 12)} CI 全绿，已 ${Math.floor((now - since) / MIN)} 分钟没动；`
        + `实际阻塞：${blockers.join("；") || "台账里看不出"}；mainCarry=${mode}`,
      suggestion: blockers.length ? "先解掉上面的阻塞，再走正式合并入口" : "走正式合并入口（preflight 核最终 head / main / CI 后钉 head 合并）" });
  }
  out.evaluated.push("merge_ready_idle");
}

const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/;
export interface MergeCiDeps { run: Run; checksOf: (project: string) => unknown }

/**
 * The snapshot's CI source: each merge card that already has a valid PASS gets its current head's required checks (the
 * project's scheduler.json requiredChecks) read live. Any read failing, or no project list, returns null for the whole
 * project, so the rule skips instead of resolving on unknown; a card without a PASS costs no GitHub call.
 */
export async function collectMergeCi(project: string, tasks: AuditSnapshot["tasks"], now: number, deps: MergeCiDeps):
  Promise<Record<string, MergeCiFact> | null> {
  const want = tasks.filter(({ task, events }) => task.stage === "merge" && !!task.headSHA && PR.test(task.pr ?? "") && validPass(task, events));
  if (!want.length) return {};
  try {
    const checks = parseRequiredChecks(deps.checksOf(project));
    if (!checks) return null;
    const out: Record<string, MergeCiFact> = {};
    for (const { task } of want) {
      const head = task.headSHA!, states = await headChecks(deps.run, PR.exec(task.pr!)![1]!, head, checks);
      const bad = Object.entries(states).filter(([, v]) => v !== "pass").map(([k]) => k);
      const vals = Object.values(states);
      out[task.id] = { head, source: "live", checkedAt: now, missing: bad,
        state: !bad.length ? "green" : vals.some((v) => ["fail", "cancelled", "skipped"].includes(v)) ? "red"
          : vals.some((v) => v === "unknown") ? "unknown" : "pending" };
    }
    return out;
  } catch { return null; }
}


/** Production source (ledger-audit-snapshot.ts realSources): gh through runBounded, required checks from the scheduler config read now. */
export const liveMergeCi = (project: string, tasks: AuditSnapshot["tasks"], now: number): Promise<Record<string, MergeCiFact> | null> =>
  collectMergeCi(project, tasks, now, { run: runBounded, checksOf: (p) => readSchedulerConfig().projects[p]?.requiredChecks });
