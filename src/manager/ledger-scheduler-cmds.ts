/** Narrow CLI entrypoints for durable scheduler facts; no arbitrary stage or owner action is exposed here. */
import { INTENT_ACTIONS, INTENT_STATUSES, WORKFLOW_MODES, WORKFLOW_TEMPLATES, AUTHOR_FAMILIES } from "../lib/ledger-scheduler.js";
import { planIntent, setWorkflow, settleIntent } from "../lib/ledger-scheduler-write.js";
import { bindSchedulerSession, recordSessionRetirement, type SessionRole, type SessionTransport } from "../lib/scheduler-sessions.js";
import { LedgerError } from "../lib/ledger-store.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { setWorkerKind } from "../lib/worker-kind.js";

const integer = (c: LedgerCli, flag: string): number => {
  const n = intFlag(c.p, flag);
  if (n === undefined || n < 0) throw new LedgerError("invalid", `要带 --${flag} 非负整数`);
  return n;
};

export const SCHEDULER_CMDS: Record<string, CommandSpec> = {
  "workflow-set": {
    valued: ["rev", "workflow-rev", "template", "version", "mode", "author-family", "fallback", "reason"], bools: [],
    usage: "workflow-set <task> --rev N [--workflow-rev N] --template code|ui|security --version 2 --mode manual|observe|auto --author-family claude|codex --fallback <退路>" +
      " [--reason <auto 退回人工时必填>]",
    run(c) {
      const template = c.need("template"), mode = c.need("mode"), family = c.need("author-family");
      if (!WORKFLOW_TEMPLATES.includes(template as never) || !WORKFLOW_MODES.includes(mode as never) || !AUTHOR_FAMILIES.includes(family as never)) {
        throw new LedgerError("invalid", "模板、模式或模型家族不认识");
      }
      if (mode === "auto" && !c.deps.autoTickWired) {
        throw new LedgerError("forbidden", "调度服务还没接上自动 tick（等 PR D 合入后在服务循环里接线）：现在开 auto 没有东西推它，先用 observe 或 manual");
      }
      const r = setWorkflow(c.db, c.ctx(), {
        taskId: c.p.pos[1] ?? "", taskRev: integer(c, "rev"),
        workflowRev: c.p.flags["workflow-rev"] === undefined ? undefined : integer(c, "workflow-rev"),
        template: template as "code" | "ui" | "security", templateVersion: integer(c, "version"),
        mode: mode as "manual" | "observe" | "auto", authorFamily: family as "claude" | "codex", fallback: c.need("fallback"), reason: c.p.flags.reason,
      });
      return { ok: true, ...r };
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
};
