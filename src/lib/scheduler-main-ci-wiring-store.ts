/**
 * MAINCIW durable state, no new table and no schema change:
 * - meta (project, mainCiReadFailureSince / mainCiUncertainty): planMainCi's persisted read-failure start and check-evidence uncertainty;
 * - note events keyed `main-ci-notify:<plan.notification.key>`: the PM notice claim (a duplicate insert = already claimed, nothing sent);
 * - decision events keyed `main-ci-repair:…` (and their revokes): the persisted source of MainCiPmApproval, written by
 *   `ledger main-ci-repair` (manager/ledger-main-ci-cmds.ts) after the CLI's own authorization and GitHub read.
 * Reads only, on any connection (the pass's is query_only); the writes are scheduler-main-ci-wiring-write.ts, run only in the ledger CLI child.
 */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { mainCiSha, type MainCiHealth, type MainCiTarget } from "./scheduler-main-ci.js";
import type { MainCiPlan, MainCiPlanInput, MainCiPmApproval } from "./scheduler-main-ci-plan.js";

export const MAIN_CI_MAX_AGE_MS = 10 * 60_000;
export const FAILURE_KEY = "mainCiReadFailureSince", UNCERTAINTY_KEY = "mainCiUncertainty";
export const NOTIFY_PREFIX = "main-ci-notify:";
export const REPAIR_PREFIX = "main-ci-repair:";
export const REPAIR_OP = "main_ci_repair", REVOKE_OP = "main_ci_repair_revoke";
/** Same fault set as planMainCi's uncertainty window: evidence that cannot be judged yet, as opposed to a red check. */
const EVIDENCE_FAULTS = ["invalid_checks", "scope_mismatch", "stale_checks", "missing_check", "ambiguous_check"];

export interface MainCiPersisted { readFailureSince: number | null; uncertainty: NonNullable<MainCiPlanInput["uncertainty"]> | null }

const metaValue = (db: Database, project: string, key: string): unknown => {
  const row = db.query("SELECT value FROM meta WHERE project = ? AND key = ?").get(project, key) as { value: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.value) as unknown; }
  catch (e) {
    // only this process wrote the value (scheduler-main-ci --op state); a corrupt one is reported and treated as unset: the
    // failure / uncertainty window restarts from this read, which can only delay a PM notice, never lift a pause (health decides that)
    console.error(`⚠️ [main-ci] ${project} meta ${key} 读坏，按未计时处理：${(e as Error).message}`);
    return null;
  }
};

export function readMainCiState(db: Database, project: string): MainCiPersisted {
  const since = metaValue(db, project, FAILURE_KEY), u = metaValue(db, project, UNCERTAINTY_KEY) as Record<string, unknown> | null;
  const uncertainty = u && typeof u.project === "string" && typeof u.repo === "string" && mainCiSha(u.mainSha) && Number.isSafeInteger(u.since)
    ? { project: u.project, repo: u.repo, mainSha: u.mainSha, since: u.since as number } : null;
  return { readFailureSince: Number.isSafeInteger(since) ? since as number : null, uncertainty };
}

/** The state after this read: a completed read clears the failure start; uncertainty is kept only for the same main and fault kind. */
export function nextMainCiState(h: MainCiHealth, prev: MainCiPersisted): MainCiPersisted {
  const readError = h.reasons.length > 0 && h.reasons.every((r) => r.code === "read_error");
  const uncertain = h.state === "unknown" && mainCiSha(h.mainSha) && h.reasons.some((r) => EVIDENCE_FAULTS.includes(r.code)) &&
    h.reasons.every((r) => EVIDENCE_FAULTS.includes(r.code) || r.code === "pending_check");
  const u = prev.uncertainty, sha = h.mainSha?.toLowerCase() ?? "";
  const kept = !!u && u.project === h.target.project && u.repo.toLowerCase() === h.target.repo.toLowerCase() && u.mainSha.toLowerCase() === sha &&
    u.since <= h.observedAt;
  return {
    readFailureSince: readError ? prev.readFailureSince ?? h.observedAt : null,
    uncertainty: uncertain ? kept ? u : { project: h.target.project, repo: h.target.repo, mainSha: sha, since: h.observedAt } : null,
  };
}

