/**
 * ACP 宿主启动命令里的大段文本（职责前言、developer 指令、Pi 的参数）不进命令行：manager 写进 0600 的一次性文件，命令只带路径，
 * 宿主（src/acp-host.ts）起任何子进程前读走、删掉文件、把值放回自己的环境。命令行要短：tmux 在 zsh 就绪前送进 tty 的字符，
 * macOS 规范模式只收前 1024 字节（MAX_CANON），多的连同回车一起丢，宿主就永远起不来。tests/runtime-launch-length.test.ts。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acpCallerCredAssignment } from "../caller-cred-launch.js";
import { channelInstructions } from "../channel-instructions.js";
import { shellEscape } from "../claude-launch.js";
import { codexContextPreamble, codexDeveloperInstructions } from "../codex-launch.js";
import { encodePreambleEnv } from "../codex-thread.js";
import { pathOverrideAssignments, statePath } from "../paths.js";
import { PI_ARGS_ENV } from "./pi-acp-host.js";

export const ACP_LAUNCH_FILE_ENV = "CLAUDESTRA_ACP_LAUNCH_FILE";

/** 文件里只认这些变量（宿主照单放回环境）：文件内容决定宿主的环境，不能变成任意注入口 */
const LAUNCH_PAYLOAD_KEYS: readonly string[] = [
  "CLAUDESTRA_ACP_DEVELOPER", "CLAUDESTRA_CODEX_PREAMBLE", "CLAUDESTRA_ACP_CLEAR_PREAMBLE", PI_ARGS_ENV,
];

const launchDir = () => statePath("run", "acp-launch");
/** writeLaunchPayload 起的文件名；takeLaunchPayload 只读、只删长这样的文件（路径来自环境变量，不能让它删到别的文件） */
const NAME = /^[0-9a-f]{16}\.json$/;
/** 没被宿主读走的文件（启动被打断、窗口被 kill）留多久：每次写之前清一次 */
const STALE_MS = 10 * 60_000;

/** 两个变量值相同（OpenCode 新建时两份前言是同一份全文）只存一份：values 去重，env 记下标 */
interface PayloadFile {
  v: 1;
  values: string[];
  env: Record<string, number>;
}

function sweepStale(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠ 读不了 ACP 启动文件目录 ${dir}：${(e as Error).message}`);
    return; // 目录还没建过 = 没有残留
  }
  for (const n of names.filter((x) => NAME.test(x))) {
    const p = join(dir, n);
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { force: true });
    } catch (e) {
      console.error(`⚠ 清不掉过期的 ACP 启动文件 ${p}：${(e as Error).message}`); // 下次写时再清，不挡启动
    }
  }
}

/** 写一次性文件，返回路径；没有要放的值返回 undefined（命令里也就不带路径） */
export function writeLaunchPayload(pairs: [string, string | undefined][], dir = launchDir(), now = Date.now()): string | undefined {
  const kept = pairs.filter((p): p is [string, string] => !!p[1]);
  if (!kept.length) return undefined;
  const bad = kept.find(([k]) => !LAUNCH_PAYLOAD_KEYS.includes(k));
  if (bad) throw new Error(`ACP 启动文件不收 ${bad[0]}（只收 ${LAUNCH_PAYLOAD_KEYS.join(" / ")}）`);
  const file: PayloadFile = { v: 1, values: [], env: {} };
  for (const [k, v] of kept) {
    const i = file.values.indexOf(v);
    file.env[k] = i >= 0 ? i : file.values.push(v) - 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStale(dir, now);
  const path = join(dir, `${randomBytes(8).toString("hex")}.json`); // 名字须合 NAME
  writeFileSync(path, JSON.stringify(file), { mode: 0o600, flag: "wx" });
  return path;
}

export interface AcpHostCommandParts {
  /** 命令行上的短变量（值为空的不出现） */
  pairs: [string, string | undefined][];
  /** 进一次性文件的大段文本 */
  payload: [string, string | undefined][];
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
  const file = (p.writePayload ?? writeLaunchPayload)(p.payload);
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

/**
 * 宿主侧：读走文件、删掉，把值放回 env（只认 LAUNCH_PAYLOAD_KEYS），删掉路径变量。读不了只记一条：
 * 宿主照常起，只是少了前言 / developer 指令（Pi 的参数缺了会在 agentCommand 那里报错拒起）。
 */
export function takeLaunchPayload(env: Record<string, string | undefined>, dir = launchDir()): void {
  const path = env[ACP_LAUNCH_FILE_ENV]?.trim();
  delete env[ACP_LAUNCH_FILE_ENV];
  if (!path) return;
  if (!NAME.test(basename(path)) || resolve(dirname(path)) !== resolve(dir)) {
    console.error(`⚠ 不认的 ACP 启动文件路径（不在 ${dir} 下或名字不对），不读：${path}`);
    return;
  }
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as PayloadFile;
    for (const [k, i] of Object.entries(file.env ?? {})) {
      if (LAUNCH_PAYLOAD_KEYS.includes(k) && typeof file.values?.[i] === "string") env[k] = file.values[i];
    }
  } catch (e) {
    console.error(`⚠ 读不了 ACP 启动文件 ${path}（本次没有前言 / developer 指令）：${(e as Error).message}`);
  } finally {
    rmSync(path, { force: true });
  }
}
