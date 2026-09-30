/**
 * POST /api/v1/agents/:name/pi-update | codex-update —— 网页横幅上的「更新并重启」：更新运行时，成功后重启这个 agent。
 *
 * - 更新是整机的（全局 npm 包）：只重启点按钮的这一个；其余同运行时会话的横幅会翻成「重启生效」，各自点。
 * - 在用户的交互式登录 shell 里跑（`$SHELL -ilc`）：bridge 的 launchd PATH 里没有 nvm 的 node/npm，
 *   而 pi 自更新要找到装它的那个 npm（`npm root -g` 对不上就回「不是全局安装、没法自更新」）。
 *   用户在终端里敲命令的环境就是这个，agent 的 tmux 窗口也是。
 * - 整机同一时刻只跑一个（pi 与 codex 共用一把锁）：两个 `npm install -g` 并发会互相踩坏安装目录。
 * - Codex 只在 npm 全局安装时替人更新（brew 等装法网页只给文字提示）；ChatGPT.app 内置那份（ask_codex 用）不碰。
 * - 重启走 manager restart，按 registry 的 transport 分派：ACP agent 由宿主收尾再起，不往 Codex TUI 发键。
 */
import { agentInScope, type Principal } from "../lib/principals.js";
import { readRegistryAgents } from "../lib/registry.js";
import { piBinName } from "../lib/pi-env.js";
import { shellEscape } from "../lib/claude-launch.js";
import { fetchLatestCodex, probeCodexInstall } from "../lib/codex-version.js";
import { CODEX_ACP_PAIRS, CODEX_ACP_VERSION, codexPairsWithAdapter } from "../lib/acp/install.js";
import { forgetInstalledCodex, forgetInstalledPi } from "../lib/update-hints.js";
import { apiJson, forbidden, isFullScope, notInScope } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";

type RunManager = (...args: string[]) => Promise<any>;
type ShellResult = { ok: boolean; tail: string };
const UPDATE_TIMEOUT_MS = 5 * 60_000;
let runningFor: string | null = null;

export const RUNTIME_UPDATE_PATH = /^\/agents\/([^/]+)\/(pi|codex)-update$/;

type Prepared = { command: string } | { status: number; error: string };
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

/**
 * 装的是**这一刻查到的** latest 且钉死版本号，不写 @latest：查完到装之间 npm 发了新版，也不会装上没核对过配套的那个。
 * 不在 codex-acp 配套范围里就 409（网页此时本来就不给按钮）：升上去 ACP agent 下次起适配器就是错配。
 */
export async function prepareCodexUpdate(
  d: { install: typeof probeCodexInstall; latest: typeof fetchLatestCodex } = { install: probeCodexInstall, latest: fetchLatestCodex },
): Promise<Prepared> {
  const i = await d.install();
  if (!i) return { status: 400, error: "登录 shell 的 PATH 里找不到 codex" };
  if (!i.npm) return { status: 400, error: "Codex 不是 npm 全局安装（brew 等），请用原来的安装方式手动更新" };
  const latest = await d.latest().catch((e) => (console.warn("⚠️ [codex-update] 查 npm latest 失败:", e), undefined));
  if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return { status: 502, error: "查不到 npm 上 @openai/codex 的最新版本，稍后再试" };
  if (!codexPairsWithAdapter(latest)) {
    return { status: 409, error: `npm 上的 Codex ${latest} 不在 codex-acp ${CODEX_ACP_VERSION} 的配套范围（${CODEX_ACP_PAIRS}），等适配器升级后再更新` };
  }
  return { command: `npm install -g @openai/codex@${latest}` };
}

export interface RuntimeUpdateDeps {
  agents: () => Promise<{ name: string; runtime?: string }[]>;
  busy: (canonical: string, name: string) => boolean;
  shell: (cmd: string) => Promise<ShellResult>;
  updaters: Record<"pi" | "codex", Updater>;
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
  if (runningFor) return apiJson(409, { ok: false, error: `正在为 ${runningFor} 更新，稍等再试` });
  runningFor = canonical; // 先占锁再做任何 await：precheck 期间另一个请求也得排在外面
  try {
    const p = await u.prepare();
    if ("error" in p) return apiJson(p.status, { ok: false, error: p.error });
    const r = await deps.shell(p.command);
    u.forget();
    if (!r.ok) return apiJson(500, { ok: false, error: `${u.label} 更新失败：${r.tail || "没有输出"}` });
    const restarted = await runManager("restart", canonical);
    if (!restarted?.ok) {
      return apiJson(500, { ok: false, error: `${u.label} 已更新，但重启失败：${restarted?.error || "未知原因"}（可在管理面板手动重启）`, output: r.tail });
    }
    return apiJson(200, { ok: true, agent: canonical, output: r.tail });
  } finally {
    runningFor = null;
  }
}

async function runInLoginShell(cmd: string): Promise<ShellResult> {
  const proc = Bun.spawn([process.env.SHELL || "/bin/zsh", "-ilc", cmd], {
    cwd: process.env.HOME,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), UPDATE_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  // 去 ANSI 颜色码：NO_COLOR 不一定被每个子进程尊重
  const tail = `${out}\n${err}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
  return { ok: code === 0, tail };
}
