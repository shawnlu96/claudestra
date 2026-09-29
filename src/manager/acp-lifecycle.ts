/**
 * T60 ACP 的 manager 命令（manager.ts 一行分派进来）：
 * - `transport <agent> tmux|acp`：切这个 agent 的 transport（registry 的 transport 字段），然后自动 restart——切回 tmux 就是一键回退。
 *   只有声明了 ACP 段的运行时（目前只有 codex）能切 acp；生产切 acp 前要先装好适配器（沙箱只许 stub）。
 *   不拿命令级写锁（write-commands.ts needsWriteLock）：自己锁住改 registry 那一下，放锁之后再起 restart——restart 要同一把锁，
 *   锁着起就要白等 20s 降级。
 * - `acp-install`：下载并校验 codex-acp（lib/acp/install.ts：版本钉死、sha256 写死，校验不过拒装，不走 npm）。
 * 生命周期本身（create / restart / resume / kill）走 manager 的通用流程，transport=acp 时选 lib/runtimes/codex-acp.ts。
 */
import { ACP_AGENT_ENV } from "../lib/acp/adapter-proc.js";
import { CODEX_ACP_VERSION, codexAcpInstalled, installCodexAcp } from "../lib/acp/install.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { normalizeTransport, transportsOf, type Transport } from "../lib/runtimes/index.js";
import { loadRegistry, output, saveRegistry } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

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
  if (to === "acp" && !env[ACP_AGENT_ENV]?.trim()) {
    const inst = codexAcpInstalled();
    if (!inst.ok) return inst.hint;
  }
  return null;
}

async function switchTransport(name: string, mode: string): Promise<void> {
  if (!name || (mode !== "tmux" && mode !== "acp")) return output({ ok: false, error: "transport <agent> tmux|acp" });
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
    if (from === mode) return output({ ok: true, agent: key, transport: mode, unchanged: true });
    if (mode === "acp") (info as { transport?: string }).transport = "acp";
    else delete (info as { transport?: string }).transport;
    await saveRegistry(reg);
  } finally {
    lock?.release();
  }
  const r = await runManagerProcess(["restart", "--", key], { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS });
  // restart 按 agent 报：整体 ok 但 results 里这一个失败，也算没重启成；原因在 results[].error
  const failed = Array.isArray(r?.results) ? r.results.find((x: { ok?: boolean }) => x?.ok === false) : undefined;
  const ok = r?.ok !== false && !failed;
  output({
    ok,
    agent: key,
    from,
    transport: mode,
    restarted: ok,
    ...(ok ? {} : { error: `registry 已切到 ${mode}，但重启失败：${failed?.error ?? r?.error ?? "未知原因"}（手动 restart ${key}；要回退就 transport ${bare} ${from}）` }),
  });
}
