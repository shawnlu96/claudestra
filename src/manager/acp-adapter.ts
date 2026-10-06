/**
 * `codex-adapter`：Codex 适配器的选择开关（lib/acp/codex-compat-switch.ts）。manager.ts 一行分派进来。
 * - `codex-adapter [status]`：全局、覆盖、每个 Codex agent 选中的和宿主上一次实际起的。
 * - `codex-adapter use self|upstream [--agent <a>] [--no-restart]`：改全局或一个 agent 的覆盖；`clear --agent <a>` 删覆盖。
 * - `codex-adapter rollback`：一条命令切回——全局 upstream、清掉所有覆盖。
 * 改完只重启「实际在跑的适配器 ≠ 新选择」、在跑的（status=active）transport=acp agent，走 restart 接旧线程那条路。
 * 回合中不切：先给宿主发 SIGUSR2，宿主在同一段同步代码里判空闲并退出（host.ts retireIfIdle），退了才 restart；
 * 先问回合态再 restart 的话，问完到 restart 掐宿主之间新入站能开出一轮。宿主在跑回合、老宿主（运行记录里没 pid，
 * 不认这个信号——缺省动作是直接退出，不能发）、认不出的都不重启，列进 deferred：开关已改，它下次重启时生效。
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
import { pidAlive } from "../lib/tmux-helper.js";
import { output } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

type AgentRow = { name: string; runtime?: string; transport?: string; status?: string };
/** 让宿主退出的结果：exited = 空闲、已退；absent = 宿主本来就不在（重启无回合可掐）；busy = 回合在跑；unknown = 老宿主 / 认不出 */
export type Retire = "exited" | "absent" | "busy" | "unknown";

export interface SwitchDeps {
  agents(): Promise<AgentRow[]>;
  /** 宿主上一次实际起的适配器（codex-version.ts 的运行记录）；没有记录按选中的算 */
  running(agent: string): CodexAdapterId | undefined;
  /** 让宿主空闲时自己退出（SIGUSR2）；只有 exited / absent 才 restart */
  retire(agent: string): Promise<Retire>;
  restart(name: string): Promise<{ ok: boolean; error?: string }>;
  update(change: (c: AdapterChoice) => AdapterChoice): Promise<AdapterChoice>;
  read(): AdapterChoice;
}

/** 宿主收到 SIGUSR2 后 1.5s 退出（acp-host.ts）；等这么久还活着 = 在跑回合，没退 */
const RETIRE_WAIT_MS = 6_000;

function isAcpHost(pid: number): boolean {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return r.exitCode === 0 && r.stdout.toString().includes("acp-host.ts");
}

export async function retireHost(agent: string, wait = RETIRE_WAIT_MS): Promise<Retire> {
  const pid = readCodexRunningHost(agent).hostPid;
  if (!pid) return "unknown";
  if (!pidAlive(pid) || !isAcpHost(pid)) return "absent"; // 记录里的宿主已经不在了（pid 也可能被别的进程复用）
  process.kill(pid, "SIGUSR2");
  for (const end = Date.now() + wait; Date.now() < end; await Bun.sleep(100)) if (!pidAlive(pid)) return "exited";
  return "busy";
}

const LIVE: SwitchDeps = {
  agents: readRegistryAgents,
  running: (a) => readCodexRunningHost(a).adapter,
  retire: (a) => retireHost(a),
  restart: async (name) => {
    const r = await runManagerProcess(["restart", "--", name], { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS });
    const failed = Array.isArray(r?.results) ? r.results.find((x: { ok?: boolean }) => x?.ok === false) : undefined;
    return r?.ok !== false && !failed ? { ok: true } : { ok: false, error: failed?.error ?? r?.error ?? "未知原因" };
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

const DEFER_WHY: Record<Exclude<Retire, "exited" | "absent">, string> = { busy: "回合在跑", unknown: "宿主不认切换信号（老宿主或没有运行记录），手动 restart 后生效" };

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
    const r = await deps.retire(n);
    if (r === "busy" || r === "unknown") { deferred.push({ agent: n, why: DEFER_WHY[r] }); continue; }
    const res = await deps.restart(n);
    if (res.ok) restarted.push(n);
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
