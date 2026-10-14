/**
 * 主线 CI 暂停（dispatch-recovery-MAINCIW）的 CLI，逻辑在 lib/scheduler-main-ci-wiring*.ts：
 * - `main-ci status --project <p>`：只读，现读一次 main 健康，打印 state / mainSha / 原因 / faultKey / 当前有效的修复绑定；
 * - `main-ci-repair <卡> --head <40 位> --main <40 位> --reason`：项目 PM（调度助理除外）/ master / owner 绑定修复卡（同 workflow-resume 的
 *   actorMayConfigure）；CLI 现读一次 main，main 不是 --main、main 是绿的、或故障不属于 planMainCi 的可修复类都拒；faultKey 由这次读数算出；
 *   `--revoke --reason` 撤销该卡全部绑定。三档开关都能用，off 时绑定不起作用。只读 GitHub，零外部写；
 * - `scheduler-main-ci <project> --op state|claim|observe|lend-slot|take-slot …`：只给调度服务身份，写本轮主线 CI 的持久状态 / 通知领取 / 观察，
 *   以及暂停中 pending 合并意图让出 / 取回项目合并槽（让给 PM 绑定的修复卡）。
 * repo / requiredChecks 只取 scheduler.json 的项目配置。
 */
import { failureResponseAckCommand, failureResponseStatus, recordFailureResponse } from "../lib/ci-main-failure-response-runtime.js";
import { actorMayConfigure } from "../lib/ledger-scheduler-settle.js";
import { LedgerError } from "../lib/ledger-store.js";
import { recordObserved, recoveryPolicy } from "../lib/recovery-policy.js";
import { runBounded } from "../lib/run-bounded.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { projectRepo } from "../lib/scheduler-foreign-repo.js";
import { mainCiSha, type MainCiTarget } from "../lib/scheduler-main-ci.js";
import { mainCiEvidence, mainCiEvidenceKey, mainCiFaultKey, planMainCi, type MainCiPmApproval } from "../lib/scheduler-main-ci-plan.js";
import { readMainCiNow } from "../lib/scheduler-main-ci-wiring-gh.js";
import { MAIN_CI_MAX_AGE_MS, mainCiApprovals, mainCiPms, readMainCiState } from "../lib/scheduler-main-ci-wiring-store.js";
import { claimMainCiNotice, lendMainCiSlot, recordMainCiRepair, revokeMainCiRepair, takeMainCiSlot, writeMainCiState } from "../lib/scheduler-main-ci-wiring-write.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Tests only: the project's target (else scheduler.json), a fake gh command, a clock. */
interface CliPorts { target?: (project: string) => MainCiTarget | null; command?: typeof runBounded; now?: () => number }
let ports: CliPorts = {};
export function setMainCiCliForTest(p: CliPorts | null): void { ports = p ?? {}; }

function targetOf(project: string): { target: MainCiTarget; cwd?: string } {
  if (ports.target) {
    const target = ports.target(project);
    if (!target) throw new LedgerError("not_found", `scheduler.json 里没有项目 ${project}`);
    return { target };
  }
  const policy = readSchedulerConfig().projects[project];
  if (!policy) throw new LedgerError("not_found", `scheduler.json 里没有项目 ${project}`);
  return { target: { project, repo: projectRepo(policy) ?? "", requiredChecks: [...policy.requiredChecks] }, cwd: policy.repoDir };
}

const one = (c: LedgerCli, flag: string, max = 300): string => {
  const v = c.need(flag).trim();
  if (v.length > max || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v)) throw new LedgerError("invalid", `--${flag} 要是不超过 ${max} 字的单行文字`);
  return v;
};
const sha = (c: LedgerCli, flag: string): string => {
  const v = c.need(flag);
  if (!mainCiSha(v)) throw new LedgerError("invalid", `--${flag} 要是 40 位完整 SHA`);
  return v.toLowerCase();
};

/** One fresh read and the plan inputs that go with it; `approvals` / `pms` are swapped in by the caller. */
async function observe(c: LedgerCli, project: string) {
  const { target, cwd } = targetOf(project), now = ports.now ?? (() => c.deps.now());
  const { health, currentMainSha } = await readMainCiNow(target, ports.command ?? runBounded, cwd, now);
  const state = readMainCiState(c.db, project);
  const plan = (candidate: { taskId: string; head: string }, approvals: readonly MainCiPmApproval[], pms: readonly string[]) => planMainCi({
    target, health, currentMainSha, now: now(), maxAgeMs: MAIN_CI_MAX_AGE_MS, readFailureSince: state.readFailureSince, uncertainty: state.uncertainty,
    candidate: { project, repo: target.repo, ...candidate }, projectPms: pms, approvals, notificationClaims: [] });
  return { target, health, currentMainSha, plan };
}

