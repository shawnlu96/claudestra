/**
 * WindowOps 的 tmux 实现 + 运行时感知的打断。
 *
 * 刻意只包 tmux-helper、不改它：tmux-helper 仍是 tmux 命令的唯一出处，这里只是把
 * 「一个窗口」的操作面交给适配器，适配器就能拿假窗口单测。
 */
import { readRegistryAgents } from "../registry.js";
import {
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

/**
 * 按目标运行时的 control.interruptKeys 打断一个 tmux 窗口，返回发出的键。
 * 发键失败会抛出（调用方各自决定是报错还是吞掉）。
 */
export async function interruptWindow(target: string, runtime: string | undefined | null): Promise<readonly string[]> {
  const keys = controlFor(runtime).interruptKeys;
  for (const key of keys) await tmuxRawStrict(["send-keys", "-t", target, key]);
  return keys;
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
