/**
 * 订阅额度的 Keychain 读取：spawn /usr/bin/security（不经 shell）读 stdout。
 *
 *   - argv 只有固定参数与服务名，秘密只从 stdout 出来，不进 argv、不进日志。
 *   - 子进程只拿最小环境（HOME / USER / LOGNAME / PATH）：bridge 的环境里有 DISCORD_BOT_TOKEN 等，
 *     不该继承给任何外部程序。security 在这份最小环境下能否找到登录钥匙串**未在真机确认**（T2b-2 接线时测）。
 *   - 超时 5 秒或输出超过上限 → SIGKILL 并 await exited：不能只让 Promise 超时、留下进程和授权框。
 *   - spawn 同步抛错（ENOENT / EMFILE）或读管道出错 → 当作 error，不冒泡；后者同样杀掉并回收进程。
 * 单测 tests/quota-keychain.test.ts（只跑 sleep / printf / yes / env，不碰 security）。
 */

import { homedir, userInfo } from "node:os";
import type { KeychainOutcome } from "./quota-credentials.js";

interface SpawnedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}
export type SpawnFn = (argv: string[]) => SpawnedProc;

/** 给子进程的最小环境：只有定位用户与钥匙串要的几项 */
export function minimalEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  let user = env.USER || env.LOGNAME || "";
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = ""; // 取不到用户名就不传，security 会按当前 uid 找
    }
  }
  const out: Record<string, string> = { HOME: env.HOME || homedir(), PATH: "/usr/bin:/bin" };
  if (user) Object.assign(out, { USER: user, LOGNAME: user });
  return out;
}

const bunSpawn: SpawnFn = (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: minimalEnv() }) as unknown as SpawnedProc;

/**
 * 边读边计数，超过上限立刻 cancel 并返回 null（不把一个异常大的输出整个读进内存）。
 * 订阅额度的 HTTP 正文（quota-providers）也用它。
 */
export async function readStreamCapped(stream: ReadableStream<Uint8Array> | null, capBytes: number, onOverflow?: () => void): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      onOverflow?.();
      await reader.cancel().catch(() => {}); // 这份输出已经不要了，cancel 失败也只是晚点被回收
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Keychain 里的凭据 blob 只有几 KB，超过就当异常 */
const OUTPUT_CAP = 64 * 1024;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runWithTimeout(argv: string[], timeoutMs: number, spawn: SpawnFn = bunSpawn): Promise<RunResult> {
  let proc: SpawnedProc;
  try {
    proc = spawn(argv);
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut: false }; // ENOENT / EMFILE：按 error 判，原文可能带路径与环境，不外传
  }
  let timedOut = false;
  let overflow = false;
  const kill = () => proc.kill("SIGKILL");
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  try {
    const onOverflow = () => {
      overflow = true;
      kill();
    };
    let stdout: string | null;
    let stderr: string | null;
    try {
      [stdout, stderr] = await Promise.all([readStreamCapped(proc.stdout, OUTPUT_CAP, onOverflow), readStreamCapped(proc.stderr, OUTPUT_CAP, onOverflow)]);
    } catch {
      // 读管道出错：进程照样杀掉并回收，不留下进程和授权框；原文不外传
      kill();
      await proc.exited.catch(() => null); // 只为等它退出，退出码已经不重要
      return { code: null, stdout: "", stderr: "", timedOut };
    }
    const code = await proc.exited;
    if (timedOut || overflow || stdout === null || stderr === null) return { code: null, stdout: "", stderr: "", timedOut };
    return { code, stdout, stderr: stderr.slice(0, 512), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 退出码与 stderr 的判定按 `security` 的常见表现写（44 = 找不到条目；锁屏 / 用户点拒绝走 stderr 文案），
 * **launchd 与锁屏环境下未实测**（T2b-1 红线不读真实 Keychain）；认不出的一律 error，调用方长冷却。
 */
export function classifyKeychain(r: RunResult): KeychainOutcome {
  if (r.timedOut) return { status: "timeout" };
  if (r.code === 0 && r.stdout) return { status: "ok", stdout: r.stdout };
  if (r.code === 44 || /could not be found/i.test(r.stderr)) return { status: "missing" };
  if (/interaction is not allowed|user canceled|denied|authoriz/i.test(r.stderr)) return { status: "denied" };
  return { status: "error" };
}

export function spawnKeychainReader(opts: { timeoutMs?: number; spawn?: SpawnFn } = {}): (service: string) => Promise<KeychainOutcome> {
  return async (service) =>
    classifyKeychain(await runWithTimeout(["/usr/bin/security", "find-generic-password", "-s", service, "-w"], opts.timeoutMs ?? 5000, opts.spawn));
}
