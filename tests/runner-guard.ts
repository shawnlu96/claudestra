/**
 * 测试子进程执行体（tests/ 下被 Bun.spawn / spawnSync 起来、本身不是 *.test.ts 的脚本）的开工闸。
 *
 * 10-12 事故：tests/api-route-parity.runner.ts 被直接跑（混进了 bun test 的文件清单），按真实 HOME 写了
 * principals.json，真实授权表整个换成两条仓库里公开密钥的测试 token。preload 只隔离状态目录、不隔离 HOME，
 * 这类执行体又是靠父进程带临时 HOME 才安全——所以执行体自己在任何读写之前先验：
 *   1. 父进程标记 RUNNER_MARK=1（由起子进程的一侧设，见 tests/api-runner-harness.ts）；
 *   2. HOME 在系统临时目录下，且不等于、也不在真实家目录之下。
 * 不满足就非零退出，一个文件都不写。
 *
 * 真实家目录不能用 os.homedir() / os.userInfo()：Bun 的这两个都读 HOME，HOME 被改过就认不出来。这里按 passwd
 * 解析（`~用户名`）。RUNNER_REAL_HOME_ENV 只给回归测试用临时目录扮演「真实家目录」，只会多拦、不会放宽。
 *
 * 新加的执行体同样在开头调 guardRunner()；tests/runner-guard-scan.test.ts 会扫出漏调的。
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const RUNNER_MARK = "CLAUDESTRA_TEST_RUNNER";
export const RUNNER_REAL_HOME_ENV = "CLAUDESTRA_TEST_RUNNER_REAL_HOME";

/** 系统临时目录的根（macOS 上 /tmp、/var 是 /private 下的软链，比较前都解析）。不用 os.tmpdir()：harness 把子进程的 TMPDIR 设成了 HOME 本身 */
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
  const raw = (env.HOME || "").trim();
  if (!raw || !isAbsolute(raw)) throw new RunnerGuardViolation("HOME 没设或不是绝对路径");
  const home = canonical(raw);
  const homes = realHomes.map((h) => h.trim());
  if (!homes.length || homes.some((h) => !isAbsolute(h))) throw new RunnerGuardViolation("认不出真实家目录，无法确认 HOME 是隔离的");
  for (const h of homes.map(canonical)) {
    if (home === h) throw new RunnerGuardViolation(`HOME（${raw}）就是真实家目录`);
    if (within(home, h)) throw new RunnerGuardViolation(`HOME（${raw}）在真实家目录 ${h} 之下`);
  }
  const roots = tempRoots.map(canonical);
  if (!roots.some((r) => home !== r && within(home, r))) {
    // 父进程按 os.tmpdir() 建临时 HOME：TMPDIR 设在这几个根以外（如 /run/user/<uid>、/scratch）时会落到这里，是环境原因
    const hint = "若起测试的 shell 把 TMPDIR 设在了别处，换回系统临时目录再跑（例如 TMPDIR=/tmp bun test）";
    throw new RunnerGuardViolation(`HOME（${raw}）不在系统临时目录（${tempRoots.join(" / ")}）下；${hint}`);
  }
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
    const extra = (env[RUNNER_REAL_HOME_ENV] || "").trim();
    checkRunnerEnv(env, extra ? [passwdHome(), extra] : [passwdHome()]);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
}
