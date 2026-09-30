/**
 * T60 ACP 的 manager 命令（manager.ts 一行分派进来）：
 * - `transport <agent> tmux|acp`：切这个 agent 的 transport（registry 的 transport 字段），然后自动 restart——切回 tmux 就是一键回退。
 *   只有声明了 ACP 段的运行时（目前只有 codex）能切 acp；生产切 acp 前要先装好适配器（沙箱只许 stub）。
 *   不拿命令级写锁（write-commands.ts needsWriteLock）：自己锁住改 registry 那一下，放锁之后再起 restart——restart 要同一把锁，
 *   锁着起就要白等 20s 降级。
 * - `acp-install`：下载并校验 codex-acp（lib/acp/install.ts：版本钉死、sha256 写死，校验不过拒装，不走 npm）。
 * 生命周期本身（create / restart / resume / kill）走 manager 的通用流程，transport=acp 时选 lib/runtimes/codex-acp.ts。
 */
import { CODEX_ACP_VERSION, codexAcpInstalled, installCodexAcp } from "../lib/acp/install.js";
import { checkAcpReady } from "../lib/acp/readiness.js";
import { ACP_AGENT_ENV } from "../lib/acp/stub.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { isSandbox } from "../lib/sandbox.js";
import { managedFor, normalizeTransport, requireManaged, transportsOf, type LaunchSpec, type ManagedRuntimeAdapter, type ReadyResult, type Transport } from "../lib/runtimes/index.js";
import { gracefulExitWindow } from "../lib/runtimes/graceful-exit.js";
import { tmuxWindowOps } from "../lib/runtimes/window-ops.js";
import { killPidsEscalating, listWindowIdsByName, MASTER_SESSION, sessionTarget, tmuxRaw, tmuxRawStrict, windowChildPids } from "../lib/tmux-helper.js";
import { assertCreatable, loadRegistry, output, patchRegistryAgent, saveRegistry } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

/** 新建 / resume 的 Codex 缺省 ACP；前置条件不齐时给明确原因并沿用可工作的 tmux。 */
export async function chooseCreateTransport(runtime?: string, requested?: string): Promise<{ transport: Transport; acpPending?: true; manualTmux?: true }> {
  if (runtime !== "codex") return { transport: "tmux" };
  if (requested === "tmux") return { transport: "tmux", manualTmux: true };
  const ready = await checkAcpReady(true);
  if (ready.ok) return { transport: "acp" };
  console.error(`[acp] ${ready.reason}；本次 Codex agent 回退 tmux，doctor 会报告`);
  return { transport: "tmux", acpPending: true };
}

/** resume 同名旧记录时沿用人工 tmux；暂退 tmux 的记录可在条件恢复后接回 ACP。 */
export function chooseResumeTransport(runtime: string | undefined, prior: unknown) {
  const old = prior as { transport?: string; acpPending?: boolean } | undefined;
  return chooseCreateTransport(runtime, old?.transport === "tmux" && !old.acpPending ? "tmux" : undefined);
}

export async function prepareCreateRuntime(name: string, dir: string, runtime?: string, requested?: string): Promise<
  { ok: true; dir: string; adapter: ManagedRuntimeAdapter; acpPending?: true; manualTmux?: true } | { ok: false; error: string }
