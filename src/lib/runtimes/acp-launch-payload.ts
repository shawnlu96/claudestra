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
/**
 * 没被宿主读走的文件（启动被打断、窗口被 kill）留多久：每次写之前清一次。要远长于「命令已送进窗口、宿主还没起来」的最长间隔
 * （shell 初始化慢、窗口排队），否则清掉一个还会被读的文件，宿主就只能拒起（takeLaunchPayload 找不到文件 = 失败）
 */
const STALE_MS = 24 * 3600_000;

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

/** used=false：命令没走文件协议（老命令、单测）；used=true 且 ok=false：走了文件协议但没读成，宿主必须拒起 */
export type LaunchPayloadResult = { used: false } | { used: true; ok: true } | { used: true; ok: false; error: string };

/** 文件内容 → 要放回环境的键值；形状不对、有不认的键、下标越界都算坏文件（不挑能用的那几项凑合） */
function parsePayload(text: string): Record<string, string> | string {
  let file: Partial<PayloadFile>;
  try {
    file = JSON.parse(text) as Partial<PayloadFile>;
  } catch (e) {
    return `不是 JSON：${(e as Error).message}`;
  }
  const values = file?.values;
  if (file?.v !== 1 || !Array.isArray(values) || !values.every((v) => typeof v === "string") || !file.env || typeof file.env !== "object") return "格式不对";
  const out: Record<string, string> = {};
  for (const [k, i] of Object.entries(file.env)) {
    if (!LAUNCH_PAYLOAD_KEYS.includes(k)) return `有不认的变量 ${k}`;
    if (typeof i !== "number" || typeof values[i] !== "string") return `${k} 的下标坏了`;
    out[k] = values[i];
  }
  return out;
}

/**
 * 宿主侧：读走文件、删掉，把值放回 env（只认 LAUNCH_PAYLOAD_KEYS），删掉路径变量。命令带了路径（走文件协议）却读不成——
 * 路径不认、文件没了（被清扫或被删）、读不了、格式坏——一律返回失败，由宿主拒起：前言 / Pi 参数（能力档、工具黑白名单）
 * 都在文件里，缺了照常起就是换成默认能力在跑。各运行时自己的必需项（Pi 的 PI_ARGS）在 agentCommand 里再查。
 */
export function takeLaunchPayload(env: Record<string, string | undefined>, dir = launchDir()): LaunchPayloadResult {
  const path = env[ACP_LAUNCH_FILE_ENV]?.trim();
  delete env[ACP_LAUNCH_FILE_ENV];
  if (!path) return { used: false };
  const fail = (why: string): LaunchPayloadResult => ({ used: true, ok: false, error: `ACP 启动文件 ${path} ${why}，宿主拒起` });
  if (!NAME.test(basename(path)) || resolve(dirname(path)) !== resolve(dir)) return fail(`不在 ${dir} 下或名字不对`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === "ENOENT" ? "不存在（被清掉了或已被读过）" : `读不了：${(e as Error).message}`);
  }
  rmSync(path, { force: true });
  const parsed = parsePayload(text);
  if (typeof parsed === "string") return fail(parsed);
  Object.assign(env, parsed);
  return { used: true, ok: true };
}
