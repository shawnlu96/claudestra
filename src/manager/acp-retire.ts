/**
 * 切 Codex 适配器时让 agent 的宿主空闲退出（codex-adapter use / rollback 用，manager/acp-adapter.ts）。
 * 只在 restart 子进程拿到该 agent 的重启锁之后、碰窗口之前做（acp-lifecycle.ts managedForRestart 一行调用）：认宿主、发 SIGUSR2、
 * 等它退出、重起都在同一把锁里——锁外先退再交给 restart 的话，中间另一个 restart 能起新宿主，随后被这次 restart 掐在回合里。
 * 认宿主：agent 窗口 shell 的直接子进程里，pid 和启动代次（ps lstart）都对得上运行记录才发信号。记录是宿主自己写的、退出时不清，
 * 写它的就是认 SIGUSR2 的新宿主；pid 被别的进程（别的 agent 的宿主）复用、记录比窗口里的宿主旧、老宿主（不认信号，缺省动作是退出）
 * 都认不出，一律不发、不重启。tests/codex-adapter-switch-retire.test.ts。
 */
import { readCodexRunningHost } from "../lib/codex-version.js";
import { realProbe } from "../lib/pm-deploy-lock.js";
import { childPidsInPsOutput, MASTER_SESSION, pidAlive, tmuxRawStrict } from "../lib/tmux-helper.js";

/** restart 子进程带这个环境变量 = 这次重启是切换发起的，只在宿主空闲退出后才重起（manager/acp-adapter.ts 设） */
export const RETIRE_ENV = "CLAUDESTRA_RESTART_RETIRE_IDLE";
/** 不重起时抛的错误前缀；restart 结果里的 error 带着它 = 延后，不是失败 */
export const DEFER_MARK = "切换延后：";

/** exited = 空闲、已退；absent = 窗口里没有宿主（重启无回合可掐）；busy = 回合在跑；unknown = 认不出窗口里的进程 */
export type Retire = "exited" | "absent" | "busy" | "unknown";
export const DEFER_WHY: Record<"busy" | "unknown", string> = {
  busy: "回合在跑",
  unknown: "认不出窗口里的宿主（老宿主不认切换信号 / 运行记录过期 / 窗口不唯一），手动 restart 后生效",
};

/** 宿主收到 SIGUSR2 后 1.5s 退出（acp-host.ts）；等这么久还活着 = 在跑回合，没退 */
const RETIRE_WAIT_MS = 6_000;

/** agent 窗口 shell 的直接子进程；没有这个窗口 = []；同名窗口不止一个、tmux / ps 读失败 = null（认不出） */
async function windowProcs(agent: string): Promise<number[] | null> {
  try {
    const rows = (await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}\t#{pane_pid}"]))
      .split("\n").map((l) => l.split("\t")).filter(([n]) => n === agent);
    if (rows.length === 0) return [];
    const shell = Number(rows[0]![1]);
    if (rows.length > 1 || !Number.isInteger(shell) || shell <= 1) return null;
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid="]);
    return ps.exitCode === 0 ? childPidsInPsOutput(ps.stdout.toString(), shell) : null;
  } catch {
    return null; // 没有 master session / tmux 读失败：认不出，按 unknown 不切（切换延后，不是故障）
  }
}

export async function retireHost(agent: string, wait = RETIRE_WAIT_MS, procs: (a: string) => Promise<number[] | null> = windowProcs): Promise<Retire> {
  const kids = await procs(agent);
  if (!kids) return "unknown";
  const { hostPid: pid, hostStart } = readCodexRunningHost(agent);
  const recorded = !!pid && !!hostStart && realProbe.startOf(pid) === hostStart; // 写记录的那个宿主还活着
  if (kids.length === 0 && !recorded) return "absent";
  if (!recorded || !kids.includes(pid!)) return "unknown"; // 窗口里的不是写记录的那个，或那个不在这个窗口里
  process.kill(pid!, "SIGUSR2");
  for (const end = Date.now() + wait; Date.now() < end; await Bun.sleep(100)) if (!pidAlive(pid!)) return "exited";
  return "busy";
}

/**
 * managedForRestart 开头调（重启锁已拿到）：不是切换发起的重启什么都不做；是的话宿主退了才往下走，否则抛 DEFER_MARK 开头的错，
 * cmdRestart 照异常记进这个 agent 的结果、不碰窗口。registry 里已经不是 ACP Codex 了也不重启（掐的就不是我们认得的宿主了）。
 */
export async function retireForSwitch(
  name: string, info: { runtime?: string; transport?: string }, env: NodeJS.ProcessEnv = process.env, retire: (a: string) => Promise<Retire> = retireHost,
): Promise<void> {
  if (env[RETIRE_ENV] !== "1") return;
  if (info.runtime !== "codex" || info.transport !== "acp") throw new Error(`${DEFER_MARK}已经不是 ACP Codex agent 了`);
  const r = await retire(name);
  if (r === "busy" || r === "unknown") throw new Error(`${DEFER_MARK}${DEFER_WHY[r]}`);
}
