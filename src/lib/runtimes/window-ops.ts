/**
 * WindowOps 的 tmux 实现 + 运行时感知的打断。
 *
 * 刻意只包 tmux-helper、不改它：tmux-helper 仍是 tmux 命令的唯一出处，这里只是把
 * 「一个窗口」的操作面交给适配器，适配器就能拿假窗口单测。
 */
import { readRegistryAgents } from "../registry.js";
import {
  idleVerdict,
  MASTER_SESSION,
  setWindowOption,
  tmuxCapture,
  tmuxRaw,
  tmuxRawStrict,
  tmuxSendEscape,
  tmuxSendLine,
  windowChildPids,
  windowOption,
  windowTarget,
} from "../tmux-helper.js";
import { codexBusy } from "./codex-exit.js";
import { controlFor } from "./index.js";
import type { WindowOps } from "./types.js";

export function tmuxWindowOps(name: string): WindowOps {
  const target = windowTarget(name);
  return {
    name,
    target,
    capture: (lines = 40) => tmuxCapture(target, lines),
    sendLine: (text) => tmuxSendLine(target, text),
    sendLiteral: async (text) => {
      await tmuxRaw(["send-keys", "-t", target, "-l", "--", text]);
    },
    sendKey: async (key) => {
      await tmuxRaw(["send-keys", "-t", target, key]);
    },
    sendEscape: () => tmuxSendEscape(target),
    getOption: (key) => windowOption(target, key),
    setOption: (key, value) => setWindowOption(target, key, value),
    childPids: () => windowChildPids(target),
    sleep: (ms) => Bun.sleep(ms),
  };
}

/** interruptVia 碰窗口的两个动作（单测注入假窗口） */
export interface InterruptIO {
  capture(lines: number): Promise<string>;
  sendKey(key: string): Promise<void>;
}

/**
 * 按运行时的 control 打断，返回发出的键；**空数组 = 目标空闲、按声明不该打断**（调用方回报
 * 「当前空闲，无需打断」）。interruptOnlyWhenBusy（Codex）：空闲时的 Esc 不是空操作——第一下挂上
 * backtrack、第二下打开回溯遮罩——所以先看状态行确认回合在跑（判据与 codex-exit.ts 的清场同源）。
 * 发键失败会抛出（调用方各自决定是报错还是吞掉）。
 */
export async function interruptVia(io: InterruptIO, runtime: string | undefined | null): Promise<readonly string[]> {
  const control = controlFor(runtime);
  if (control.interruptOnlyWhenBusy) {
    const pane = await io.capture(15).catch(() => ""); // 抓屏失败按空闲算：误按的代价（回溯遮罩）比漏打断一次大
    if (!codexBusy(pane)) return [];
  }
  for (const key of control.interruptKeys) await io.sendKey(key);
  return control.interruptKeys;
}

/** interruptVia 的 tmux 版 */
export async function interruptWindow(target: string, runtime: string | undefined | null): Promise<readonly string[]> {
  return interruptVia(
    {
      capture: (lines) => tmuxCapture(target, lines),
      sendKey: async (key) => {
        await tmuxRawStrict(["send-keys", "-t", target, key]);
      },
    },
    runtime,
  );
}

/**
 * Discord 入站「忙就先打断」，返回是否发了键。只对「人类消息先抢占」且 CC 屏幕判据适用的运行时（CC）：
 * Pi 能 steer 进回合、Codex 的 queue 排到下一轮，本就不该抢占；它们的屏幕套 CC 判据又恒判 busy，
 * 不拦的话每条 Discord 消息都会误发一次打断键（空闲 Codex 收到 Esc 会挂上 backtrack）。
 * 三态判据：unknown（CC 文案可能变了）时宁可不打断。
 */
export async function preemptIfBusy(
  target: string,
  runtime: string | undefined | null,
  verdictOf: (target: string) => Promise<string> = idleVerdict,
  interrupt: (target: string, runtime: string | undefined | null) => Promise<readonly string[]> = interruptWindow,
): Promise<boolean> {
  const control = controlFor(runtime);
  if (!control.preemptOnHumanMessage || !control.paneHeuristics) return false;
  const verdict = await verdictOf(target);
  if (verdict === "unknown") console.warn(`⚠️ ${target} 忙闲判据失效（TUI 文案可能已变），跳过自动打断`);
  if (verdict !== "busy") return false;
  console.log(`⚡ 新消息到达但 ${target} 还在忙，打断`);
  const keys = await interrupt(target, runtime).catch(() => []); // 发键失败 = 没打断成，照常投递，消息不丢
  return keys.length > 0;
}

/**
 * Stop 上报后要不要再看屏幕复核「真的空闲」：只有 idleSource=pane（CC）。hook 驱动的运行时
 * （Pi / Codex）屏幕上没有 ❯，复核恒判「还在工作」，完成 @ 就永远发不出——直接信 Stop。
 */
export function stopNeedsPaneRecheck(runtime: string | undefined | null): boolean {
  return controlFor(runtime).idleSource === "pane";
}

/** 给人看的按键名（"C-c" → "Ctrl+C"），打断回执里用 */
export function describeKeys(keys: readonly string[]): string {
  return keys.map((k) => (k === "C-c" ? "Ctrl+C" : k === "Escape" ? "Esc" : k)).join(" ");
}

/**
 * 打断一个 agent：从 registry 查它的运行时再发对应的键。
 *
 * 大总管（"master" / "0"）不在 registry 的普通条目里，按 Claude Code 处理。
 * 为什么不让各处继续写死 C-c：空闲的 Codex 收到一次 C-c 就退出（实测 0.8s 回到
 * shell），把按键交给适配器声明，新运行时接进来时这些入口不用再挨个改。
 */
export async function interruptAgent(agentName: string): Promise<readonly string[]> {
  const isMaster = agentName === "master" || agentName === "0";
  const target = isMaster ? `${MASTER_SESSION}:0` : windowTarget(agentName);
  const runtime = isMaster
    ? undefined
    : (await readRegistryAgents().catch(() => [])).find((a) => a.name === agentName)?.runtime;
  return interruptWindow(target, runtime);
}
