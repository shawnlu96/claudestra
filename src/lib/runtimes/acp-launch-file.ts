/**
 * ACP 启动文件的读写与清理（命令行只带路径，大段文本在这里；为什么见 acp-launch-payload.ts 文件头）。
 * - 目录：本机状态目录 run/acp-launch，必须是本人拥有、0700、不是符号链接、真实路径就是它；
 * - 文件：O_EXCL|O_NOFOLLOW 建、0600；宿主读时 O_NOFOLLOW 打开、fstat 核对普通文件 / 本人 / 0600，读完即删；
 * - 清理：写它的进程持有句柄（settleLaunchPayloads：没就绪立刻删、就绪后等宿主读走；进程退出 / 收信号删掉没收尾的）；
 *   兜底 sweepStaleLaunchPayloads（launcher 巡检）：超过 30 分钟且写它的进程已不在才删——写者还活着就归它管，宿主可能还会读。
 * tests/runtime-launch-length.test.ts。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { statePath } from "../paths.js";
import { PI_ARGS_ENV } from "./pi-acp-host.js";

export const ACP_LAUNCH_FILE_ENV = "CLAUDESTRA_ACP_LAUNCH_FILE";

/** 文件里只认这些变量（宿主照单放回环境）：文件内容决定宿主的环境，不能变成任意注入口 */
const KEYS: readonly string[] = ["CLAUDESTRA_ACP_DEVELOPER", "CLAUDESTRA_CODEX_PREAMBLE", "CLAUDESTRA_ACP_CLEAR_PREAMBLE", PI_ARGS_ENV];
const launchDir = () => statePath("run", "acp-launch");
/** writeLaunchPayload 起的文件名；读、删只认长这样的文件（路径来自环境变量，不能让它碰到别的文件） */
const NAME = /^[0-9a-f]{16}\.json$/;
const STALE_MS = 30 * 60_000;
/** 就绪后等宿主读走的上限：宿主第一件事就是读它，等不到就删（之后宿主若才起，读不到即拒起） */
const CONSUME_WAIT_MS = 20_000;

/** 相同的值（OpenCode 新建时两份前言是同一份全文）只存一份；pid / agent 给清理用 */
interface PayloadFile {
  v: 1;
  values: string[];
  env: Record<string, number>;
  pid?: number;
  agent?: string;
}

