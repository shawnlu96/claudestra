/**
 * 部署锁的 argv wrapper(scripts/pm-deploy-lock.ts 的逻辑):拿整机部署锁 → 起执行闸(独立进程组组长)→ 闸身份 / 进程组落进锁记录 →
 * 放行闸以 argv 起部署命令(不经 shell)→ 原样传播退出码 / 信号 → 等整个进程组(含孙进程)退完 → 释放。
 * 等锁有界;超时、被信号打断、取锁 / 身份出错都不放行(零部署),也不碰持有者。持锁期间收到的信号整组转发。
 * 命令退出后进程组在 --drain-sec 内没退完:不释放,锁按进程组算活,组空后由下一份按死亡接管(不在后台无限等)。
 */
import { closeSync, writeSync } from "node:fs";
import { constants } from "node:os";
import {
  acquireDeployLock, DEPLOY_LOCK_TOKEN_ENV, deployLockPath, describeHolder, holderLiveness, readDeployLock, realProbe, reentrantHolder,
  type DeployLockHandle,
} from "./pm-deploy-lock.js";
import { GATE_SCRIPT } from "./pm-deploy-lock-gate.js";

export const EXIT = { usage: 64, lockError: 70, timeout: 75, spawnFailed: 127 } as const;
const DEFAULT_WAIT_SEC = 600;
const MAX_WAIT_SEC = 3600;
const DEFAULT_DRAIN_SEC = 30;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const USAGE = `用法:
  pm-deploy-lock run --label <label> [--wait-sec N] [--drain-sec N] -- <命令> [参数...]
      拿整机部署锁后以 argv 执行(等锁默认 ${DEFAULT_WAIT_SEC}s,上限 ${MAX_WAIT_SEC}s);命令退出后最多等 drain(默认 ${DEFAULT_DRAIN_SEC}s)
      让同组下级进程退完再释放,没退完则锁留给进程组、组空后可接管
  pm-deploy-lock status                                                   打印当前持有者诊断(JSON)
退出码:命令自身退出码 / 128+信号;${EXIT.timeout}=等锁超时(未执行);${EXIT.lockError}=取锁或身份错误(未执行);${EXIT.usage}=用法错误`;

interface RunArgs { label: string; waitSec: number; drainSec: number; argv: string[] }
const secOk = (v: string) => /^\d+(\.\d+)?$/.test(v) && +v <= MAX_WAIT_SEC;

function parseRunArgs(args: string[]): RunArgs | string {
  const sep = args.indexOf("--");
  if (sep < 0 || sep === args.length - 1) return "缺少 `-- <命令> [参数...]`";
  const opts = args.slice(0, sep);
  let label = "";
  let waitSec = DEFAULT_WAIT_SEC;
  let drainSec = DEFAULT_DRAIN_SEC;
  for (let i = 0; i < opts.length; i += 2) {
    const [k, v] = [opts[i], opts[i + 1]];
    if (v === undefined) return `参数 ${k} 缺值`;
    if (k === "--label") label = v;
    else if (k === "--wait-sec" && secOk(v)) waitSec = +v;
    else if (k === "--drain-sec" && secOk(v)) drainSec = +v;
    else return `不认识或不合法的参数:${k} ${v}`;
  }
  if (!label) return "缺少 --label";
  return { label, waitSec, drainSec, argv: args.slice(sep + 1) };
}

const log = (s: string) => process.stderr.write(`[pm-deploy-lock] ${s}\n`);

function signalExit(sig: string): number {
  return 128 + ((constants.signals as Record<string, number>)[sig] ?? 0);
}

const childEnv = (token: string) => ({ ...process.env, [DEPLOY_LOCK_TOKEN_ENV]: token });
const childExit = (child: { signalCode: string | null }, code: number) => (child.signalCode ? signalExit(child.signalCode) : code);

/** 受控重入:外层已持锁,内层命令直接起在外层的进程组里(外层整组转发信号、等整组退完) */
async function runNested(argv: string[], token: string): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: childEnv(token) });
  } catch (e) {
    log(`起命令失败:${(e as Error).message}`);
    return EXIT.spawnFailed;
  }
  const fwd = SIGNALS.map((s) => [s, () => child.kill(s)] as const);
  fwd.forEach(([s, f]) => process.on(s, f));
  try {
    return childExit(child, await child.exited);
  } finally {
    fwd.forEach(([s, f]) => process.off(s, f));
  }
}

async function drainGroup(pgid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const s = realProbe.groupSignal0(pgid);
    if (s === "dead") return true;
    if (s === "unknown" || Date.now() >= end) return false;
    await Bun.sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
}

/**
 * 持锁执行:闸先起(独立进程组、阻塞在 fd 3)→ 身份 + 组号落盘 → 写放行字节。落盘前任何失败 / 收到信号:关 fd(闸读到 EOF 不执行)、
 * 杀掉这个组,返回 fail-closed。放行后整组转发信号,命令退出后等组退完;返回 keep=true 表示组没退完、锁要留给进程组。
 */
