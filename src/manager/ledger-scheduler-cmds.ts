import { FILE_SCOPE_COMMAND } from "./ledger-resource-scope-cmds.js";
import { poolRemotePolicy } from "../lib/scheduler-agent-pool-context.js";
import { convergenceSpec } from "../lib/fix-strategy-order.js";
import { convergenceCommands } from "../lib/review-arbiter-commands.js";
/** Narrow CLI entrypoints for durable scheduler facts; no arbitrary stage or owner action is exposed here. */
import { INTENT_ACTIONS, INTENT_STATUSES, WORKFLOW_MODES, WORKFLOW_TEMPLATES, AUTHOR_FAMILIES, getIntent } from "../lib/ledger-scheduler.js";
import { settleIntent } from "../lib/ledger-scheduler-settle.js";
import { planIntent, recordPlanRejected, setWorkflow } from "../lib/ledger-scheduler-write.js";
import { resumeAutoWorkflow } from "../lib/ledger-scheduler-resume.js";
import { beginRetire, bindSchedulerSession, recordSessionRetirement, type SessionRole, type SessionTransport } from "../lib/scheduler-sessions.js";
import { advanceMergeRun, beginMergeRun, MERGE_RESOLUTIONS, resolveMergeRun, type MergePhase, type MergeResolution } from "../lib/scheduler-merge.js";
import { getMeta, getTask, LedgerError } from "../lib/ledger-store.js";
import { getDeployRun, resolveDeployRun } from "../lib/scheduler-deploy.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { setWorkerKind } from "../lib/worker-kind.js";
import { schedulerPoolStep, type PoolStepInput } from "../lib/ledger-scheduler-pool.js";
import { writeMaterials } from "../lib/lend-write-materials.js";
import { materialsPolicyPort } from "../lib/recovery-materials-wiring.js";
// macro: same build-time reader location as lend-offer (ledger-lend-cmds.ts)
import { cfgReaderPath } from "../lib/recovery-materials-wiring.js" with { type: "macro" };
import { stepOfStage } from "../lib/lend-git.js";
import { fixRelayCommand } from "../lib/lend-fix-reassign-tick.js";
import { withLeaseHead } from "../lib/lend-fix-reassign-start.js";
import { ghFixStartProbe, withFixStart } from "../lib/lend-fix-start.js";
import { ensureReviewScope } from "../lib/order-deliver-scope.js";
import { poolOrderId, prCoordinates } from "../lib/scheduler-pool-facts.js";
import { isPoolIntent, POOL_RECIPIENT } from "../lib/scheduler-pool-plan.js";
import { writeDeps } from "./ledger-lend-cmds.js";
import { readEffectiveBorrow } from "../lib/scheduler-pool-borrow.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import { parseRemotePolicy, type RemotePolicy } from "../lib/scheduler-config.js";
import { reviewSwapStep } from "../lib/scheduler-review-swap-runtime.js";
import { familyWaitCommand } from "../lib/scheduler-family-pick-notice.js";
import { secReviewAlarmCommand } from "../lib/scheduler-sec-review.js";
import { specPlaceCommand } from "../lib/scheduler-spec-resume-write.js";
import { CONVERGE_NOTICE_CMDS } from "./ledger-converge-notice-cmds.js";

const integer = (c: LedgerCli, flag: string): number => {
  const n = intFlag(c.p, flag);
  if (n === undefined || n < 0) throw new LedgerError("invalid", `要带 --${flag} 非负整数`);
  return n;
};

/** The spec text travels inside the order (the peer cannot read this machine's files); read outside the transaction. */
function specOf(c: LedgerCli, intentId: string): string | null {
  const task = getTask(c.db, getIntent(c.db, intentId)?.taskId ?? "");
  return task ? convergenceSpec(c.db, task, readTextSoft(specPathFor(task, getMeta(c.db, task.project).docsDir))) : null;
}

/**
 * A build / fix pool intent's first step needs the write materials (fingerprint, base head, last report), fetched here
 * outside the transaction; a failed probe becomes the offer's refusal reason (the round moves on), never a stuck intent.
 */