/** 目录不合格的原因；fix = 写方：不存在就建、权限宽了收紧到 0700（属主、链接、真实路径不对照样拒） */
function dirProblem(dir: string, fix: boolean): string | null {
  if (fix) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return `目录 ${dir} 不可用：${(e as Error).message}`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} 不是普通目录（可能是符号链接）`;
  if (st.uid !== process.getuid?.()) return `目录 ${dir} 不归本人所有`;
  if (st.mode & 0o077) {
    if (!fix) return `目录 ${dir} 权限太宽（${(st.mode & 0o777).toString(8)}）`;
    chmodSync(dir, 0o700);
  }
  return realpathSync(dir) === join(realpathSync(dirname(dir)), basename(dir)) ? null : `目录 ${dir} 的真实路径不是它自己`;
}

/** 本人拥有的 0600 普通文件，不跟随符号链接（O_NOFOLLOW 打开后 fstat 核对，同一个 fd 读） */
function readOwned(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("不是普通文件");
    if (st.uid !== process.getuid?.()) throw new Error("不归本人所有");
    if ((st.mode & 0o777) !== 0o600) throw new Error(`权限不是 0600（${(st.mode & 0o777).toString(8)}）`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// ── 写方的清理句柄 ─────────────────────────────────────────────────────

/** 本进程写了、还没收尾的文件 → agent（settleLaunchPayloads 按 agent 收尾，同一进程里并行起的别的 agent 不碰） */
const pending = new Map<string, string | undefined>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function dropPending(): void {
  for (const p of pending.keys()) rmSync(p, { force: true });
  pending.clear();
}

/** 信号上只删文件、不改退出语义：还有别的监听者交给它；没有 = 本来会被默认动作杀掉，按原信号再杀自己 */
function onSignal(sig: NodeJS.Signals): void {
  dropPending();
  hook(false);
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

function hook(on: boolean): void {
  const f = on ? process.on.bind(process) : process.off.bind(process);
  f("exit", dropPending);
  for (const s of SIGNALS) f(s, onSignal);
}

function forget(path: string): void {
  pending.delete(path);
  if (!pending.size) hook(false);
}

/**
 * 启动收尾（ACP 适配器的 waitReady 包着它）：没就绪 = 失败 / 超时，立刻删；就绪 = 宿主应已读走，最多等 CONSUME_WAIT_MS 再删。
 * 没写过文件的 agent 什么都不做。
 */
export async function settleLaunchPayloads(agent: string, ready: boolean): Promise<void> {
  for (const [path, a] of [...pending]) {
    if (a !== agent) continue;
    for (const end = Date.now() + CONSUME_WAIT_MS; ready && statSync(path, { throwIfNoEntry: false }) && Date.now() < end; ) await Bun.sleep(250);
    rmSync(path, { force: true });
    forget(path);
  }
}

// ── 读写 ───────────────────────────────────────────────────────────────

/** 写一次性文件，返回路径；没有要放的值返回 undefined（命令里也就不带路径）。目录不合格就抛：不往不可信的地方写 */
export function writeLaunchPayload(
  pairs: [string, string | undefined][], o: { agent?: string; dir?: string; now?: number } = {},
): string | undefined {
  const kept = pairs.filter((p): p is [string, string] => !!p[1]);
  if (!kept.length) return undefined;
  const bad = kept.find(([k]) => !KEYS.includes(k));
  if (bad) throw new Error(`ACP 启动文件不收 ${bad[0]}（只收 ${KEYS.join(" / ")}）`);
  const file: PayloadFile = { v: 1, values: [], env: {}, pid: process.pid, agent: o.agent };
  for (const [k, v] of kept) {
    const i = file.values.indexOf(v);
    file.env[k] = i >= 0 ? i : file.values.push(v) - 1;
  }
  const dir = o.dir ?? launchDir();
  const problem = dirProblem(dir, true);
  if (problem) throw new Error(`ACP 启动文件写不了：${problem}`);
  sweepStaleLaunchPayloads(dir, o.now);
  const path = join(dir, `${randomBytes(8).toString("hex")}.json`); // 名字须合 NAME
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify(file));
  } finally {
    closeSync(fd);
  }
  if (!pending.size) hook(true);
  pending.set(path, o.agent);
  return path;
}

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
    if (!KEYS.includes(k)) return `有不认的变量 ${k}`;
    if (typeof i !== "number" || typeof values[i] !== "string") return `${k} 的下标坏了`;
    out[k] = values[i];
  }
  return out;
}

/** used=false：命令没走文件协议（老命令、单测）；used=true 且 ok=false：走了文件协议但没读成，宿主必须拒起 */
export type LaunchPayloadResult = { used: false } | { used: true; ok: true } | { used: true; ok: false; error: string };

/**
 * 宿主侧：读走文件、删掉，把值放回 env，删掉路径变量。命令带了路径（走文件协议）却读不成——路径 / 目录不认、文件没了
 * （被清扫或被删）、不是本人的 0600 普通文件、读不了、格式坏——一律返回失败，由宿主拒起：前言 / Pi 参数（能力档、
 * 工具黑白名单）都在文件里，缺了照常起就是换成默认能力在跑。各运行时自己的必需项（Pi 的 PI_ARGS）在 agentCommand 里再查。
 */
export function takeLaunchPayload(env: Record<string, string | undefined>, dir = launchDir()): LaunchPayloadResult {
  const path = env[ACP_LAUNCH_FILE_ENV]?.trim();
  delete env[ACP_LAUNCH_FILE_ENV];
  if (!path) return { used: false };
  const fail = (why: string): LaunchPayloadResult => ({ used: true, ok: false, error: `ACP 启动文件 ${path} ${why}，宿主拒起` });
  if (!NAME.test(basename(path)) || dirname(path) !== dir) return fail(`不在 ${dir} 下或名字不对`);
  const problem = dirProblem(dir, false);
  if (problem) return fail(problem);
  let text: string;
  try {
    text = readOwned(path);
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === "ENOENT" ? "不存在（被清掉了或已被读过）" : `读不了：${(e as Error).message}`);
  }
  rmSync(path, { force: true });
  const parsed = parsePayload(text);
  if (typeof parsed === "string") return fail(parsed);
  Object.assign(env, parsed);
  return { used: true, ok: true };
}

const alive = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 别人的进程也算活着：不替它删
  }
};

/** 兜底清理（写之前 + launcher 巡检）：超过 STALE_MS 且写它的进程已不在才删；读不出 pid 的坏文件只按年龄 */
export function sweepStaleLaunchPayloads(dir = launchDir(), now = Date.now()): void {
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
      if (now - lstatSync(p).mtimeMs <= STALE_MS) continue;
      let pid: unknown;
      try {
        pid = (JSON.parse(readOwned(p)) as PayloadFile).pid;
      } catch {
        pid = undefined; // 坏文件 / 不是本人的 0600：没有可信的写者，按年龄删
      }
      if (!alive(pid)) rmSync(p, { force: true });
    } catch (e) {
      console.error(`⚠ 清不掉过期的 ACP 启动文件 ${p}：${(e as Error).message}`); // 下一轮巡检再清，不挡启动
    }
  }
}
