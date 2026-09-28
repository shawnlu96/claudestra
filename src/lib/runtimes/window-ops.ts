/**
 * WindowOps 的 tmux 实现 + 运行时感知的打断。
 *
 * 刻意只包 tmux-helper、不改它：tmux-helper 仍是 tmux 命令的唯一出处，这里只是把
 * 「一个窗口」的操作面交给适配器，适配器就能拿假窗口单测。
 */
import {
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

/** target 缺省按名字精确匹配；create 传刚建窗口的 `@id`，窗口一旦被关，后续按键不会落到任何别的窗口 */
export function tmuxWindowOps(name: string, target: string = windowTarget(name)): WindowOps {
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
