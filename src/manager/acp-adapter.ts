/**
 * `codex-adapter`：Codex 适配器的选择开关（lib/acp/codex-compat-switch.ts）。manager.ts 一行分派进来。
 * - `codex-adapter [status]`：全局、覆盖、每个 Codex agent 选中的和宿主上一次实际起的。
 * - `codex-adapter use self|upstream [--agent <a>] [--no-restart]`：改全局或一个 agent 的覆盖；`clear --agent <a>` 删覆盖。
 * - `codex-adapter rollback`：一条命令切回——全局 upstream、清掉所有覆盖。
 * 改完只重启「实际在跑的适配器 ≠ 新选择」、在跑的（status=active）transport=acp agent，走 restart 接旧线程那条路。
 * 回合中不切：restart 子进程拿到重启锁后先给宿主发 SIGUSR2，宿主在同一段同步代码里判空闲并退出（host.ts retireIfIdle），退了才重起
 * （manager/acp-retire.ts）。先问回合态、或先在锁外让宿主退再 restart，中间新入站 / 另一个 restart 起的宿主都会被掐。
 * 宿主在跑回合、认不出（老宿主不认这个信号，pid 被复用，记录过期）都不重启，列进 deferred：开关已改，它下次重启时生效。
 * 不拿命令级写锁（write-commands.ts）：开关文件有自己的锁，restart 子进程要拿那把锁。tests/codex-adapter-switch.test.ts。
 */
import {
  ADAPTER_IDS, adapterFor, readAdapterChoice, ROLLBACK, updateAdapterChoice, withAgent, type AdapterChoice, type CodexAdapterId,
} from "../lib/acp/codex-compat-switch.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { readCodexRunningHost } from "../lib/codex-version.js";
import { readRegistryAgents } from "../lib/registry.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { DEFER_MARK, RETIRE_ENV } from "./acp-retire.js";
import { output } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

type AgentRow = { name: string; runtime?: string; transport?: string; status?: string };

export interface SwitchDeps {
  agents(): Promise<AgentRow[]>;
  /** 宿主上一次实际起的适配器（codex-version.ts 的运行记录）；没有记录按选中的算 */
  running(agent: string): CodexAdapterId | undefined;
  /** 条件重启：宿主空闲退出了才重起（acp-retire.ts，在 restart 的重启锁里判）；deferred = 没重起的原因 */
  restart(name: string): Promise<{ ok: boolean; error?: string; deferred?: string }>;
  update(change: (c: AdapterChoice) => AdapterChoice): Promise<AdapterChoice>;
  read(): AdapterChoice;
}

const LIVE: SwitchDeps = {
  agents: readRegistryAgents,
  running: (a) => readCodexRunningHost(a).adapter,
  restart: async (name) => {
    const env = { ...process.env, [RETIRE_ENV]: "1" }; // 只在宿主空闲退出后重起，退不了不碰窗口（acp-retire.ts）
    const r = await runManagerProcess(["restart", "--", name], { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS, env });
    const failed = Array.isArray(r?.results) ? r.results.find((x: { ok?: boolean }) => x?.ok === false) : undefined;
    if (r?.ok !== false && !failed) return { ok: true };
    const error: string = failed?.error ?? r?.error ?? "未知原因";
    const at = error.indexOf(DEFER_MARK);
    return at >= 0 ? { ok: false, deferred: error.slice(at + DEFER_MARK.length) } : { ok: false, error };
  },
  update: (change) => updateAdapterChoice(change),
  read: () => readAdapterChoice(),
};

const acpCodex = (a: AgentRow) => a.runtime === "codex" && a.transport === "acp";

export async function adapterStatus(deps: SwitchDeps = LIVE): Promise<Record<string, unknown>> {
  const c = deps.read();
  const agents = (await deps.agents()).filter((a) => a.runtime === "codex").map((a) => ({
    name: a.name, transport: a.transport ?? "tmux", selected: adapterFor(c, a.name), ...(acpCodex(a) ? { running: deps.running(a.name) ?? null } : {}),
  }));
  return { ok: true, default: c.default, overrides: c.agents, agents };
}

/** 改开关，然后让实际在跑的和新选择对不上的 ACP Codex agent 空闲时退出、重启 */
export async function applySwitch(change: (c: AdapterChoice) => AdapterChoice, restart: boolean, deps: SwitchDeps = LIVE): Promise<Record<string, unknown>> {
  const before = deps.read();
  const after = await deps.update(change);
  const acp = (await deps.agents()).filter((a) => acpCodex(a) && a.status !== "stopped");
  const stale = acp.filter((a) => (deps.running(a.name) ?? adapterFor(before, a.name)) !== adapterFor(after, a.name)).map((a) => a.name);
  const base = { ok: true, default: after.default, overrides: after.agents };
  if (!restart) return { ...base, restarted: [], deferred: stale };
  const restarted: string[] = [];
  const deferred: { agent: string; why: string }[] = [];
  const failed: { agent: string; error?: string }[] = [];
  for (const n of stale) {
    const res = await deps.restart(n);
    if (res.ok) restarted.push(n);
    else if (res.deferred) deferred.push({ agent: n, why: res.deferred });
    else failed.push({ agent: n, error: res.error });
  }
  return { ...base, ok: failed.length === 0, restarted, deferred, ...(failed.length ? { failed } : {}) };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdCodexAdapter(args: string[], deps: SwitchDeps = LIVE): Promise<Record<string, unknown>> {
  const [sub = "status", ...rest] = args;
  const restart = !rest.includes("--no-restart");
  const agent = flag(rest, "--agent");
  if (rest.includes("--agent") && !agent) return { ok: false, error: "--agent 后面要跟 agent 名" };
  if (sub === "status") return adapterStatus(deps);
  if (sub === "rollback") return applySwitch(() => ROLLBACK, restart, deps);
  if (sub === "clear") return agent ? applySwitch((c) => withAgent(c, agent, null), restart, deps) : { ok: false, error: "clear 要 --agent <名字>（全局切回用 rollback）" };
  if (sub === "use") {
    const to = rest[0] as CodexAdapterId;
    if (!ADAPTER_IDS.includes(to)) return { ok: false, error: `use 后面是 ${ADAPTER_IDS.join(" 或 ")}（收到 ${rest[0] ?? "空"}）` };
    if (agent && !(await deps.agents()).some((a) => a.name === agent || a.name === `agent-${agent}`)) return { ok: false, error: `agent "${agent}" 不存在` };
    return applySwitch((c) => (agent ? withAgent(c, agent, to) : { ...c, default: to }), restart, deps);
  }
  return { ok: false, error: "codex-adapter [status] | use self|upstream [--agent <名字>] [--no-restart] | clear --agent <名字> | rollback [--no-restart]" };
}

export async function cmdCodexAdapterMain(args: string[]): Promise<void> {
  const r = await cmdCodexAdapter(args).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  output(r);
  if (r.ok === false) process.exitCode = 1;
}
