/**
 * POST /api/v1/agents/:name/pi-update | codex-update —— 网页横幅上的「更新并重启」：更新运行时，成功后重启这个 agent。
 *
 * - 更新是整机的（全局 npm 包）：只重启点按钮的这一个；其余同运行时会话的横幅会翻成「重启生效」，各自点。
 * - 在用户的交互式登录 shell 里跑（`$SHELL -ilc`）：bridge 的 launchd PATH 里没有 nvm 的 node/npm，
 *   而 pi 自更新要找到装它的那个 npm（`npm root -g` 对不上就回「不是全局安装、没法自更新」）。
 *   用户在终端里敲命令的环境就是这个，agent 的 tmux 窗口也是。
 * - 整机同一时刻只跑一个（pi、codex 与 launcher 的 Codex 自动更新共用一把文件锁，lib/codex-auto-update-gate.ts）：
 *   两个 `npm install -g` 并发会互相踩坏安装目录。
 * - Codex 只在 npm 全局安装时替人更新（brew 等装法网页只给文字提示）；ChatGPT.app 内置那份（ask_codex 用）不碰。
 * - 重启走 manager restart，按 registry 的 transport 分派：ACP agent 由宿主收尾再起，不往 Codex TUI 发键。
 */
import { agentInScope, type Principal } from "../lib/principals.js";
import { readRegistryAgents } from "../lib/registry.js";
import { piBinName } from "../lib/pi-env.js";
import { shellEscape } from "../lib/claude-launch.js";
import { prepareCodexUpdate, runInLoginShell, tryUpdateLock, type Prepared, type ShellResult } from "../lib/codex-auto-update-gate.js";
import { forgetInstalledCodex, forgetInstalledPi } from "../lib/update-hints.js";
import { apiJson, forbidden, isFullScope, notInScope } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";

type RunManager = (...args: string[]) => Promise<any>;

export const RUNTIME_UPDATE_PATH = /^\/agents\/([^/]+)\/(pi|codex)-update$/;

interface Updater {
  label: string;
  /** 能替人更新就给出要跑的命令，否则给拒绝的状态码和原因（占着整机锁时调） */
  prepare: () => Promise<Prepared>;
  forget: () => void;
}
const UPDATERS: Record<"pi" | "codex", Updater> = {
  pi: { label: "Pi", prepare: async () => ({ command: `${shellEscape(piBinName())} update --self --no-approve` }), forget: forgetInstalledPi },
  codex: { label: "Codex", prepare: () => prepareCodexUpdate(), forget: forgetInstalledCodex },
};

export interface RuntimeUpdateDeps {
  agents: () => Promise<{ name: string; runtime?: string }[]>;
  busy: (canonical: string, name: string) => boolean;
  shell: (cmd: string) => Promise<ShellResult>;
  updaters: Record<"pi" | "codex", Updater>;
  /** 整机更新锁，缺省 tryUpdateLock（跨进程，与 launcher 的 Codex 自动更新共用） */
  lock?: (label: string) => ReturnType<typeof tryUpdateLock>;
}
const DEFAULT_DEPS: RuntimeUpdateDeps = {
  agents: readRegistryAgents,
  busy: (canonical, name) => isBusyStatus(getAgentStatus(canonical) ?? getAgentStatus(name)),
  shell: runInLoginShell,
  updaters: UPDATERS,
};

export async function handleRuntimeUpdate(
  path: string,
  principal: Principal,
  runManager: RunManager,
  deps: RuntimeUpdateDeps = DEFAULT_DEPS,
): Promise<Response> {
  const m = path.match(RUNTIME_UPDATE_PATH);
  const runtime = m?.[2] === "codex" ? "codex" : "pi";
  const u = deps.updaters[runtime];
  if (!isFullScope(principal)) return forbidden(`${runtime}-update requires a full-scope token`);
  const name = decodeURIComponent(m?.[1] ?? "");
  const canonical = name.startsWith("agent-") ? name : `agent-${name}`;
  if (!agentInScope(principal, canonical)) return notInScope(canonical);
  const reg = (await deps.agents()).find((a) => a.name === canonical);
  if (!reg) return apiJson(404, { ok: false, error: `agent "${canonical}" not found` });
  if (reg.runtime !== runtime) return apiJson(400, { ok: false, error: `agent "${canonical}" 不是 ${u.label} agent` });
  if (deps.busy(canonical, name)) return apiJson(409, { ok: false, error: "agent 正在回合中，等回合结束再更新（更新后要重启它）" });
  const lock = await (deps.lock ?? tryUpdateLock)(canonical); // precheck 也在锁里：期间另一个请求（或自动更新）也得排在外面
  if ("holder" in lock) return apiJson(409, { ok: false, error: `正在为 ${lock.holder} 更新，稍等再试` });
  try {
    const p = await u.prepare();
    if ("error" in p) return apiJson(p.status, { ok: false, error: p.error });
    const r = await deps.shell(p.command);
    u.forget();
    if (!r.ok) return apiJson(500, { ok: false, error: `${u.label} 更新失败：${r.tail || "没有输出"}` });
    try { await p.afterShell?.(); } catch (e) {
      return apiJson(500, { ok: false, error: `${u.label} 已更新，但切换适配器失败（跑一次 manager acp-install 再重启）：${String(e)}`, output: r.tail });
    }
    const restarted = await runManager("restart", canonical);
    if (!restarted?.ok) {
      return apiJson(500, { ok: false, error: `${u.label} 已更新，但重启失败：${restarted?.error || "未知原因"}（可在管理面板手动重启）`, output: r.tail });
    }
    return apiJson(200, { ok: true, agent: canonical, output: r.tail });
  } finally {
    lock.release();
  }
}

export { prepareCodexUpdate };