async function runGated(argv: string[], handle: DeployLockHandle, drainMs: number, pending: string[]): Promise<{ code: number; keep: boolean }> {
  let gate: ReturnType<typeof Bun.spawn>;
  try {
    gate = Bun.spawn([process.execPath, GATE_SCRIPT, ...argv], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: childEnv(handle.record.token),
      detached: true, // 新进程组,组长 = 闸
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (e) {
    log(`起执行闸失败(未执行):${(e as Error).message}`);
    return { code: EXIT.lockError, keep: false };
  }
  const pgid = gate.pid;
  const gateFd = (gate as unknown as { stdio: unknown[] }).stdio[3];
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pgid, sig);
    } catch {}
  };
  const closeGate = () => {
    try {
      if (typeof gateFd === "number") closeSync(gateFd);
    } catch {}
  };
  const abort = async (msg: string, code: number) => {
    log(`${msg}(未执行)`);
    closeGate();
    killGroup("SIGKILL");
    await gate.exited;
    return { code, keep: false };
  };
  if (typeof gateFd !== "number") return abort("执行闸控制管道不可用", EXIT.lockError);
  try {
    handle.recordChild(pgid, { group: true });
  } catch (e) {
    return abort(`部署子进程身份 / 进程组没能落进锁记录:${(e as Error).message}`, EXIT.lockError);
  }
  if (pending.length) return abort(`放行前收到 ${pending[0]},放弃`, signalExit(pending[0]!));

  const fwd = SIGNALS.map((s) => [s, () => killGroup(s)] as const);
  fwd.forEach(([s, f]) => process.on(s, f));
  try {
    try {
      writeSync(gateFd, "1");
    } catch (e) {
      log(`放行执行闸失败:${(e as Error).message}`); // 闸已退出:它没读到放行,不会执行
    }
    closeGate();
    const code = childExit(gate, await gate.exited);
    if (await drainGroup(pgid, drainMs)) return { code, keep: false };
    log(`部署命令已退出但进程组 ${pgid} 里仍有进程:不释放锁,组内进程全部退出后下一份可接管(诊断:pm-deploy-lock status)`);
    return { code, keep: true };
  } finally {
    fwd.forEach(([s, f]) => process.off(s, f));
  }
}

/** run 子命令;返回进程退出码 */
export async function runLocked(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (typeof parsed === "string") return log(`${parsed}\n${USAGE}`), EXIT.usage;
  const outer = reentrantHolder(process.env[DEPLOY_LOCK_TOKEN_ENV]);
  if (outer) {
    log(`受控重入:外层 ${outer.label}(pid ${outer.holder.pid})持锁,${parsed.label} 在同一次部署内执行`);
    return runNested(parsed.argv, outer.token);
  }
  const pending: string[] = [];
  const onSig = SIGNALS.map((s) => [s, () => pending.push(s)] as const);
  onSig.forEach(([s, f]) => process.on(s, f));
  let handle: DeployLockHandle | null = null;
  let keep = false;
  try {
    const r = await acquireDeployLock({
      label: parsed.label,
      waitMs: parsed.waitSec * 1000,
      aborted: () => pending.length > 0,
      onWait: (h, st) => log(`部署锁被占用,最多等 ${parsed.waitSec}s:${describeHolder(h, st)}`),
    });
    if (r.kind === "aborted") return log(`等锁时收到 ${pending[0]},放弃(未执行)`), signalExit(pending[0]!);
    if (r.kind === "error") return log(`${r.message}(未执行)`), EXIT.lockError;
    if (r.kind === "timeout") return log(`等锁超时(未执行,未动持有者):${describeHolder(r.holder, r.state)}`), EXIT.timeout;
    handle = r.handle;
    if (pending.length) return log(`拿到锁的同时收到 ${pending[0]},放弃(未执行)`), signalExit(pending[0]!);
    log(`已持锁:label=${parsed.label} pid=${process.pid}`);
    const r2 = await runGated(parsed.argv, handle, parsed.drainSec * 1000, pending);
    keep = r2.keep;
    return r2.code;
  } finally {
    onSig.forEach(([s, f]) => process.off(s, f));
    const rel = keep ? undefined : handle?.release();
    if (rel && rel !== "released") log(`释放时锁已不是本次持有(${rel}),未删除`);
  }
}

/** status 子命令:当前锁记录 + 死活判断(JSON) */
export function lockStatus(): number {
  const path = deployLockPath();
  const r = readDeployLock(path);
  const out = r.status === "ok"
    ? { path, status: "held", state: holderLiveness(r.record), record: { ...r.record, token: undefined } }
    : { path, ...r };
  console.log(JSON.stringify(out, null, 2));
  return r.status === "corrupt" ? EXIT.lockError : 0;
}
