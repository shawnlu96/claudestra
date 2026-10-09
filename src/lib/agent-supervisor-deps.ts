/**
 * 监护的生产接线（i28-S1）：名单从 registry、回程簿（pending-agent-calls.json）、押后队列（held-messages.json）读；台账写经调度服务身份的
 * `ledger scheduler-supervise`；重启经 `manager restart --expect`（接回 registry 里的原会话，拿锁后子进程再核前提）；消息经 bridge 的
 * route_to_agent（带 expectSession，会话换了 bridge 拒投）。每个外部效果都套 whileOwned / stillActive：服务停了、丢了租约，排着的动作什么都不做（同 lend-deps.ts）。
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
import { readActivity } from "./agent-supervisor-activity.js";
import { readOverload } from "./agent-supervisor-bridge.js";
import { encodeExpect } from "./agent-supervisor-expect.js";
import { probeSupervised } from "./agent-supervisor-probe.js";
import type { AgentSupervisor, SendResult, SuperviseDeps } from "./agent-supervisor.js";
import { readCallRows, readHeld } from "./agent-supervisor-scope.js";
import { schedulerV2SkipAgent } from "./scheduler-v2-skip.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Active = () => void;

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
    registry: () => readRegistryAgentsSync(env.registryPath).filter((a) => !schedulerV2SkipAgent(db, a.name)), // S2D2: skip cards unsupervised
    calls: () => readCallRows(),
    held: (ch) => (held ??= readHeld())(ch),
    probe: (s) => owned(() => probeSupervised(s)),
    activity: (agent) => readActivity(agent),
    overload: () => readOverload(),
    async record(rec) {
      const r = await owned(() => ledger("ledger", "scheduler-supervise", "--data", JSON.stringify(rec)));
      if (r.code === "lease-lost") throw new SchedulerStopped(`ledger scheduler-supervise: ${String(r.error)}`);
      return { ok: r.ok === true, duplicate: r.duplicate === true, error: r.ok === true ? undefined : String(r.error ?? "") };
    },
    send: (agent, sessionId, text) => route(agent, text, sessionId),
    async restart(agent, expect) {
      // 紧挨着拉起 manager、中间没有 await：会话、在途的活、监护名单按最新的 registry 和台账再核一次；manager 拿到重启锁后按 --expect
      // 再核最后一道（manager/restart-expect.ts），那边核下来不重启回 skipped，与这里同样记 skipped、不占重启额度
      const why = expect.eligible();
      if (why) return { ok: false, skipped: why };
      const wire = encodeExpect({ agent, sessionId: expect.sessionId, down: expect.down, workKey: expect.workKey });
      const r = await plain("restart", "--expect", wire, "--", agent);
      if (r.code === "lease-lost") throw new SchedulerStopped(`manager restart: ${String(r.error)}`);
      return restartOutcome(r, agent);
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

/** manager restart 的输出 → 监护的结果：该目标的条目带 skipped（--expect 复核下来没动窗口）= skipped，不算失败、不占重启额度 */
export function restartOutcome(r: Record<string, unknown>, agent: string): { ok: boolean; error?: string; skipped?: string } {
  const one = (r.results as { name: string; ok: boolean; error?: string; skipped?: unknown }[] | undefined)?.find((x) => x.name === agent);
  if (one && !one.ok && typeof one.skipped === "string") return { ok: false, skipped: one.skipped };
  return one?.ok ? { ok: true } : { ok: false, error: String(one?.error ?? r.error ?? "restart 没有结果") };
}

/** 调度 pass 的一步（scheduler-pass.ts 一行调用）：开关关着时根本不会走到这里 */
export const superviseStep = (supervisor: AgentSupervisor) =>
  async (db: Database, config: SchedulerConfig, active: Active, lease: SchedulerLease | undefined) =>
    supervisor.tick(db, config, superviseDeps({ db, lease, active }));
