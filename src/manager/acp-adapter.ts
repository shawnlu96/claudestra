/**
 * `codex-adapter`：Codex 适配器的选择开关（lib/acp/codex-compat-switch.ts）。manager.ts 一行分派进来。
 * - `codex-adapter [status]`：全局、覆盖、每个 Codex agent 选中的和宿主上一次实际起的。
 * - `codex-adapter use self|upstream [--agent <a>] [--no-restart]`：改全局或一个 agent 的覆盖；`clear --agent <a>` 删覆盖。
 * - `codex-adapter rollback`：一条命令切回——全局 upstream、清掉所有覆盖。
 * 改完只重启「实际在跑的适配器 ≠ 新选择」的 transport=acp agent，走 restart 接旧线程那条路；宿主没明确答空闲的
 * （回合在跑、查不到）一律不重启、列进 deferred：开关已改，它下次重启时生效，不在回合中途切。
 * 不拿命令级写锁（write-commands.ts）：开关文件有自己的锁，restart 子进程要拿那把锁。tests/codex-adapter-switch.test.ts。
 */
import { parseTurns } from "../lib/acp-turn-gate.js";
import {
  ADAPTER_IDS, adapterFor, readAdapterChoice, ROLLBACK, updateAdapterChoice, withAgent, type AdapterChoice, type CodexAdapterId,
} from "../lib/acp/codex-compat-switch.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { readCodexRunningAdapter } from "../lib/codex-version.js";
import { readRegistryAgents } from "../lib/registry.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { output } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

type AgentRow = { name: string; runtime?: string; transport?: string };

export interface SwitchDeps {
  agents(): Promise<AgentRow[]>;
  /** 宿主上一次实际起的适配器（codex-version.ts 的运行记录）；没有记录按选中的算 */
  running(agent: string): CodexAdapterId | undefined;
  /** 这些 agent 的回合态：只有 idle 才重启 */
  turns(names: string[]): Promise<Record<string, string>>;
  restart(name: string): Promise<{ ok: boolean; error?: string }>;
  update(change: (c: AdapterChoice) => AdapterChoice): Promise<AdapterChoice>;
  read(): AdapterChoice;
}

const LIVE: SwitchDeps = {
  agents: readRegistryAgents,
  running: (a) => readCodexRunningAdapter(a),
  turns: async (names) => {
    try { return parseTurns(await bridgeRequest({ type: "turn_status", agents: names }, { timeoutMs: 10_000 }), names); }
    catch (e) { console.error(`[codex-adapter] 问不到回合态（${(e as Error).message}），全部按忙、不重启`); return parseTurns(null, names); }
  },
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

/** 改开关，然后重启实际在跑的和新选择对不上、且明确空闲的 ACP Codex agent */
export async function applySwitch(change: (c: AdapterChoice) => AdapterChoice, restart: boolean, deps: SwitchDeps = LIVE): Promise<Record<string, unknown>> {
  const before = deps.read();
  const after = await deps.update(change);
  const acp = (await deps.agents()).filter(acpCodex);
  const stale = acp.filter((a) => (deps.running(a.name) ?? adapterFor(before, a.name)) !== adapterFor(after, a.name)).map((a) => a.name);
  const base = { ok: true, default: after.default, overrides: after.agents };
  if (!restart || !stale.length) return { ...base, restarted: [], deferred: restart ? [] : stale };
  const turns = await deps.turns(stale);
  const idle = stale.filter((n) => turns[n] === "idle");
  const deferred = stale.filter((n) => turns[n] !== "idle").map((n) => ({ agent: n, why: turns[n] === "busy" ? "回合在跑" : "查不到回合态" }));
  const restarted: string[] = [];
  const failed: { agent: string; error?: string }[] = [];
  for (const n of idle) {
    const r = await deps.restart(n);
    if (r.ok) restarted.push(n);
    else failed.push({ agent: n, error: r.error });
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
