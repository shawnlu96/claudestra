import { PM_SWITCH_CMDS } from "./pm-switch.js";
import { SCHEDULER_SERVICE_COMMANDS } from "../lib/shared-ledger-gate-cli-services.js";
import { SHARED_BINDINGS_CMDS } from "./ledger-shared-bindings-cmds.js";
import { SHARED_MIRROR_CMDS } from "./ledger-shared-mirror-cmds.js";
import { START_SETTLE_CMDS } from "./ledger-start-settle-cmds.js";
/**
 * `ledger` 命令族：内置台账的唯一写入口（docs 10-ledger §2）。PM、执行者、大总管、owner 都在终端跑同一条命令，
 * 身份与时间由命令推导（ledger-identity.ts），库是 statePath("ledger.sqlite")（lib/ledger-store.ts，沙箱随状态目录隔离）。
 * 输出一律一行 JSON；失败 {ok:false, code, error, current?}，code 同 LedgerError（conflict 时 current 是库里的实际值）。
 * 子命令表：写在 ledger-write-cmds.ts，读 / 设置在 ledger-read-cmds.ts，导入在 ledger-import.ts。
 */
import { existsSync } from "node:fs";
import { repoEnvVar } from "../lib/env-file.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { notify } from "../lib/notify.js";
import { LEND_WORKER_MARK } from "../lib/runtimes/clean-env.js";
import { LedgerError, LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { renameAgentRefs } from "../lib/ledger-write.js";
import { readProjects } from "../lib/projects.js";
import { readRegistryAgents } from "../lib/registry.js";
import { loadRegistry, output, saveRegistry } from "./core.js";
import { LedgerCli, type LedgerDeps, type Result } from "./ledger-context.js";
import { DEP_CMDS } from "./ledger-dep-cmds.js";
import { DAG_CMDS } from "./ledger-dag-cmds.js";
import { FEATURE_SPLIT_CMDS } from "./ledger-feature-split-cmds.js";
import { FEATURE_CMDS } from "./ledger-feature-cmds.js";
import { FEATURE_MIGRATE_CMDS } from "./ledger-feature-migrate-cmd.js";
import { parseLedgerArgs, resolveActor } from "./ledger-identity.js";
import { AUDIT_CMDS } from "./ledger-audit-cmd.js";
import { importCmd } from "./ledger-import.js";
import { DISPATCH_CMDS } from "./ledger-dispatch-cmds.js";
import { VERIFY_CMD } from "./ledger-verify.js";
import { READ_CMDS } from "./ledger-read-cmds.js";
import { TEAM_CMDS } from "./ledger-team-cmds.js";
import { WRITE_CMDS, type CommandSpec } from "./ledger-write-cmds.js";
import { LEND_CMDS } from "./ledger-lend-cmds.js";
import { PEER_CMDS } from "./ledger-peer.js";
import { LEND_ASK_CMDS } from "./ledger-lend-ask-cmd.js";
import { STEP_CMDS } from "./ledger-step-cmds.js";
import { SCHEDULER_CMDS } from "./ledger-scheduler-cmds.js";
import { SCHEDULER_DEPLOY_CMDS } from "./ledger-scheduler-deploy-cmds.js";
import { SCHEDULER_OBSERVE_CMDS } from "./ledger-scheduler-observe-cmds.js";
import { SCHEDULER_AUTO_CMDS } from "./ledger-scheduler-auto-cmds.js";
import { UI_CMDS } from "./ledger-ui-cmds.js";
import { RESTATE_CMDS } from "./ledger-restate-cmds.js";
import { VERDICT_CMDS } from "./ledger-verdict-cmds.js";
import { ORDER_MARK_CMDS } from "./ledger-order-mark-cmds.js";
import { SUPERVISE_CMDS } from "./ledger-supervise-cmds.js";
import { PEER_PR_CMDS } from "./ledger-peer-pr-cmds.js";
import { AUTOSTART_CMDS } from "./ledger-autostart-cmds.js";
import { SCHEDULER_REMOTE_CMDS } from "./ledger-scheduler-remote-cmds.js";
import { LEND_TAKEOVER_CMDS } from "./ledger-lend-takeover-cmds.js";
import { DRY_RUN_READS, isWriteInvocation } from "./write-commands.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { collectCallerWitness } from "../lib/caller-witness.js";
import { assertSchedulerLease, SchedulerLeaseLost } from "../lib/scheduler-lease-env.js";

/** 认不出身份时读命令用的 actor：不是 registry 键、不在任何 PM 名单里，roleOf 恒为 null */
export const UNKNOWN_ACTOR = "unknown";
const COMMANDS: Record<string, CommandSpec> = {
  ...SHARED_BINDINGS_CMDS, ...SHARED_MIRROR_CMDS, ...PM_SWITCH_CMDS,
  ...WRITE_CMDS,
  ...DISPATCH_CMDS,
  ...TEAM_CMDS,
  ...DEP_CMDS,
  ...FEATURE_CMDS, ...FEATURE_SPLIT_CMDS,
  ...FEATURE_MIGRATE_CMDS,
  ...DAG_CMDS, ...START_SETTLE_CMDS,
  ...READ_CMDS,
  verify: VERIFY_CMD,
  ...AUDIT_CMDS,
  ...PEER_CMDS,
  ...LEND_ASK_CMDS,
  ...LEND_CMDS, ...LEND_TAKEOVER_CMDS,
  ...STEP_CMDS,
  ...SCHEDULER_CMDS,
  ...SCHEDULER_DEPLOY_CMDS,
  ...SCHEDULER_OBSERVE_CMDS,
  ...SCHEDULER_AUTO_CMDS, ...RESTATE_CMDS, ...UI_CMDS,
  ...VERDICT_CMDS,
  ...ORDER_MARK_CMDS, ...SUPERVISE_CMDS, ...PEER_PR_CMDS, ...SCHEDULER_REMOTE_CMDS, ...AUTOSTART_CMDS,
  import: { valued: ["map", "project"], bools: ["dry-run"], usage: "import <ledger.json> --map <map.json> [--project <id>] [--dry-run]（owner 一次性迁移；映射里的 pms 只在 PM 名单为空时写入）", run: importCmd },
};

export function ledgerUsage(): string {
  return ["ledger <子命令>（全部支持 --project <id>；写命令支持 --dedup <key> 幂等）", ...Object.values(COMMANDS).map((s) => `  ledger ${s.usage}`)].join("\n");
}

/** 解析 → 执行 → 结果对象；不打印，测试直接断言返回值 */
export async function runLedger(args: string[], deps: LedgerDeps): Promise<Result> {
  const sub = args[0] ?? "";
  if (deps.actor === "scheduler" && !SCHEDULER_SERVICE_COMMANDS.has(sub)) {
    return { ok: false, code: "forbidden", error: "调度服务身份只能运行调度专用命令" };
  }
  const spec = COMMANDS[sub];
  if (!spec) return { ok: sub === "" || sub === "help", usage: ledgerUsage(), ...(sub && sub !== "help" ? { error: `未知子命令 ${sub}` } : {}) };
  const p = parseLedgerArgs(args, spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error, usage: `ledger ${spec.usage}` };
  try {
    deps.assertLease?.(); // 写锁、registry / projects 这些 await 都过了：台账事务是同步的，核完直接跑
    return await spec.run(new LedgerCli(deps, p));
  } catch (e) {
    if (e instanceof SchedulerLeaseLost) return { ok: false, code: "lease-lost", error: e.message };
    if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message, ...(e.current ? { current: e.current } : {}), usage: `ledger ${spec.usage}` };
    return { ok: false, code: "invalid", error: (e as Error).message, usage: `ledger ${spec.usage}` };
  }
}

