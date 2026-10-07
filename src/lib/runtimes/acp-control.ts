/** ACP 传输的桥接策略与退出序列（Codex / Pi 的 acp 版共用）；不加载任何运行时的 TUI 生命周期。 */
import type { RuntimeControl, WindowOps } from "./types.js";

/**
 * transport=acp 时的策略（docs/runtimes/codex-acp.md）：bridge 一个键都不往窗口发（窗口输入行是给人用的，lib/acp/tty-input.ts）。
 * - 打断走宿主：bridge 发 abort 帧（与 Pi 扩展同一协议），宿主调 session/cancel；
 * - 人类消息到达时不打断：宿主用 _session/steering 插进当前回合，和 Pi 的 steer 一样即时生效；
 * - 忙闲只信宿主上报（prompt 没返回 = 忙）；模型 / 推理强度经 session/set_config_option 改，不重启；
 * - 斜杠命令当 prompt 文本发（codex-acp 把 /compact 转成 thread/compact/start；pi 的 prompt 只认扩展命令 / 模板 / 技能）。
 */
export const ACP_CONTROL: RuntimeControl = {
  interruptKeys: [],
  preemptOnHumanMessage: false,
  idleSource: "acp",
  modelEnforcement: "config-option",
  paneHeuristics: false,
  abortVia: "extension",
  slashAsPrompt: true,
};

const EXIT_POLL_ROUNDS = 20;

/**
 * 退出：给窗口 shell 的直接子进程（就是宿主）发 SIGTERM，宿主收尾关掉适配器；等窗口里没有子进程 = 回到 shell。
 * 不再靠按 C-c：新宿主的输入行把终端设成 raw，C-c 只是一个键（回合中打断、空闲时连按两次才退，lib/acp/tty-input.ts）。
 * 老宿主收 SIGTERM 和收 C-c 的 SIGINT 走同一个收尾，所以两代宿主都这样收。查不到子进程才退回按 C-c（老宿主认，新宿主连按两次认）。
 * tests/acp-control-exit.test.ts
 */
export async function acpExitPrelude(win: WindowOps, signal: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM")): Promise<"at-shell" | "continue"> {
  const pids = await win.childPids().catch(() => null);
  if (pids === null) await win.sendKey("C-c"), await win.sleep(300), await win.sendKey("C-c");
  for (const pid of pids ?? []) {
    try {
      signal(pid);
    } catch (e) {
      console.error(`[acp] 给宿主 ${pid} 发 SIGTERM 失败（多半已经退了），接着等回 shell：${String(e)}`);
    }
  }
  for (let i = 0; i < EXIT_POLL_ROUNDS; i++) {
    await win.sleep(250);
    if ((await win.childPids().catch(() => [1])).length === 0) return "at-shell"; // 查不到子进程按「还在」算，接着等
  }
  return "continue";
}
