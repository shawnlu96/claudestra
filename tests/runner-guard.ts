/**
 * 测试子进程执行体（tests/ 下被 spawn、本身不是 *.test.ts 的脚本）的开工闸：要父进程标记 + 临时 HOME（不是、也不在真实家目录下），
 * 否则非零退出、不写文件。真实家目录按 passwd 解析（Bun 的 os.homedir / userInfo 都读 HOME）；RUNNER_REAL_HOME_ENV 只给回归测试扮演用。
 * 父进程用 runnerSpawnEnv() 带上标记和自己的临时根。兼当模块的执行体第一条 import 是 ./runner-guard-entry.ts（见那里）。
 */
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const RUNNER_MARK = "CLAUDESTRA_TEST_RUNNER";
export const RUNNER_REAL_HOME_ENV = "CLAUDESTRA_TEST_RUNNER_REAL_HOME";
/** 父进程的临时根（它的 os.tmpdir()）：TMPDIR 设在 /var/tmp、/run/user/<uid> 之类时 harness 建的 HOME 在这下面 */
export const RUNNER_TMP_ROOT_ENV = "CLAUDESTRA_TEST_RUNNER_TMP_ROOT";

/** 系统临时目录的根（macOS 上 /tmp、/var 是 /private 下的软链，比较前都解析）。子进程的 os.tmpdir() 不能用：harness 把它设成了 HOME 本身；父进程的临时根经 RUNNER_TMP_ROOT_ENV 传 */
const TEMP_ROOTS = ["/tmp", "/var/folders", "/private/tmp", "/private/var/folders"] as const;

type Env = Record<string, string | undefined>;

export class RunnerGuardViolation extends Error {
  constructor(problem: string) {
    super(`测试子进程执行体拒跑（不写任何文件）：${problem}。只能由测试经 tests/api-runner-harness.ts 之类带 ${RUNNER_MARK}=1 与临时 HOME 起`);
    this.name = "RunnerGuardViolation";
  }
}

/** 解析软链；路径还不存在时解析最近的存在的上级再接回去 */
function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  try {
    head = realpathSync(head);
  } catch {
    // 解析不了就按字面比
  }
  return join(head, ...tail);
}

/** child 等于 parent 或在它下面 */
function within(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/**
 * 纯函数：env 里的 HOME 能不能给执行体用。realHomes 是真实家目录（可以多个：passwd 解析的 + 测试扮演的）；
 * 不满足抛 RunnerGuardViolation，消息只有原因和路径，不带 env 里的任何凭据。
 */
export function checkRunnerEnv(env: Env, realHomes: readonly string[], tempRoots: readonly string[] = TEMP_ROOTS): void {
  if (env[RUNNER_MARK] !== "1") throw new RunnerGuardViolation(`缺父进程标记 ${RUNNER_MARK}=1`);
  // 不 trim：写盘用的是原样的 HOME，比的必须是同一个路径（`safe ` 可以是指向真实家目录的软链）
  const raw = env.HOME || "";
  if (raw !== raw.trim()) throw new RunnerGuardViolation("HOME 首尾带空白");
  if (!raw || !isAbsolute(raw)) throw new RunnerGuardViolation("HOME 没设或不是绝对路径");
  const home = canonical(raw);
  if (!realHomes.length || realHomes.some((h) => !isAbsolute(h))) throw new RunnerGuardViolation("认不出真实家目录，无法确认 HOME 是隔离的");
  const homes = realHomes.map(canonical);
  for (const h of homes) {
    if (home === h) throw new RunnerGuardViolation(`HOME（${raw}）就是真实家目录`);
    if (within(home, h)) throw new RunnerGuardViolation(`HOME（${raw}）在真实家目录 ${h} 之下`);
  }
  const declared = env[RUNNER_TMP_ROOT_ENV] || "";
  const roots = tempRoots.map(canonical);
  if (declared) {
    // 父进程报的临时根只能加一个根，不能放宽真实家目录的排除：根本身不能是 /、不能和真实家目录互相包含
    const d = canonical(declared);
    const bad = !isAbsolute(declared) || declared !== declared.trim() || d === "/" || homes.some((h) => within(d, h) || within(h, d));
    if (bad) throw new RunnerGuardViolation(`${RUNNER_TMP_ROOT_ENV}（${declared}）不能当临时根`);
    roots.push(d);
  }
  if (!roots.some((r) => home !== r && within(home, r))) {
    throw new RunnerGuardViolation(`HOME（${raw}）不在系统临时目录（${[...tempRoots, ...(declared ? [declared] : [])].join(" / ")}）下`);
  }
}

/** 起执行体的一侧并进子进程 env：父进程标记 + 自己的临时根 */
export function runnerSpawnEnv(): Record<string, string> {
  return { [RUNNER_MARK]: "1", [RUNNER_TMP_ROOT_ENV]: tmpdir() };
}

/** 进程入口（Bun.main）是 tests/ 下的非 .test.ts 文件，即执行体被直接起来了（bun test 时入口是测试文件，-e 时是 [eval]） */
export function isRunnerEntry(main: string): boolean {
  const dir = canonical(import.meta.dir);
  return !/\.test\.[cm]?[jt]sx?$/.test(main) && isAbsolute(main) && existsSync(main) && within(canonical(main), dir);
}

/** 按 passwd 查当前用户的家目录（不读 HOME）；查不到给 ""，checkRunnerEnv 会因此拒跑 */
export function passwdHome(): string {
  try {
    const r = Bun.spawnSync(["/bin/sh", "-c", 'eval "printf %s ~$(id -un)"'], {
      // `~用户名` 按 passwd 展开、不看 HOME；PATH 固定，免得被换成假的 id
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && isAbsolute(out) ? out : "";
  } catch {
    return "";
  }
}

/** 执行体开头调：不满足就把原因写到 stderr、exit 2 */
export function guardRunner(env: Env = process.env): void {
  try {
    const extra = env[RUNNER_REAL_HOME_ENV] || "";
    checkRunnerEnv(env, extra ? [passwdHome(), extra] : [passwdHome()]);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
}