/**
 * 真实依赖：registry、projects.json、环境里的频道号 → actor。认不出的频道只许读（actor 记 "unknown"，没有任何角色）；
 * 读写的划分与 manager 的认主守卫同一张表（write-commands.ts），不另列一份。
 */
async function realDeps(args: string[]): Promise<LedgerDeps | { error: string }> {
  const reg = await loadRegistry();
  const service = process.env.CLAUDESTRA_SCHEDULER_SERVICE === "1";
  if (service && (process.env.DISCORD_CHANNEL_ID || process.env[LEND_WORKER_MARK])) return { error: "agent 频道 / 出借 worker 不能冒用调度服务身份" };
  if (service && !SCHEDULER_SERVICE_COMMANDS.has(args[0] ?? "")) {
    return { error: "调度服务身份只能运行调度专用命令" };
  }
  const who = service ? { ok: true as const, actor: "scheduler" }
    : resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, reg.agents);
  if (!who.ok && isWriteInvocation("ledger", args)) return { error: who.error };
  const actor = who.ok ? who.actor : UNKNOWN_ACTOR;
  const projects = await readProjects();
  // audit / feature-migrate 的 --dry-run 只读：不走 openLedger（它会建表 / 迁移，分支代码对线上库跑一次就把版本号抬上去）
  const readInvocation = args[0] === "pm-status" || (DRY_RUN_READS.has(args[0] ?? "") && args.includes("--dry-run"));
  const readOnly = readInvocation ? new LedgerReader().get() : undefined;
  if (readOnly === null) return { error: "台账库还不存在（或正在建），只读命令没东西可看" };
  return {
    db: readOnly ?? openLedger(),
    actor,
    actorProject: reg.agents[actor]?.projectId,
    projectIds: projects.projects.map((x) => x.id),
    projects: () => projects.projects,
    loadRegistry,
    saveRegistry,
    assertLease: assertSchedulerLease,
    now: () => Date.now(),
    callerSession: process.env.CLAUDESTRA_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined,
    callerWitness: collectCallerWitness,
    autoProjects: () => { const s = readSchedulerConfig(); return s.enabled ? Object.keys(s.projects) : []; },
    autoDispatch: () => readSchedulerConfig().autoDispatch,
    notifyOwner: (text) => notify({ source: "ledger", chatId: repoEnvVar("CONTROL_CHANNEL_ID"), text }),
  };
}

