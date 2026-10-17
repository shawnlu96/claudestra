/**
 * ACP 宿主启动命令里的大段文本（职责前言、developer 指令、Pi 的参数）不进命令行：manager 写进 0600 的一次性文件，命令只带路径，
 * 宿主（src/acp-host.ts）起任何子进程前读走、删掉文件、把值放回自己的环境。命令行要短：tmux 在 zsh 就绪前送进 tty 的字符，
 * macOS 规范模式只收前 1024 字节（MAX_CANON），多的连同回车一起丢，宿主就永远起不来。tests/runtime-launch-length.test.ts。
 */
import { join } from "node:path";
import { acpCallerCredAssignment } from "../caller-cred-launch.js";
import { channelInstructions } from "../channel-instructions.js";
import { shellEscape } from "../claude-launch.js";
import { codexContextPreamble, codexDeveloperInstructions } from "../codex-launch.js";
import { encodePreambleEnv } from "../codex-thread.js";
import { pathOverrideAssignments } from "../paths.js";
import { ACP_LAUNCH_FILE_ENV, settleLaunchPayloads, writeLaunchPayload } from "./acp-launch-file.js";
import type { ReadyResult } from "./types.js";

// 文件的读写、校验与清理在 acp-launch-file.ts
export { ACP_LAUNCH_FILE_ENV, takeLaunchPayload, writeLaunchPayload } from "./acp-launch-file.js";

export interface AcpHostCommandParts {
  /** 命令行上的短变量（值为空的不出现） */
  pairs: [string, string | undefined][];
  /** 进一次性文件的大段文本 */
  payload: [string, string | undefined][];
  /** 写文件的 agent（tmux 名）：启动收尾按它找回这次写的文件（acp-launch-file.ts settleLaunchPayloads） */
  agent: string;
  /** 单测注入（不写真文件） */
  writePayload?: typeof writeLaunchPayload;
  callerCredFile?: string;
  env: Record<string, string | undefined>;
  bunBin: string;
  repoRoot: string;
  /** 出借 worker：env -i 头、bun 的额外参数（codex-acp.ts） */
  head?: string;
  bunArgs?: readonly string[];
}

/** 所有 ACP 宿主的启动命令：短变量前缀 + 一次性文件路径 + 启动凭据路径 + 路径覆盖 + bun acp-host.ts（窗口的 cwd 就是会话的 cwd） */
export function acpHostCommand(p: AcpHostCommandParts): string {
  const file = (p.writePayload ?? writeLaunchPayload)(p.payload, { agent: p.agent });
  const prefix = p.pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${shellEscape(v!)}`).join(" ") + (file ? ` ${ACP_LAUNCH_FILE_ENV}=${shellEscape(file)}` : "");
  const cred = acpCallerCredAssignment(p.callerCredFile, shellEscape); // T85：路径只给宿主这一条命令，宿主起适配器前读走即删
  const bun = [shellEscape(p.bunBin), ...(p.bunArgs ?? [])].join(" ");
  return `${p.head ?? ""}${prefix}${cred}${pathOverrideAssignments(shellEscape, p.env)} ${bun} ${shellEscape(join(p.repoRoot, "src/acp-host.ts"))}`;
}

/**
 * 职责与频道规则（Codex / 通用段同一份）：developer 指令交给适配器；/clear 后的首条、重启 / 收编的首条入站附前言（new 不附）
 */
export function rolePayload(
  who: { agentName: string; purpose?: string; projectContext?: string }, repoRoot: string, mode: string,
): [string, string | undefined][] {
  return [
    ["CLAUDESTRA_ACP_DEVELOPER", encodePreambleEnv(codexDeveloperInstructions({ ...who, channelRules: channelInstructions(repoRoot) }))],
    ["CLAUDESTRA_ACP_CLEAR_PREAMBLE", encodePreambleEnv(codexContextPreamble(who))],
    ["CLAUDESTRA_CODEX_PREAMBLE", mode === "new" ? undefined : encodePreambleEnv(codexContextPreamble(who))],
  ];
}

/** ACP 适配器的 waitReady 包这一层：就绪 / 失败 / 超时 / 抛错都给这次启动写的文件收尾（acp-launch-file.ts settleLaunchPayloads） */
export async function waitReadyAndSettle(win: { name: string }, wait: () => Promise<ReadyResult>): Promise<ReadyResult> {
  let ready = false;
  try {
    const r = await wait();
    ready = r.ready;
    return r;
  } finally {
    await settleLaunchPayloads(win.name, ready);
  }
}
