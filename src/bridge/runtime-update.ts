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
import { currentCodexAcp, installCodexAcp, reconcileCodexAcp } from "../lib/acp/install.js";
import { fetchAcpReleases, pickAdapterFor, rangeAllows } from "../lib/acp/resolve.js";
import { forgetInstalledCodex, forgetInstalledPi, isStableVersion } from "../lib/update-hints.js";
import { apiJson, forbidden, isFullScope, notInScope } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";

type RunManager = (...args: string[]) => Promise<any>;
type ShellResult = { ok: boolean; tail: string };
const UPDATE_TIMEOUT_MS = 5 * 60_000;
let runningFor: string | null = null;

export const RUNTIME_UPDATE_PATH = /^\/agents\/([^/]+)\/(pi|codex)-update$/;

/** afterShell：命令成功后、重启前调（codex 用来切适配器指针） */
type Prepared = { command: string; afterShell?: () => Promise<void> } | { status: number; error: string };
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

const CODEX_DEPS = {
  install: probeCodexInstall,
  latest: fetchLatestCodex,
  adapter: () => currentCodexAcp(),
  releases: () => fetchAcpReleases(),
  installAdapter: (rel: Parameters<typeof installCodexAcp>[0]) => installCodexAcp(rel),
  /** 按磁盘上此刻的 Codex 对账适配器（npm 成功后调；并发的 acp-install 也走它，谁最后对账谁说了算） */
  reconcile: () => reconcileCodexAcp({ codexVersion: async () => (await probeCodexInstall())?.version }),
};

/**
 * 装的是**这一刻查到的** latest 且钉死版本号，不写 @latest：查完到装之间 npm 发了新版，也不会装上没核对过配套的那个。
 * latest 不配当前适配器时，先把能配它的最新适配器装进自己的版本目录（不切指针，装不上就 Codex 也不动）。不论哪个分支，
 * npm 成功后都按磁盘上此刻的 Codex 对账（reconcileCodexAcp，在锁里切指针），对账失败回 500 不重启，成功才重启。对账前有一个很短的错配窗口（旧适配器 + 新 Codex），
 * 这期间别的 ACP agent 恰好重启会撞上，已知且可接受；其余在跑的 ACP agent 不动，下次重启自然用上新指针和新 Codex。
 * npm 上也找不到能配的适配器就 409（网页此时本来就不给按钮）。适配器状态 broken 也 409：不知道现在跑的是哪个，先 acp-install。
 */
export async function prepareCodexUpdate(over: Partial<typeof CODEX_DEPS> = {}): Promise<Prepared> {
  const d = { ...CODEX_DEPS, ...over };
  const i = await d.install();
  if (!i) return { status: 400, error: "登录 shell 的 PATH 里找不到 codex" };
  if (!i.npm) return { status: 400, error: "Codex 不是 npm 全局安装（brew 等），请用原来的安装方式手动更新" };
  const latest = await d.latest().catch((e) => (console.warn("⚠️ [codex-update] 查 npm latest 失败:", e), undefined));
  if (!latest) return { status: 502, error: "查不到 npm 上 @openai/codex 的最新版本，稍后再试" };
  if (!isStableVersion(latest)) return { status: 409, error: `npm 上的 Codex ${latest.slice(0, 40)} 不是正式版，不替你装` };
  const command = `npm install -g @openai/codex@${latest}`;
  // npm 成功后一律按磁盘上的 Codex 对账：快速分支也要，npm 期间并发的 acp-install 可能按旧 Codex 切过指针。
  // 那一刻仍没装任何适配器就不对账（没有 ACP agent 能跑，不替 tmux-only 的机器下载适配器）
  const afterShell = async () => {
    if (d.adapter() === null) return;
    const r = await d.reconcile();
    if (!r.ok) throw new Error(r.error);
  };
  const cur = d.adapter();
  if (cur === "broken") return { status: 409, error: "codex-acp 的版本指针或标记坏了，先跑一次 manager acp-install 再更新 Codex" };
  if (!cur || rangeAllows(cur.codexRange, latest)) return { command, afterShell };
  const rel = pickAdapterFor(await d.releases().catch((e) => (console.warn("⚠️ [codex-update] 查 codex-acp 版本失败:", e), [])), latest);
  if (!rel) return { status: 409, error: `npm 上的 Codex ${latest} 不在 codex-acp ${cur.version} 的配套范围（${cur.codexRange}），等适配器升级后再更新` };
  const got = await d.installAdapter(rel);
  if (!got.ok) return { status: 502, error: `先装配套的 codex-acp ${rel.version} 失败，Codex 没动：${got.error}` };
  return { command, afterShell };
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
    try { await p.afterShell?.(); } catch (e) {
      return apiJson(500, { ok: false, error: `${u.label} 已更新，但切换适配器失败（跑一次 manager acp-install 再重启）：${String(e)}`, output: r.tail });
    }
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
