/**
 * POST /api/v1/agents/:name/pi-update —— 网页横幅上的「更新并重启」：跑 `pi update`，成功后重启这个 agent。
 *
 * - `pi update` 是整机的（全局 npm 包）：只重启点按钮的这一个；其余 Pi 会话的横幅会翻成「重启生效」，各自点。
 * - 在用户的交互式登录 shell 里跑（`$SHELL -ilc`）：bridge 的 launchd PATH 里没有 nvm 的 node/npm，
 *   而 pi 自更新要找到装它的那个 npm（`npm root -g` 对不上就回「不是全局安装、没法自更新」）。
 *   用户在终端里敲 `pi update` 的环境就是这个，Pi agent 的 tmux 窗口也是。
 * - 整机同一时刻只跑一个：两个 `npm install -g` 并发会互相踩坏安装目录。
 */
import { agentInScope, type Principal } from "../lib/principals.js";
import { readRegistryAgents } from "../lib/registry.js";
import { piBinName } from "../lib/pi-env.js";
import { shellEscape } from "../lib/claude-launch.js";
import { forgetInstalledPi } from "../lib/update-hints.js";
import { apiJson, forbidden, isFullScope, notInScope } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";

type RunManager = (...args: string[]) => Promise<any>;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
let runningFor: string | null = null;

export const PI_UPDATE_PATH = /^\/agents\/([^/]+)\/pi-update$/;

export async function handlePiUpdate(path: string, principal: Principal, runManager: RunManager): Promise<Response> {
  if (!isFullScope(principal)) return forbidden("pi-update requires a full-scope token");
  const name = decodeURIComponent(path.match(PI_UPDATE_PATH)?.[1] ?? "");
  const canonical = name.startsWith("agent-") ? name : `agent-${name}`;
  if (!agentInScope(principal, canonical)) return notInScope(canonical);
  const reg = (await readRegistryAgents()).find((a) => a.name === canonical);
  if (!reg) return apiJson(404, { ok: false, error: `agent "${canonical}" not found` });
  if (reg.runtime !== "pi") return apiJson(400, { ok: false, error: `agent "${canonical}" 不是 Pi agent` });
  if (isBusyStatus(getAgentStatus(canonical) ?? getAgentStatus(name))) {
    return apiJson(409, { ok: false, error: "agent 正在回合中，等回合结束再更新（更新后要重启它）" });
  }
  if (runningFor) return apiJson(409, { ok: false, error: `正在为 ${runningFor} 更新 Pi，稍等再试` });
  runningFor = canonical;
  try {
    const r = await runPiUpdate();
    forgetInstalledPi();
    if (!r.ok) return apiJson(500, { ok: false, error: `pi update 失败：${r.tail || "没有输出"}` });
    const restarted = await runManager("restart", canonical);
    if (!restarted?.ok) {
      return apiJson(500, { ok: false, error: `Pi 已更新，但重启失败：${restarted?.error || "未知原因"}（可在管理面板手动重启）`, output: r.tail });
    }
    return apiJson(200, { ok: true, agent: canonical, output: r.tail });
  } finally {
    runningFor = null;
  }
}

async function runPiUpdate(): Promise<{ ok: boolean; tail: string }> {
  const proc = Bun.spawn([process.env.SHELL || "/bin/zsh", "-ilc", `${shellEscape(piBinName())} update --self --no-approve`], {
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