async function poolWrite(c: LedgerCli, intentId: string, remote: RemotePolicy): Promise<PoolStepInput["write"]> {
  const intent = getIntent(c.db, intentId);
  const task = intent && getTask(c.db, intent.taskId);
  if (!intent || !task || intent.action !== "dispatch" || intent.status !== "pending" || !isPoolIntent(intent) || poolOrderId(c.db, intentId)) return null;
  const repo = prCoordinates(task.pr)?.repo ?? remote.repo;
  if (!repo) return { error: "没有仓库坐标（scheduler.json remote.repo）" };
  try {
    const peer = (intent.recipient as string).slice(POOL_RECIPIENT.length), probe = writeDeps(c);
    const startProbe = c.deps.lend ? probe : ghFixStartProbe(probe, c.deps.relayGh);
    // 与 lend-offer 同一份 CFG materials 策略（dispatch-recovery-MATW）：没装 = observe，读坏 = off，诊断进 stderr
    const policy = stepOfStage(task.stage) === "fix" ? (await materialsPolicyPort(c.deps.lend?.recoveryReader ?? cfgReaderPath())).policy : undefined;
    const write = await withLeaseHead(c.db, task, peer, await writeMaterials(c.db, task, { peer, repo, base: "main" }, probe, policy), startProbe);
    return await withFixStart(c.db, task, peer, write, startProbe, c.deps.relayGh);
  } catch (e) {
    if (e instanceof LedgerError) return { error: e.message };
    throw e;
  }
}

