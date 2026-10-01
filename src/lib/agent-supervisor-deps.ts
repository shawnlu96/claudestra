/**
 * 监护的生产接线（i28-S1）：名单从 registry、回程簿（pending-agent-calls.json）、押后队列（held-messages.json）读；台账写经调度服务身份的
 * `ledger scheduler-supervise`；重启经 `manager restart`（接回 registry 里的原会话）；消息经 bridge 的 route_to_agent（带 expectSession，
 * 会话换了 bridge 拒投）。每个外部效果都套 whileOwned / stillActive：服务停了、丢了租约，排着的动作什么都不做（同 lend-deps.ts）。
 * 只在 scheduler.json 开着 supervise 时由调度 pass 调（lib/scheduler-pass.ts）。
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { resolveBunPath } from "./bun-path.js";
import { getTask } from "./ledger-store.js";
import { notify } from "./notify.js";
import { notifyProjectPm } from "./pm-notify.js";
import { readRegistryAgentsSync } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { schedulerManagerWith } from "./scheduler-service.js";
import { MASTER_SESSION, tmuxRawStrict } from "./tmux-helper.js";
import { probeAcpWorker } from "./worker-liveness.js";
import { readActivity } from "./agent-supervisor-activity.js";
import { readOverload } from "./agent-supervisor-bridge.js";
import type { AgentSupervisor, SendResult, SuperviseDeps } from "./agent-supervisor.js";
import { readCallRows, readHeld } from "./agent-supervisor-scope.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Active = () => void;

/** tmux 版 agent 只看窗口在不在；读失败 = 不知道（绝不当成「没了」） */
async function windowLiveness(agent: string): Promise<"running" | "no_window" | "unknown"> {
  try {
    const names = (await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"])).split("\n");
    return names.includes(agent) ? "running" : "no_window";
  } catch {
    return "unknown"; // tmux 读失败：这一轮不知道，监护不判死
  }
}

interface SuperviseEnv {
  db: Database;
  lease: SchedulerLease | undefined;
  active: Active;
  /** 测试注入：默认就是上面的真实读写 */
  registryPath?: string;
}

function superviseDeps(env: SuperviseEnv): SuperviseDeps {
  const { db, lease, active } = env;
  const alive = () => { try { active(); return true; } catch { return false; /* 核不过 = 不能证明还在当班：什么帧都不发 */ } };
  const ledger = schedulerManagerWith(lease);
  const owned = <T>(f: () => Promise<T>) => whileOwned(active, f);
  // 重启不用调度服务身份（那个身份只许跑台账的调度命令），同 scheduler-auto-deps 的 plainManager：也带服务租约
  const plain: Manager = (...args) => owned(() => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
    env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 240_000 }));
  const route = async (target: string, text: string, expectSession?: string): Promise<SendResult> => {
    const r = await owned(() => bridgeSend({ type: "route_to_agent", targetName: target, text, fromName: "scheduler", oneShot: true,
      ...(expectSession ? { expectSession } : {}) }, { timeoutMs: 30_000, stillActive: alive }));
    return r.ok ? { ok: true } : { ok: false, delivered: r.sent ? "unknown" : false, reason: String(r.error ?? "") };
  };
  let held: ReturnType<typeof readHeld> | null = null;
  return {
    registry: () => readRegistryAgentsSync(env.registryPath),
    calls: () => readCallRows(),
    held: (ch) => (held ??= readHeld())(ch),
    probe: (s) => owned(() => (s.transport === "acp" ? probeAcpWorker(s.agent) : windowLiveness(s.agent))),
    activity: (agent) => readActivity(agent),
    overload: () => readOverload(),
    async record(rec) {
      const r = await owned(() => ledger("ledger", "scheduler-supervise", "--data", JSON.stringify(rec)));
      if (r.code === "lease-lost") throw new SchedulerStopped(`ledger scheduler-supervise: ${String(r.error)}`);
      return { ok: r.ok === true, duplicate: r.duplicate === true, error: r.ok === true ? undefined : String(r.error ?? "") };
    },
    send: (agent, sessionId, text) => route(agent, text, sessionId),
    async restart(agent) {
      const r = await plain("restart", agent);
      if (r.code === "lease-lost") throw new SchedulerStopped(`manager restart: ${String(r.error)}`);
      const one = (r.results as { name: string; ok: boolean; error?: string }[] | undefined)?.find((x) => x.name === agent);
      return one?.ok ? { ok: true } : { ok: false, error: String(one?.error ?? r.error ?? "restart 没有结果") };
    },
    async escalate(taskId, intentId, reason) {
      const r = await owned(() => ledger("ledger", "scheduler-fallback-manual", taskId, "--reason", reason.slice(0, 560), "--intent", intentId));
      if (r.code === "lease-lost") throw new SchedulerStopped(`ledger scheduler-fallback-manual: ${String(r.error)}`);
      if (r.ok !== true) throw new Error(`退回人工失败：${String(r.error)}`);
      const project = getTask(db, taskId)?.project;
      if (r.duplicate !== true && project) {
        await owned(() => notifyProjectPm(db, project, `[调度引擎] ${taskId} 退回人工，请接手：${reason}`, { fromName: "scheduler", stillActive: alive }));
      }
    },
    async notifyCaller(caller, text) {
      const r = await route(caller, text);
      if (!r.ok) throw new Error(`告诉 ${caller} 失败：${r.reason}`);
    },
    async notifyOwner(channelId, text) {
      await owned(() => notify({ source: "supervisor", chatId: channelId, text }));
    },
    now: () => Date.now(),
    log: (m) => console.log(`[supervise] ${m}`),
  };
}

/** 调度 pass 的一步（scheduler-pass.ts 一行调用）：开关关着时根本不会走到这里 */
export const superviseStep = (supervisor: AgentSupervisor) =>
  async (db: Database, config: SchedulerConfig, active: Active, lease: SchedulerLease | undefined) =>
    supervisor.tick(db, config, superviseDeps({ db, lease, active }));