export const sameMainCiState = (a: MainCiPersisted, b: MainCiPersisted): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Notification keys already claimed for this project, reloaded from the ledger on every read (never a process cache). */
export function mainCiClaims(db: Database, project: string): string[] {
  return (db.query("SELECT dedupKey FROM events WHERE project = ? AND dedupKey LIKE ? ORDER BY seq DESC LIMIT 500")
    .all(project, `${NOTIFY_PREFIX}%`) as { dedupKey: string }[]).map((r) => r.dedupKey.slice(NOTIFY_PREFIX.length));
}

interface RepairRow { seq: number; actor: string; target: string; data: string; dedupKey: string | null }
/** Active PM repair approvals: the decision events written by `ledger main-ci-repair`, minus the ones a later revoke of that card voids. */
export function mainCiApprovals(db: Database, project: string, repo: string): MainCiPmApproval[] {
  const rows = db.query(`SELECT seq, actor, target, data, dedupKey FROM events WHERE project = ? AND kind = 'decision'
    AND json_extract(data, '$.op') IN (?, ?) ORDER BY seq`).all(project, REPAIR_OP, REVOKE_OP) as RepairRow[];
  const out = new Map<number, MainCiPmApproval & { taskId: string }>();
  for (const row of rows) {
    const d = JSON.parse(row.data) as Record<string, unknown>;
    if (d.op === REVOKE_OP) { for (const [seq, a] of out) if (a.taskId === row.target) out.delete(seq); continue; }
    if (!row.dedupKey?.startsWith(REPAIR_PREFIX) || d.taskId !== row.target || !mainCiSha(d.head) || !mainCiSha(d.mainSha) || typeof d.faultKey !== "string") continue;
    out.set(row.seq, { taskId: row.target, requestId: `${REPAIR_PREFIX}${row.seq}`, actor: row.actor, binding: { kind: "main-ci-repair", project, repo,
      taskId: row.target, head: d.head, mainSha: d.mainSha, faultKey: d.faultKey } });
  }
  return [...out.values()].map(({ taskId: _, ...a }) => a);
}

/** The approvers planMainCi trusts: whoever may configure this project now (PM other than the dispatcher, master, owner). */
export const mainCiPms = (db: Database, project: string, approvals: readonly MainCiPmApproval[]): string[] =>
  [...new Set(approvals.map((a) => a.actor))].filter((a) => actorMayConfigure(db, a, project));

/** One line per reason: failed checks by name, everything else by code. */
export function mainCiReasonText(h: MainCiHealth): string {
  const failed = h.reasons.filter((r) => r.code === "unsuccessful_check").map((r) => `${r.check}=${r.conclusion}`);
  const other = h.reasons.filter((r) => r.code !== "unsuccessful_check" && r.code !== "healthy").map((r) => r.check ? `${r.code}:${r.check}` : r.phase ? `${r.code}:${r.phase}` : r.code);
  return [...failed.length ? [`失败检查 ${failed.join("、")}`] : [], ...other].join("；").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").slice(0, 300) || h.state;
}

export function mainCiNoticeText(t: MainCiTarget, h: MainCiHealth, n: NonNullable<MainCiPlan["notification"]>, mode: "on" | "observe"): string {
  const what = n.kind === "main_red" ? "红了" : n.kind === "read_unavailable" ? "持续读不到（15 分钟以上）" : "检查证据不全（15 分钟以上）";
  const effect = mode === "on" ? "已暂停组车、update-branch、rerun 和合并（PM 绑定的修复卡照常过闸；写单、审查照常）"
    : "观察期（mainCiPause=observe），未暂停，调度照旧";
  return `[主线 CI] 项目 ${t.project}（${t.repo}）main ${h.mainSha?.slice(0, 12) ?? "（未读到）"} ${what}：${mainCiReasonText(h)}。${effect}。` +
    `查看：ledger main-ci status --project ${t.project}；绑定修复卡：ledger main-ci-repair <卡> --head <40 位 head> --main <40 位 main> --reason <原因>` +
    `（撤销：ledger main-ci-repair <卡> --revoke --reason <原因>）。PM 直接推 main 修好也会解除暂停。`;
}
