/**
 * 部署锁的 argv wrapper(scripts/pm-deploy-lock.ts 的逻辑):拿整机部署锁 → 以 argv 起部署命令(不经 shell)→ 原样传播退出码 / 信号 → 释放。
 * 等锁有界;超时、被信号打断、取锁 / 身份出错都不起命令(零部署),也不碰持有者。持锁期间收到的信号转发给部署子进程,等它退出再释放。
 */
import { constants } from "node:os";
import {
  acquireDeployLock, DEPLOY_LOCK_TOKEN_ENV, deployLockPath, describeHolder, holderLiveness, readDeployLock, reentrantHolder,
  type DeployLockHandle,
} from "./pm-deploy-lock.js";

export const EXIT = { usage: 64, lockError: 70, timeout: 75, spawnFailed: 127 } as const;
const DEFAULT_WAIT_SEC = 600;
const MAX_WAIT_SEC = 3600;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const USAGE = `用法:
  pm-deploy-lock run --label <label> [--wait-sec N] -- <命令> [参数...]   拿整机部署锁后以 argv 执行(默认等 ${DEFAULT_WAIT_SEC}s,上限 ${MAX_WAIT_SEC}s)
  pm-deploy-lock status                                                   打印当前持有者诊断(JSON)
退出码:命令自身退出码 / 128+信号;${EXIT.timeout}=等锁超时(未执行);${EXIT.lockError}=取锁或身份错误(未执行);${EXIT.usage}=用法错误`;

interface RunArgs { label: string; waitSec: number; argv: string[] }

function parseRunArgs(args: string[]): RunArgs | string {
  const sep = args.indexOf("--");
  if (sep < 0 || sep === args.length - 1) return "缺少 `-- <命令> [参数...]`";
  const opts = args.slice(0, sep);
  let label = "";
  let waitSec = DEFAULT_WAIT_SEC;
  for (let i = 0; i < opts.length; i += 2) {
    const [k, v] = [opts[i], opts[i + 1]];
    if (v === undefined) return `参数 ${k} 缺值`;
    if (k === "--label") label = v;
    else if (k === "--wait-sec" && /^\d+(\.\d+)?$/.test(v) && +v <= MAX_WAIT_SEC) waitSec = +v;
    else return `不认识或不合法的参数:${k} ${v}`;
  }
  if (!label) return "缺少 --label";
  return { label, waitSec, argv: args.slice(sep + 1) };
}

const log = (s: string) => process.stderr.write(`[pm-deploy-lock] ${s}\n`);

function signalExit(sig: string): number {
  return 128 + ((constants.signals as Record<string, number>)[sig] ?? 0);
}

/** 起子进程并传播退出;env 带上持有者 token 供嵌套 wrapper 受控重入 */
async function runChild(argv: string[], token: string, handle: DeployLockHandle | null, pending: string[]): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, [DEPLOY_LOCK_TOKEN_ENV]: token } });
  } catch (e) {
    log(`起命令失败:${(e as Error).message}`);
    return EXIT.spawnFailed;
  }
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  const fwd = SIGNALS.map((s) => [s, () => forward(s)] as const);
  fwd.forEach(([s, f]) => process.on(s, f));
  try {
    if (pending.length) forward(pending[0] as NodeJS.Signals); // 起命令的同一刻收到的信号也要送到
    if (handle) {
      try {
        handle.recordChild(child.pid);
      } catch (e) {
        // 子进程身份进不了锁记录:wrapper 被 SIGKILL 时锁会被当死回收而子进程仍在跑,fail-closed 终止它
        log(`记录部署子进程身份失败,终止命令:${(e as Error).message}`);
        child.kill("SIGTERM");
        await child.exited;
        return EXIT.lockError;
      }
    }
    const code = await child.exited;
    return child.signalCode ? signalExit(child.signalCode) : code;
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
    return runChild(parsed.argv, outer.token, null, []);
  }
  const pending: string[] = [];
  const onSig = SIGNALS.map((s) => [s, () => pending.push(s)] as const);
  onSig.forEach(([s, f]) => process.on(s, f));
  let handle: DeployLockHandle | null = null;
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
    return await runChild(parsed.argv, handle.record.token, handle, pending);
  } finally {
    onSig.forEach(([s, f]) => process.off(s, f));
    const rel = handle?.release();
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