export async function cmdLedger(args: string[]): Promise<void> {
  const deps = await realDeps(args);
  if ("error" in deps) return output({ ok: false, code: "forbidden", error: deps.error });
  const r = await runLedger(args, deps);
  output(r);
  if (r.ok === false) process.exitCode = 1;
}

/**
 * manager rename 的钩子：台账里的执行者 / PM / PM 名单跟着改名，否则改名后 roleOf 认不出人。
 * 台账库还没建（没用过台账）就什么都不做，免得 rename 顺手建出空库；同步失败只报 stderr，不让 rename 本身失败（registry 已改完）。
 */
export async function renameLedgerAgent(from: string, to: string, path = LEDGER_PATH): Promise<void> {
  if (!existsSync(path)) return;
  try {
    // 只读 registry（loadRegistry 在文件不存在时会顺手建一个空的）；认不出身份记成 "system"——这是 manager 跟着 rename 做的同步，不冒充 owner
    const agents = Object.fromEntries((await readRegistryAgents()).map((a) => [a.name, { channelId: a.channelId }]));
    const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, agents);
    const r = renameAgentRefs(openLedger(path), { actor: who.ok ? who.actor : "system" }, from, to);
    if (r.tasks.length || r.projects.length) console.error(`台账已同步改名 ${from} → ${to}：任务 ${r.tasks.join(", ") || "无"}；PM 名单 ${r.projects.join(", ") || "无"}`);
  } catch (e) {
    console.error(`⚠️ 台账同步改名失败（${from} → ${to}）：${(e as Error).message}——手动用 ledger task-set --agent / meta --pms 补`);
  }
}