> {
  const chosen = await chooseCreateTransport(runtime, requested);
  const resolved = assertCreatable(name, dir, runtime, chosen.transport);
  try { return { ok: true, dir: resolved, adapter: requireManaged(runtime, chosen.transport), acpPending: chosen.acpPending, manualTmux: chosen.manualTmux }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

/**
 * ACP 收编：宿主必须有自称，而 resume 历来不注入 agentName、收编成新名字时 registry 里也没有 settingsName——不补就在
 * buildAcpHostCommand 抛错。fork 先拿新线程 id，再以 resume 模式起常驻宿主；失败不能把源 id 误记进 registry。
 */
export async function prepareAcpResume(spec: LaunchSpec, adapter: ManagedRuntimeAdapter, transport: Transport, name: string): Promise<LaunchSpec> {
  if (transport !== "acp") return spec;
  const named = { ...spec, agentName: spec.agentName ?? name };
  if (named.mode !== "fork") return named;
  if (!adapter.prepareSession) throw new Error("ACP 适配器没有 fork 准备方法");
  const { sessionId } = await adapter.prepareSession(named);
  if (!adapter.isValidSessionId(sessionId) || sessionId === named.sessionId) throw new Error("ACP fork 没返回新的合法 sessionId");
  return { ...named, mode: "resume", sessionId };
}

/** 已记 acp 的 agent 若升级后丢了适配器或 CLI 太旧，restart 仍可从同一线程走 tmux。 */
export async function managedForRestart(name: string, info: { runtime?: string; transport?: string }): Promise<ManagedRuntimeAdapter | null> {
  if (info.runtime === "codex" && info.transport !== "acp" && isSandbox()) return null;
  if (info.runtime === "codex" && info.transport === "acp") {
    const ready = await checkAcpReady(true);
    if (!ready.ok) {
      console.error(`[acp] ${name} 暂退 tmux：${ready.reason}`);
      info.transport = "tmux";
      (info as { acpRestartFrom?: string }).acpRestartFrom = "acp";
      await patchRegistryAgent(name, (a) => {
        const state = a as { transport?: string; acpPending?: boolean; acpRestartPending?: boolean; acpRestartFrom?: string };
        if (state.transport === "acp") { state.transport = "tmux"; state.acpPending = true; state.acpRestartPending = true; state.acpRestartFrom = "acp"; }
      });
    }
  }
  return managedFor(info.runtime, info.transport);
}

export async function markTransportReady(name: string, transport?: string): Promise<void> {
  await patchRegistryAgent(name, (a) => {
    const state = a as { transport?: string; acpRestartPending?: boolean; acpRestartFrom?: string };
    if (state.transport === transport) { delete state.acpRestartPending; delete state.acpRestartFrom; }
  });
}

/** 适配器能启动但接旧线程失败时，普通 restart 也恢复旧 TUI；迁移和手动 restart 用同一条保守路径。 */
export async function recoverFailedAcpLaunch(
  name: string, info: { runtime?: string; transport?: string; cwd?: string }, adapter: ManagedRuntimeAdapter, started: ReadyResult,
  launch: (a: ManagedRuntimeAdapter) => Promise<ReadyResult>,
  deps: { exit?: () => Promise<boolean>; patch?: typeof patchRegistryAgent } = {},
): Promise<{ adapter: ManagedRuntimeAdapter; started: ReadyResult }> {
  if (started.ready && info.runtime === "codex") await markTransportReady(name, info.transport);
  if (started.ready || info.runtime !== "codex" || info.transport !== "acp") return { adapter, started };
  if (isSandbox()) return { adapter, started }; // 沙箱不得把 stub 启动失败回退成真实 Codex TUI
  console.error(`[acp] ${name} 接线程失败（${started.reason}）：尝试恢复 tmux`);
  const acp = managedFor("codex", "acp")!;
  const exited = await (deps.exit ?? (() => gracefulExitWindow(tmuxWindowOps(name), acp)))().catch((e) => (console.error(`[acp] 宿主退出失败：${String(e)}`), false));
  if (!exited) {
    const ids = await listWindowIdsByName(name);
    for (const id of ids) {
      const kids = await windowChildPids(id).catch(() => [] as number[]);
      const survivors = await killPidsEscalating(kids);
      if (survivors.length) throw new Error(`${name} 的 ACP 宿主无法停下（pid=${survivors.join(",")}），拒绝在同频道再起一份`);
      await tmuxRaw(["kill-window", "-t", id]);
    }
    if ((await listWindowIdsByName(name)).length) throw new Error(`${name} 的旧 ACP window 仍在，拒绝创建重名窗口`);
    await tmuxRawStrict(["new-window", "-t", sessionTarget(MASTER_SESSION), "-n", name, "-c", info.cwd || process.env.HOME || "/"]);
  }
  const patch = deps.patch ?? patchRegistryAgent;
  await patch(name, (a) => {
    const state = a as { transport?: string; acpPending?: boolean; acpRestartPending?: boolean; acpRestartFrom?: string };
    if (state.transport === "acp") { state.transport = "tmux"; state.acpPending = true; state.acpRestartPending = true; state.acpRestartFrom = "acp"; }
  });
  info.transport = "tmux";
  const fallback = managedFor("codex", "tmux")!;
  const result = await launch(fallback);
  if (result.ready) await patch(name, (a) => {
    const state = a as { transport?: string; acpRestartPending?: boolean; acpRestartFrom?: string };
    if (state.transport === "tmux") { delete state.acpRestartPending; delete state.acpRestartFrom; }
  });
  return { adapter: fallback, started: result };
}

export async function cmdAcp(cmd: string, args: string[]): Promise<void> {
  if (cmd === "acp-install") {
    const r = await installCodexAcp();
    return output(r.ok ? { ok: true, version: CODEX_ACP_VERSION, path: r.path, reused: r.reused } : { ok: false, error: r.error });
  }
  return switchTransport(args[0] ?? "", args[1] ?? "");
}

/** 改 registry 前的检查：拒绝就返回原因 */
export function transportRefusal(info: { runtime?: string } | undefined, bare: string, to: Transport, env: Record<string, string | undefined> = process.env): string | null {
  if (bare === "master") return "大总管不切 transport";
  if (!info) return `agent "${bare}" 不存在`;
  const runtime = info.runtime || "claude-code";
  if (!transportsOf(runtime).includes(to)) return `runtime "${runtime}" 不支持 transport=${to}（目前只有 codex 能走 acp）`;
  if (runtime === "codex" && to === "tmux" && isSandbox(env)) return "沙箱 Codex 只许 ACP stub，不起真实 TUI";
  if (to === "acp" && isSandbox(env) && env[ACP_AGENT_ENV]?.trim()) return "沙箱里不认 CLAUDESTRA_ACP_AGENT：acp 固定起本仓 stub";
  if (to === "acp" && !isSandbox(env) && !env[ACP_AGENT_ENV]?.trim()) { // 沙箱里适配器固定是本仓 stub，不用装
    const inst = codexAcpInstalled();
    if (!inst.ok) return inst.hint;
  }
  return null;
}

/** 旧 registry 缺 transport 时，owner 明确选择 tmux 也必须落盘，迁移不能再把它改回 ACP。 */
export function persistManualTmux(info: { transport?: string; acpPending?: boolean; acpRestartPending?: boolean; acpRestartFrom?: string }): boolean {
  const changed = info.transport !== "tmux" || info.acpPending === true || info.acpRestartPending === true || !!info.acpRestartFrom;
  if (!changed) return false;
  info.transport = "tmux";
  delete info.acpPending;
  delete info.acpRestartPending;
  delete info.acpRestartFrom;
  return true;
}

async function switchTransport(name: string, mode: string): Promise<void> {
  if (!name || (mode !== "tmux" && mode !== "acp")) return output({ ok: false, error: "transport <agent> tmux|acp" });
  if (mode === "acp") {
    const ready = await checkAcpReady(true);
    if (!ready.ok) return output({ ok: false, error: ready.reason });
  }
  const bare = name.replace(/^agent-/, "");
  const lock = await acquireLock(statePath(".manager-write.lock"));
  let key = "";
  let from: Transport = "tmux";
  try {
    const reg = await loadRegistry();
    key = reg.agents[`agent-${bare}`] ? `agent-${bare}` : reg.agents[bare] ? bare : "";
    const info = key ? reg.agents[key] : undefined;
    const refusal = transportRefusal(info as { runtime?: string } | undefined, bare, mode);
    if (refusal) return output({ ok: false, error: refusal });
    from = normalizeTransport((info as { transport?: string }).transport);
    if (from === mode) {
      if (mode === "tmux" && persistManualTmux(info as { transport?: string })) await saveRegistry(reg);
      return output({ ok: true, agent: key, transport: mode, unchanged: true });
    }
    (info as { transport?: string; acpPending?: boolean; acpRestartPending?: boolean; acpRestartFrom?: string }).transport = mode;
    (info as { acpRestartPending?: boolean; acpRestartFrom?: string }).acpRestartPending = true;
    (info as { acpRestartFrom?: string }).acpRestartFrom = from;
    delete (info as { acpPending?: boolean }).acpPending;
    await saveRegistry(reg);
  } finally {
    lock?.release();
  }
  const r = await runManagerProcess(["restart", "--", key], { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS });
  // restart 按 agent 报：整体 ok 但 results 里这一个失败，也算没重启成；原因在 results[].error
  const failed = Array.isArray(r?.results) ? r.results.find((x: { ok?: boolean }) => x?.ok === false) : undefined;
  const restarted = r?.ok !== false && !failed;
  let actual: string | undefined;
  if (restarted) await patchRegistryAgent(key, (a) => {
    const state = a as { transport?: string; acpRestartPending?: boolean; acpRestartFrom?: string };
    actual = state.transport;
    if (actual === mode) { delete state.acpRestartPending; delete state.acpRestartFrom; }
  });
  const ok = restarted && actual === mode;
  output({
    ok,
    agent: key,
    from,
    transport: actual ?? mode,
    restarted,
    ...(restarted && actual !== mode ? { fellBack: true, error: `${mode} 启动失败，已恢复 ${actual ?? "原 transport"}；运行 doctor 查看待迁移状态` } : {}),
    ...(!restarted ? { error: `registry 已切到 ${mode}，但重启失败：${failed?.error ?? r?.error ?? "未知原因"}（手动 restart ${key}；要回退就 transport ${bare} ${from}）` } : {}),
  });
}
