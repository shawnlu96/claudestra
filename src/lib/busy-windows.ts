import { readRegistryAgents } from "./registry.js";
import { controlFor, normalizeTransport } from "./runtimes/index.js";
import { paneIdleVerdict, paneLooksIdle, tmuxRaw, listAgentWindows, windowTarget } from "./tmux-helper.js";
import { codexBusy } from "./runtimes/codex-exit.js";
import { wallWaitOf } from "./wall-screen.js";
import { bridgeRequest } from "./bridge-client.js";
import { acpTurnGate } from "./acp-turn-gate.js";
import { notify } from "./notify.js";

/** 一个窗口此刻算不算空闲。paneLooksIdle 只认 Claude Code 的画面，套在 Pi / Codex 上恒为「忙」
 *  ⇒ 升级闸门永远等不到全员空闲（tests/busy-windows.test.ts）。hook 运行时改走 paneIdleVerdict
 *  （Pi 有自己的 working 横线判据）：只有明确 busy 才挡，unknown 放行——挡住就是永不升级。 */
export function windowLooksIdle(runtime: string | undefined, pane: string): boolean {
  // 撞墙等待（额度菜单 / 自动续跑倒计时 / Codex 菜单）不算空闲：升级会重启全员，CC 排好的自动续跑跟着丢。80 列窗口把
  // 「esc to cancel」截成「esc to ca…」时 paneLooksIdle 会判空闲，只有这道认得出（tests/busy-windows.test.ts）
  if (wallWaitOf(pane, runtime)) return false;
  if (runtime === "codex") return !codexBusy(pane); // Codex 画面两套判据都认不出、恒判 busy：只看它自己的「esc to interrupt」状态行
  if (controlFor(runtime).idleSource === "hook") return paneIdleVerdict(pane) !== "busy";
  return paneLooksIdle(pane);
}

export interface BusyProbe {
  agents: () => Promise<{ name: string; runtime?: string; transport?: string }[]>;
  windows: () => Promise<string[]>;
  capture: (target: string) => Promise<string>;
  /** 这些 transport=acp 的 agent 里挡住升级的（lib/acp-turn-gate.ts：只有宿主明确答空闲才不挡） */
  acp: (names: string[], key?: string) => Promise<string[]>;
}

const LIVE: BusyProbe = {
  agents: () => readRegistryAgents(),
  windows: listAgentWindows,
  capture: (target) => tmuxRaw(["capture-pane", "-t", target, "-p"]),
  acp: acpTurnGate({
    query: (names) => bridgeRequest({ type: "turn_status", agents: names }, { timeoutMs: 10_000 }),
    notify: (text) => notify({ source: "launcher", chatId: process.env.CONTROL_CHANNEL_ID || "", text }),
    log: (msg) => console.warn(msg),
  }),
};

/**
 * 此刻在忙的窗口名（空数组 = master 与全体 agent 都空闲）。返回名字而非布尔：日志要说清是谁挡住的。
 * transport=acp 的窗口不抓屏（宿主日志；ACP 撞额度是回合失败 + bridge 的卡片，窗口里也没有撞墙倒计时），交给 probe.acp。
 * key = 这次要升到的版本，ACP 回合态一直查不到时按它去重往 #control 报。
 */
export async function busyAgentWindows(masterWindow: string, key?: string, probe: BusyProbe = LIVE): Promise<string[]> {
  const regOf = new Map((await probe.agents()).map((a) => [a.name, a]));
  const busy: string[] = [];
  const acp: string[] = [];
  if (!windowLooksIdle(undefined, await probe.capture(masterWindow))) busy.push("master"); // master 是 CC，同 agent 的判法
  for (const name of await probe.windows()) {
    const reg = regOf.get(name);
    if (controlFor(reg?.runtime, normalizeTransport(reg?.transport)).idleSource === "acp") acp.push(name);
    else if (!windowLooksIdle(reg?.runtime, await probe.capture(windowTarget(name)))) busy.push(name);
  }
  return [...busy, ...(await probe.acp(acp, key))];
}
