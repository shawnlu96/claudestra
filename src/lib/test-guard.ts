/**
 * 测试进程的隔离闸（T45）：测试一旦连上线上 bridge、读到仓库 .env、落到真实状态目录，写的就是真数据
 * （09-29 往线上 cron.json 写过 test-job，也把消息发给过线上 bridge）。闸在库里，不靠每条用例自己记得隔离。
 *
 * 认测试进程有两条路：tests/preload.ts 设的 CLAUDESTRA_TEST=1（最小 env 的子进程经 tests/test-env.ts 带上），
 * 或 bun test 自己设的 NODE_ENV=test（不在仓库根跑、preload 没加载时兜底）。生产的 bridge / cron / launcher
 * 与 agent 会话都不带 NODE_ENV（T45 PR 里有实测），没有标记时这里全是空操作。
 * 剩余风险：bun test 不覆盖外部预设的 NODE_ENV——不经 preload、又带着 NODE_ENV=development 之类跑时，两条都认不出，闸不生效。
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { REPO_ROOT } from "./repo-root.js";
import { canonicalPath as canonical } from "./sandbox.js";

export const TEST_FLAG = "CLAUDESTRA_TEST";

type Env = Record<string, string | undefined>;

export function isTestProcess(env: Env = process.env): boolean {
  return env[TEST_FLAG] === "1" || env.NODE_ENV === "test";
}

export class TestIsolationViolation extends Error {
  constructor(problem: string) {
    super(`测试进程（${TEST_FLAG}=1 或 NODE_ENV=test）拒绝：${problem}。子进程用 tests/test-env.ts 的 testChildEnv() 起`);
    this.name = "TestIsolationViolation";
  }
}

/** Bun 启动时从 cwd 自动加载的 env 文件（.env.local 在 NODE_ENV=test 时不加载，照样挡） */
export const AUTOLOADED_ENV_FILES = [".env", ".env.local", ".env.test"] as const;

/**
 * path 是不是仓库根（或 root 指定的目录）下 Bun 会自动加载的 env 文件。按文件本身解析软链后的路径比（别处指向仓库 .env
 * 的软链、macOS 的 /tmp ↔ /private/tmp），且不分大小写（APFS 上 `.ENV` 就是 `.env`；Linux 上只会多拦、不会漏拦）。
 */
export function isRepoEnvFile(path: string, root: string = REPO_ROOT): boolean {
  const key = (p: string) => canonical(p).toLowerCase();
  const names = AUTOLOADED_ENV_FILES as readonly string[];
  if (names.includes(basename(path).toLowerCase()) && key(dirname(path)) === key(root)) return true; // 仓库 .env 本身是软链也算
  return names.some((n) => key(join(root, n)) === key(path));
}

/**
 * 测试进程不许写仓库根的 .env 系列：读闸让它们看起来是空的，「只补缺的键」的写入逻辑照走就会改写线上配置
 * （legacy-web / web-state-migrate 的补键）。
 */
export function assertNoRepoEnvWriteInTest(path: string): void {
  if (isTestProcess() && isRepoEnvFile(path)) throw new TestIsolationViolation(`写仓库根的 ${basename(path)}`);
}

/** 临时目录的根：测试的假 HOME / 状态目录都建在这下面（macOS 上 /tmp、/var/folders 是 /private 下的软链） */
const TEMP_ROOTS = ["/tmp", "/var/folders"];

function underTemp(p: string): boolean {
  const c = canonical(p);
  return [tmpdir(), ...TEMP_ROOTS].map(canonical).some((r) => c === r || c.startsWith(`${r}/`));
}

/**
 * 测试进程的状态目录：默认推出来的（没设 CLAUDESTRA_STATE_DIR，或设的就是默认那个）不在临时目录下——也就是真实的
 * ~/.claude-orchestrator——时换成新建的临时目录，并在 stderr 提示一次。不按「真实家目录」比：Bun 的 homedir() /
 * userInfo() 都读 HOME，认不出来；而测试的假 HOME 一律建在临时目录下，用临时 HOME 的子进程照常用 HOME 下的目录。
 * 选「换」而不是抛错：不经 preload 跑（仓库外目录、绝对路径）时抛错会让几百条纯逻辑用例在 import 阶段全挂、
 * 看不出真问题；换成临时目录同样碰不到真数据，提示说明了原因。验证默认路径的用例在子进程里去掉 CLAUDESTRA_TEST 与
 * NODE_ENV 再求值（tests/paths.test.ts）。
 */
export function testSafeStateDir(dir: string, defaultDir: string, env: Env = process.env): string {
  if (!isTestProcess(env) || underTemp(dir) || canonical(dir) !== canonical(defaultDir)) return dir;
  const tmp = mkdtempSync(join(tmpdir(), "cstra-test-state-"));
  process.stderr.write(`[test-guard] 测试进程的状态目录指向 ${dir}（不是临时目录），已改用 ${tmp}（tests/preload.ts 没加载？在仓库根跑 bun test）\n`);
  env.CLAUDESTRA_STATE_DIR = tmp;
  return tmp;
}