/** Display only (the scheduler reads its own): an unreadable policy is reported and shown as off, as the scheduler pass treats it. */
const MODE = (project: string) => {
  try { return recoveryPolicy(project, "mainCiPause").mode; }
  catch (e) { console.error(`⚠️ [main-ci] ${project} mainCiPause 档位读不到，按 off 显示：${(e as Error).message}`); return "off" as const; }
};
const STATUS_USAGE = "main-ci status --project <p>（只读：现读一次 main 健康，列出 state / mainSha / 原因 / faultKey / 当前有效的修复绑定）";
const REPAIR_USAGE = "main-ci-repair <卡> --head <40 位 head> --main <40 位 main> --reason <原因> | main-ci-repair <卡> --revoke --reason <原因>（项目 PM / master / owner）";
const SERVICE_USAGE = "scheduler-main-ci <project> --op state|claim|observe|lend-slot|take-slot …（调度服务专用）";

export const MAIN_CI_CMDS: Record<string, CommandSpec> = {
  "main-ci": {
    valued: ["project", "key", "deadline", "choice", "task", "head", "reason"],
    usage: STATUS_USAGE,
    async run(c) {
      if (c.p.pos[1] === "ack" && c.p.pos.length === 2) return failureResponseAckCommand(c.db, c.ctx(), c.project(), c.p.flags);
      if (c.p.pos[1] !== "status" || c.p.pos.length !== 2) throw new LedgerError("invalid", STATUS_USAGE);
      const project = c.project(), r = await observe(c, project);
      const approvals = mainCiApprovals(c.db, project, r.target.repo), pms = mainCiPms(c.db, project, approvals);
      // valid = the binding planMainCi would honour right now for the card's current head (main, fault, head and approver all still match)
      const bindings = approvals.map((a) => {
        const head = c.db.query("SELECT headSHA FROM tasks WHERE id = ?").get(a.binding.taskId) as { headSHA: string | null } | null;
        const valid = r.plan({ taskId: a.binding.taskId, head: head?.headSHA ?? "" }, [a], pms).repair?.requestId === a.requestId;
        return { request: a.requestId, actor: a.actor, task: a.binding.taskId, head: a.binding.head, mainSha: a.binding.mainSha, valid };
      });
      const plan = r.plan({ taskId: "", head: "" }, approvals, pms);
      return { ok: true, project, repo: r.target.repo, mode: MODE(project), state: r.health.state, mainSha: r.health.mainSha, currentMainSha: r.currentMainSha,
        response: failureResponseStatus(c.db, project, r.health.mainSha), reasons: r.health.reasons, reason: plan.reason, faultKey: plan.faultKey, paused: plan.actions.merge === "pause", bindings };
    },
  },
  "main-ci-repair": {
    valued: ["head", "main", "reason"], bools: ["revoke"],
    usage: REPAIR_USAGE,
    async run(c) {
      const [, id, ...extra] = c.p.pos;
      if (!id || extra.length) throw new LedgerError("invalid", REPAIR_USAGE);
      const task = c.task(id), actor = c.deps.actor, reason = one(c, "reason");
      if (!actorMayConfigure(c.db, actor, task.project)) throw new LedgerError("forbidden", `主线 CI 修复绑定只有项目 ${task.project} 的 PM / master / owner 能做（你是 ${actor}）`);
      if (c.p.bools.has("revoke")) {
        if (c.p.flags.head !== undefined || c.p.flags.main !== undefined) throw new LedgerError("invalid", REPAIR_USAGE);
        return { ok: true, task: task.id, revoked: revokeMainCiRepair(c.db, c.ctx(), { project: task.project, taskId: task.id, reason }).event.seq };
      }
      const head = sha(c, "head"), main = sha(c, "main");
      if (task.headSHA?.toLowerCase() !== head) throw new LedgerError("conflict", `卡 ${task.id} 当前 head 是 ${task.headSHA ?? "（无）"}，不是 --head`);
      const r = await observe(c, task.project);
      if (r.currentMainSha !== main || r.health.mainSha?.toLowerCase() !== main) {
        throw new LedgerError("conflict", `main 现在是 ${r.currentMainSha ?? "（未读到）"}，不是 --main ${main}`);
      }
      if (r.health.state === "green") throw new LedgerError("conflict", `main ${main.slice(0, 12)} 是绿的，不需要修复绑定`);
      const faultKey = mainCiFaultKey(r.health);
      const probe: MainCiPmApproval = { requestId: "probe", actor, binding: { kind: "main-ci-repair", project: task.project, repo: r.target.repo,
        taskId: task.id, head, mainSha: main, faultKey: faultKey ?? "" } };
      // the plan's own repair rule decides: scope, fresh current read, repairable fault (not a read error / evidence gap alone), exact binding
      if (!faultKey || !r.plan({ taskId: task.id, head }, [probe], [actor]).repair) {
        throw new LedgerError("conflict", `main ${main.slice(0, 12)} 的故障不属于可修复类（${r.health.reasons.map((x) => x.code).join("、")}），不能绑定`);
      }
      const w = recordMainCiRepair(c.db, c.ctx(), { project: task.project, taskId: task.id, head, mainSha: main, faultKey, reason });
      return { ok: true, task: task.id, request: `main-ci-repair:${w.event.seq}`, duplicate: w.duplicate, faultKey, mode: MODE(task.project) };
    },
  },
  "scheduler-main-ci": {
    valued: ["op", "read-failure-since", "uncertainty", "key", "kind", "sha", "state", "reason", "intent", "response", "evidence"],
    usage: SERVICE_USAGE,
    run(c) {
      const [, project, ...extra] = c.p.pos;
      if (!project || extra.length) throw new LedgerError("invalid", SERVICE_USAGE);
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "scheduler-main-ci 只给调度服务身份");
      if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project}`);
      const op = c.need("op"), ctx = c.ctx();
      if (op === "response") return recordFailureResponse(c.db, ctx, project, c.need("response"));
      if (op === "state") {
        const since = c.need("read-failure-since"), raw = c.need("uncertainty");
        if (since !== "none" && !/^\d{1,15}$/.test(since)) throw new LedgerError("invalid", "--read-failure-since 要是毫秒时间或 none");
        let u: Record<string, unknown> | null = null;
        if (raw !== "none") {
          try { u = JSON.parse(raw) as Record<string, unknown>; } catch { throw new LedgerError("invalid", "--uncertainty 不是 JSON"); }
          if (!u || u.project !== project || typeof u.repo !== "string" || !mainCiSha(u.mainSha) || !Number.isSafeInteger(u.since)) {
            throw new LedgerError("invalid", "--uncertainty 要是 {project, repo, mainSha, since}");
          }
        }
        writeMainCiState(c.db, project, { readFailureSince: since === "none" ? null : Number(since),
          uncertainty: u && { project, repo: u.repo as string, mainSha: u.mainSha as string, since: u.since as number } });
        return { ok: true, project };
      }
      if (op === "claim") {
        const s = c.need("sha");
        return { ok: true, project, claimed: claimMainCiNotice(c.db, ctx, project, c.need("key"), one(c, "kind", 40), mainCiSha(s) ? s.toLowerCase() : null) };
      }
      if (op === "observe") {
        const s = c.need("sha"), state = c.need("state");
        if ((s !== "none" && !mainCiSha(s)) || !["red", "unknown", "green"].includes(state)) throw new LedgerError("invalid", "--sha / --state 无效");
        const reason = one(c, "reason", 400), ev = c.p.flags.evidence === undefined ? null : mainCiEvidence(c.p.flags.evidence);
        if (c.p.flags.evidence !== undefined && !ev) throw new LedgerError("invalid", "--evidence 要是 {rule, newReason, runs:[{id, attempt, status, conclusion}]}（runs ≤ 10，≤ 2 KB）");
        const r = recordObserved(c.db, { project, mechanism: "mainCiPause", target: "", actionKey: `main-ci:${s.toLowerCase()}:${state}` +
          (ev ? `:${mainCiEvidenceKey(ev)}` : ""),
          action: `暂停：${reason}`, data: { mainSha: s === "none" ? null : s.toLowerCase(), state, reason, ...ev ? { evidence: ev } : {} } }, ctx.now ?? Date.now());
        return { ok: true, project, recorded: r.recorded };
      }
      if (op === "lend-slot") { lendMainCiSlot(c.db, ctx, project, c.need("intent")); return { ok: true, project }; }
      if (op === "take-slot") return { ok: true, project, slot: takeMainCiSlot(c.db, ctx, project, c.need("intent")) };
      throw new LedgerError("invalid", SERVICE_USAGE);
    },
  },
};