export const SCHEDULER_CMDS: Record<string, CommandSpec> = {
  ...convergenceCommands, ...CONVERGE_NOTICE_CMDS, "scheduler-file-scope": FILE_SCOPE_COMMAND,
  "scheduler-review-swap": { valued: ["max-workers"], bools: [], usage: "scheduler-review-swap <intent> --max-workers N",
    run: (c) => reviewSwapStep(c.db, c.ctx(), c.p.pos[1] ?? "", integer(c, "max-workers")) },
  "scheduler-family-wait": familyWaitCommand,
  "scheduler-fix-relay": fixRelayCommand,
  "scheduler-sec-review-alarm": secReviewAlarmCommand,
  "scheduler-spec-place": specPlaceCommand,
  "workflow-set": {
    valued: ["rev", "workflow-rev", "template", "version", "mode", "author-family", "fallback", "reason", "reason-code"], bools: [],
    usage: "workflow-set <task> --rev N [--workflow-rev N] --template code|ui|security --version 2 --mode manual|observe|auto --author-family claude|codex --fallback <退路>" +
      " [--reason <进入 manual 时必填>] [--reason-code <manual 理由码，见 manual-reason.ts>]",
    run(c) {
      const template = c.need("template"), mode = c.need("mode"), family = c.need("author-family");
      if (!WORKFLOW_TEMPLATES.includes(template as never) || !WORKFLOW_MODES.includes(mode as never) || !AUTHOR_FAMILIES.includes(family as never)) {
        throw new LedgerError("invalid", "模板、模式或模型家族不认识");
      }
      if (mode === "auto" && c.deps.autoDispatch?.() !== true) throw new LedgerError("forbidden", "自动派单未开启（scheduler.json autoDispatch），见 T68h");
      const project = getTask(c.db, c.p.pos[1] ?? "")?.project;
      if (mode === "auto" && project && !(c.deps.autoProjects?.() ?? []).includes(project)) {
        throw new LedgerError("forbidden", `调度服务没对项目 ${project} 开（scheduler.json 要 enabled 且列出该项目）：开 auto 没人推它，先用 observe 或 manual`);
      }
      const r = setWorkflow(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", taskRev: integer(c, "rev"),
        workflowRev: c.p.flags["workflow-rev"] === undefined ? undefined : integer(c, "workflow-rev"),
        template: template as "code" | "ui" | "security", templateVersion: integer(c, "version"),
        mode: mode as "manual" | "observe" | "auto", authorFamily: family as "claude" | "codex", fallback: c.need("fallback"), reason: c.p.flags.reason,
        reasonCode: c.p.flags["reason-code"],
      });
      return { ok: true, ...r };
    },
  },
  "workflow-resume": {
    valued: ["rev", "workflow-rev", "reason", "max-workers"], bools: [],
    usage: "workflow-resume <task> --rev N --workflow-rev N --reason <为什么交回>（改规格后把退回人工的 auto 卡交回调度：按当前 specRev 重算并记事件；结果未定的意图要先对账）",
    run(c) {
      const project = c.task(c.p.pos[1]).project;
      if (c.deps.autoDispatch?.() !== true) throw new LedgerError("forbidden", "自动派单未开启（scheduler.json autoDispatch），见 T68h");
      if (!(c.deps.autoProjects?.() ?? []).includes(project)) throw new LedgerError("forbidden", `调度服务没对项目 ${project} 开，交回自动没人推它`);
      return { ok: true, ...resumeAutoWorkflow(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", taskRev: integer(c, "rev"), workflowRev: integer(c, "workflow-rev"), reason: c.need("reason"),
        maxWorkers: intFlag(c.p, "max-workers") ?? 2,
      }) };
    },
  },
  "scheduler-plan": {
    valued: ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"], bools: [],
    usage: "scheduler-plan <task> --id <key> --rev N --workflow-rev N --seq N --node <node> --action <action> --reason <why> [--recipient <agent>] [--resources a,b]",
    run(c) {
      const action = c.need("action");
      if (!INTENT_ACTIONS.includes(action as never)) throw new LedgerError("invalid", "调度动作不认识");
      const r = planIntent(c.db, c.ctx(), {
        id: c.need("id"), taskId: c.p.pos[1] ?? "", taskRev: integer(c, "rev"),
        workflowRev: integer(c, "workflow-rev"), causalSeq: integer(c, "seq"),
        node: c.need("node"), action: action as (typeof INTENT_ACTIONS)[number],
        recipient: c.p.flags.recipient, reason: c.need("reason"),
        resources: c.p.flags.resources?.split(",").map((v) => v.trim()),
      });
      return { ok: true, ...r };
    },
  },
  "scheduler-plan-rejected": {
    valued: ["code", "text"], bools: ["informed"],
    usage: "scheduler-plan-rejected <task> --code <错误码> --text <拒收原因> [--informed]（调度服务专用：按卡 + 原因去重报警；--informed 记通知回执）",
    run(c) {
      return { ok: true, ...recordPlanRejected(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", code: c.need("code"), text: c.need("text"), informed: c.p.bools.has("informed") }) };
    },
  },
  "scheduler-settle": {
    valued: ["from", "to", "receipt"], bools: [],
    usage: "scheduler-settle <intent-key> --from pending|submitted|unknown --to submitted|done|unknown|cancelled [--receipt <evidence>]",
    run(c) {
      const from = c.need("from"), to = c.need("to");
      if (!INTENT_STATUSES.includes(from as never) || !INTENT_STATUSES.includes(to as never)) throw new LedgerError("invalid", "意图状态不认识");
      return { ok: true, intent: settleIntent(c.db, c.ctx(), {
        id: c.p.pos[1] ?? "", from: from as (typeof INTENT_STATUSES)[number], to: to as (typeof INTENT_STATUSES)[number],
        receipt: c.p.flags.receipt,
      }) };
    },
  },
  "scheduler-pool": {
    valued: ["max-workers", "mode", "roles", "timeout-min", "review-first", "local-priority", "repo", "write-families", "fix-reassign-min"], bools: [],
    usage: "scheduler-pool <intent-key> --max-workers N --mode balance|off --roles review|write|review,write|none --timeout-min N [--review-first a,b]" +
      " [--local-priority first|balance|low|off] [--repo owner/name] [--write-families claude,codex]（调度服务专用：挂池 / 同步出借单 / 超时撤回）",
    async run(c) {
      const roles = c.need("roles");
      const minutes = integer(c, "timeout-min");
      if (minutes < 1) throw new LedgerError("invalid", "--timeout-min 至少 1");
      const intent = c.p.pos[1] ?? "", maxWorkers = integer(c, "max-workers");
      if (maxWorkers > 32) throw new LedgerError("invalid", "--max-workers 要在 0–32");
      const reviewFirst = (c.p.flags["review-first"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      // The daemon's policy goes through the config's own parser: the offer re-plans with exactly what scheduler.json says.
      let remote: RemotePolicy;
      try {
        remote = parseRemotePolicy({ mode: c.need("mode"), roles: roles === "none" ? [] : roles.split(","), poolTimeoutMin: minutes,
          ...(reviewFirst.length ? { reviewFirst } : {}), ...(c.p.flags["local-priority"] ? { localPriority: c.p.flags["local-priority"] } : {}),
          ...(c.p.flags["write-families"] !== undefined ? { writeFamilies: c.p.flags["write-families"].split(",") } : {}),
          ...(c.p.flags.repo ? { repo: c.p.flags.repo } : {}), ...(c.p.flags["fix-reassign-min"] ? { fixReassignMin: Number(c.p.flags["fix-reassign-min"]) } : {}) }, "--remote");
      } catch (e) { throw new LedgerError("invalid", `--mode / --roles / --local-priority / --repo 不认识：${(e as Error).message}`); }
      const project = getIntent(c.db, intent)?.project ?? "";
      remote = poolRemotePolicy(project, remote, c.deps.lend?.schedulerPolicy?.(project));
      const borrow = await (c.deps.lend?.borrow() ?? readEffectiveBorrow());
      await ensureReviewScope(c.db, getIntent(c.db, intent)?.taskId); // 规格外文件在挂池事务外先登记（i28-ASK2）
      return { ok: true, ...schedulerPoolStep(c.db, c.ctx(), {
        intentId: intent, maxWorkers, timeoutMs: minutes * 60_000, borrow, remote, spec: specOf(c, intent), write: await poolWrite(c, intent, remote),
      }) };
    },
  },
  "scheduler-session-bind": {
    valued: ["role", "intent", "agent", "session", "family", "transport"], bools: [],
    usage: "scheduler-session-bind <task> --role author|reviewer --intent <key> --agent <name> --session <id> --family claude|codex --transport acp|tmux|peer",
    async run(c) {
      const role = c.need("role"), family = c.need("family"), transport = c.need("transport");
      if (!["author", "reviewer"].includes(role) || !AUTHOR_FAMILIES.includes(family as never) || !["acp", "tmux", "peer"].includes(transport)) {
        throw new LedgerError("invalid", "session 角色、模型家族或 transport 不认识");
      }
      const agent = c.need("agent");
      const bound = bindSchedulerSession(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", role: role as SessionRole, intentId: c.need("intent"), agent,
        sessionId: c.need("session"), family: family as "claude" | "codex", transport: transport as SessionTransport,
        registryPath: c.deps.registryPath,
      });
      if (transport !== "peer") {
        const reg = await c.deps.loadRegistry();
        const priorKind = reg.agents[agent]?.kind;
        if (!setWorkerKind(reg.agents, agent, "worker")) throw new LedgerError("conflict", "本机 session 已绑定但 registry 中无可标记的 worker；重跑绑定以补标");
        if (priorKind !== reg.agents[agent].kind) await c.deps.saveRegistry(reg);
      }
      return { ok: true, ...bound };
    },
  },
  "scheduler-retire": {
    valued: [], bools: [], usage: "scheduler-retire <task>（verified / done / cancelled 卡开退役意图，不看流程模式；见 docs/architecture/scheduler-retire.md）",
    run(c) { return { ok: true, ...beginRetire(c.db, c.ctx(), c.p.pos[1] ?? "") }; },
  },
  "scheduler-session-retire": {
    valued: ["role", "intent", "effect", "receipt"], bools: [],
    usage: "scheduler-session-retire <task> --role author|reviewer --intent <key> --effect archive|kill --receipt <evidence>",
    run(c) {
      const role = c.need("role"), effect = c.need("effect");
      if (!["author", "reviewer"].includes(role) || !["archive", "kill"].includes(effect)) throw new LedgerError("invalid", "session 角色或退役效果不认识");
      return { ok: true, session: recordSessionRetirement(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", role: role as SessionRole, intentId: c.need("intent"),
        effect: effect as "archive" | "kill", receipt: c.need("receipt"),
      }) };
    },
  },
  "scheduler-merge-begin": {
    valued: ["required-checks"], bools: [], usage: "scheduler-merge-begin <intent-key> --required-checks <name,name>",
    run(c) { return { ok: true, ...beginMergeRun(c.db, c.ctx(), c.p.pos[1] ?? "", c.need("required-checks").split(",")) }; },
  },
  "scheduler-merge-step": {
    valued: ["from", "to", "rev", "receipt", "merge-sha", "new-head"], bools: [],
    usage: "scheduler-merge-step <intent-key> --from <phase> --to <phase> --rev N [--receipt <evidence>] [--merge-sha <full SHA>] [--new-head <full SHA>]",
    run(c) { return { ok: true, run: advanceMergeRun(c.db, c.ctx(), {
      intentId: c.p.pos[1] ?? "", from: c.need("from") as MergePhase, to: c.need("to") as MergePhase, rev: integer(c, "rev"),
      receipt: c.p.flags.receipt, mergeSha: c.p.flags["merge-sha"], newHead: c.p.flags["new-head"],
    }) }; },
  },
  "scheduler-merge-resolve": {
    valued: ["outcome", "receipt"], bools: [],
    usage: "scheduler-merge-resolve <intent-key> --outcome done|failed|cancelled --receipt <外部核对证据>（仅 PM / master / owner）",
    run(c) {
      const outcome = c.need("outcome");
      if (!MERGE_RESOLUTIONS.includes(outcome as never)) throw new LedgerError("invalid", "--outcome 只能是 done / failed / cancelled");
      const input = { intentId: c.p.pos[1] ?? "", outcome: outcome as MergeResolution, receipt: c.need("receipt") };
      const deploy = getDeployRun(c.db, input.intentId)?.phase === "unknown"; // merged fine, the deploy after it is what is unknown
      const run = deploy ? resolveDeployRun(c.db, c.ctx(), input) : resolveMergeRun(c.db, c.ctx(), input);
      return { ok: true, run, next: "项目合并队列仍冻结；核对无其他 unknown 后用 ledger unfreeze 解冻" };
    },
  },
};
