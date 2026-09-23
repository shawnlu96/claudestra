import { readRegistryAgents } from "./registry.js";
import { controlFor } from "./runtimes/index.js";
import { paneIdleVerdict, paneLooksIdle, tmuxRaw, listAgentWindows, windowTarget } from "./tmux-helper.js";

/** 一个窗口此刻算不算空闲。paneLooksIdle 只认 Claude Code 的画面，套在 Pi / Codex 上恒为「忙」
 *  ⇒ 升级闸门永远等不到全员空闲（tests/busy-windows.test.ts）。hook 运行时改走 paneIdleVerdict
 *  （Pi 有自己的 working 横线判据）：只有明确 busy 才挡，unknown 放行——挡住就是永不升级。 */
export function windowLooksIdle(runtime: string | undefined, pane: string): boolean {
  if (controlFor(runtime).idleSource === "hook") return paneIdleVerdict(pane) !== "busy";
  return paneLooksIdle(pane);
}

/** 此刻在忙的窗口名（空数组 = master 与全体 agent 都空闲）。返回名字而非布尔：日志要说清是谁挡住的。 */
export async function busyAgentWindows(masterWindow: string): Promise<string[]> {
  const runtimeOf = new Map((await readRegistryAgents()).map((a) => [a.name, a.runtime]));
  const capture = (target: string) => tmuxRaw(["capture-pane", "-t", target, "-p"]);
  const busy: string[] = [];
  if (!paneLooksIdle(await capture(masterWindow))) busy.push("master");
  for (const name of await listAgentWindows()) {
    if (!windowLooksIdle(runtimeOf.get(name), await capture(windowTarget(name)))) busy.push(name);
  }
  return busy;
}
