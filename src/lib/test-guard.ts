/**
 * 测试进程的隔离闸（T45）：测试一旦连上线上 bridge、读到仓库 .env、落到真实状态目录，写的就是真数据
 * （09-29 往线上 cron.json 写过 test-job，也把消息发给过线上 bridge）。闸在库里，不靠每条用例自己记得隔离。
 *
 * 认测试进程有两条路：tests/preload.ts 设的 CLAUDESTRA_TEST=1（最小 env 的子进程经 tests/test-env.ts 带上），
 * 或 bun test 自己设的 NODE_ENV=test（不在仓库根跑、preload 没加载时兜底）。生产的 bridge / cron / launcher
 * 与 agent 会话都不带 NODE_ENV（T45 PR 里有实测），没有标记时这里全是空操作。
 * 剩余风险：bun test 不覆盖外部预设的 NODE_ENV——不经 preload、又带着 NODE_ENV=development 之类跑时，两条都认不出，闸不生效。
 */
import { lstatSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { REPO_ROOT } from "./repo-root.js";
import { canonicalPath as canonical, pathsOverlap } from "./sandbox.js";
import { FlokaIsolationConflict, readIsolationEnv } from "./floka-env/read.js";
import { flokaName, legacyName } from "./floka-env/names.js";
import { runtimeRoots } from "./floka-env/roots.js";

export const TEST_FLAG = "CLAUDESTRA_TEST";

type Env = Record<string, string | undefined>;

/** 测试标记与目录的两套名字（旧名、FLOKA_ 新名）都认，不看改名档位；两名冲突直接拒（lib/floka-env/read.ts） */
function iso(suffix: string, env: Env): string | undefined {
  try {
    return readIsolationEnv(suffix, env);
  } catch (e) {
    if (e instanceof FlokaIsolationConflict) throw new TestIsolationViolation(e.message);
    throw e;
  }
}

export function isTestProcess(env: Env = process.env): boolean {
  return iso("TEST", env) === "1" || env.NODE_ENV === "test";
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

/** 解析软链后在系统临时目录下（测试的假 HOME、preload 建的状态目录都在这里） */
export function isUnderTempDir(p: string): boolean {
  const c = canonical(p);
  return [tmpdir(), ...TEMP_ROOTS].map(canonical).some((r) => c === r || c.startsWith(`${r}/`));
}

/** 换成临时目录：旧名照写，新名在 env 里出现过也一起改写（否则 on 档下一次解析又取回新名那个生产值） */
function redirectToTemp(suffix: string, label: string, dir: string, env: Env, warn: boolean): string {
  const tmp = mkdtempSync(join(tmpdir(), `cstra-test-${label}-`));
  const key = legacyName(suffix);
  if (warn) process.stderr.write(`[test-guard] 测试进程的 ${key} 指向 ${dir}（不是测试专用的临时目录，可能是生产目录），已改用 ${tmp}\n`);
  env[key] = tmp;
  if (env[flokaName(suffix)] !== undefined) env[flokaName(suffix)] = tmp;
  return tmp;
}

/**
 * 测试进程的状态目录不在临时目录下就一律换成新建的临时目录，不管它是默认推出来的还是显式设的：真实目录认不出来——
 * Bun 的 homedir() / userInfo() 都读 HOME，HOME 被改成沙箱目录后继承来的生产 CLAUDESTRA_STATE_DIR 会被当成有意的
 * override 放行（tests/test-guard.test.ts）。测试的假 HOME / 状态目录一律建在临时目录下，不受影响。
 * 选「换」而不是抛错：不经 preload 跑时抛错会让几百条纯逻辑用例在 import 阶段全挂；验证默认路径的用例在子进程里
 * 去掉 CLAUDESTRA_TEST 与 NODE_ENV 再求值（tests/paths.test.ts）。isTemp 只给回归测试注入。
 */
export function testSafeStateDir(dir: string, env: Env = process.env, isTemp: (p: string) => boolean = isUnderTempDir): string {
  if (!isTestProcess(env)) return dir;
  const named = (iso("STATE_DIR", env) || "").trim(); // 档位没让它生效的那个名字也不许指向真实目录（子进程可能是 on 档）
  if (isTemp(dir) && (!named || isTemp(named))) return dir;
  return redirectToTemp("STATE_DIR", "state", dir, env, true);
}

/**
 * 测试进程的运行目录（tmux 的 master.sock 在里面）：生产默认的 /tmp/claude-orchestrator 恰好在 /tmp 下，只看「在不在
 * 临时目录」挡不住，和默认目录重叠也换。默认值在每个最小 env 的子进程里都会命中，所以只在显式设了时才提示。
 */
export function testSafeRuntimeDir(dir: string, defaultDir: string, env: Env = process.env): string {
  if (!isTestProcess(env)) return dir;
  const named = (iso("RUNTIME_DIR", env) || "").trim();
  const safe = (p: string) => isUnderTempDir(p) && !runtimeRoots(defaultDir).some((r) => pathsOverlap(p, r));
  if (safe(dir) && (!named || safe(named))) return dir;
  return redirectToTemp("RUNTIME_DIR", "rt", dir, env, Boolean(named));
}

/** 与 tests/test-tmp-root.ts 的 PREFIX 同值：那边的过期清扫按这个前缀 + 属主 pid 认领，兜底建的根也归它清 */
const TEST_RUN_ROOT_PREFIX = "cstra-test-run-";

/**
 * 看门子进程：stdin 管道的写端只在 runner 里（CLOEXEC，测试起的子孙进程拿不到），runner 不管正常结束、抛错还是被杀，
 * 内核都会关掉它，子进程读到 EOF 就删根。删前核对根仍是原父目录下同一个前缀目录（不是软链、dev/ino 没变），
 * 与 tests/test-tmp-root.ts 的 removeRoot 同一套属主检查；忽略 SIGINT/SIGHUP，免得 Ctrl-C 连它一起杀掉、根留下。
 * unref：不拖住 runner 退出。删根比 runner 退出晚几毫秒，scripts/test-tmp-leak.ts 查之前会等属主已退出的根消失。
 */
const REAPER = `for (const s of ["SIGINT", "SIGHUP"]) process.on(s, () => {});
const fs = require("fs"), path = require("path");
const [root, parent, dev, ino] = process.argv.slice(-4);
await Bun.stdin.text();
try {
  const st = fs.lstatSync(root);
  const owned = path.dirname(root) === parent && path.basename(root).startsWith(${JSON.stringify(TEST_RUN_ROOT_PREFIX)})
    && st.isDirectory() && !st.isSymbolicLink() && String(st.dev) === dev && String(st.ino) === ino && fs.realpathSync(root) === root;
  if (owned) fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
  else console.error("[test-guard] 兜底根 " + root + " 已被替换，不删");
} catch (e) {
  if (e.code !== "ENOENT") console.error("[test-guard] 兜底根 " + root + " 没删掉：" + e);
}`;

function reapOnExit(root: string): void {
  const { dev, ino } = lstatSync(root);
  const reaper = Bun.spawn([process.execPath, "-e", REAPER, root, dirname(root), String(dev), String(ino)], {
    stdin: "pipe", stdout: "ignore", stderr: "inherit", cwd: dirname(root), env: { PATH: process.env.PATH },
  });
  reaper.unref();
}

/**
 * 没加载 tests/preload.ts 的 bun test 进程（仓库外 cwd、绝对路径、--config=/dev/null 跑）也把 TMPDIR 换成运行临时根
 * （merge-arch-TMPLEAK2）：否则 recovery-* / ledger-* 之类用例自己 mkdtemp(tmpdir()) 的目录和本文件的 cstra-test-state/rt-、
 * state-maintenance 的 cstra-test-maint- 全落在系统临时目录顶层、没人删（实测一次 68 个文件就留下 650 多个）。
 * 做法同 tests/test-tmp-root.ts 的 installTestTmpRoot（src 不许依赖 tests/，只抄建根与子进程继承两步）：只管 runner 本身，
 * preload 先装好根（tmpdir() 已在 cstra-test-run-* 里）、或继承了根的子进程都跳过；子进程显式给的 TMPDIR 照旧。
 * runner 收尾不发 exit 事件、库里注册的 afterAll 只绑第一个文件，所以删根交给 reapOnExit 的看门子进程。
 */
function installFallbackTestTmpRoot(env: Env = process.env): void {
  const runner = /\.test\.[cm]?[jt]sx?$/.test((globalThis as { Bun?: { main?: string } }).Bun?.main ?? "");
  if (!runner || !isTestProcess(env) || canonical(tmpdir()).split("/").some((s) => s.startsWith(TEST_RUN_ROOT_PREFIX))) return;
  const root = mkdtempSync(join(canonical(tmpdir()), `${TEST_RUN_ROOT_PREFIX}${process.pid}-`));
  reapOnExit(root);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) env[key] = root;
  // Bun 不传 env 起的子进程用启动时的环境，补上当前的（同 tests/test-tmp-root.ts 的 inheritEnv）
  const inherit = <T extends (...args: any[]) => any>(launch: T): T => ((command: string[] | { env?: Env }, options?: { env?: Env }) => {
    const config = Array.isArray(command) ? options : command;
    const inherited = { ...config, env: config?.env ?? process.env };
    return Array.isArray(command) ? launch(command, inherited) : launch(inherited);
  }) as T;
  Bun.spawn = inherit(Bun.spawn);
  Bun.spawnSync = inherit(Bun.spawnSync);
}
installFallbackTestTmpRoot();

/** 只由 tests/isolated-state.ts 设在独立状态目录的 bun test 子进程 env 里：必须走默认出借 journal 的用例（路由 / pushWork）在那里跑 */
export const DEFAULT_LEND_JOURNAL_OK = "CLAUDESTRA_TEST_DEFAULT_LEND_JOURNAL";

/** bun test 进程以默认路径打开出借 journal：preload 的状态目录全量共用，交错改写读到半个文件就 malformed（i28-TJ1）。子进程各有状态目录，不管 */
export function guardDefaultLendJournal(path: string, defaultPath: string, env: Env = process.env): void {
  const runner = /\.test\.[cm]?[jt]sx?$/.test((globalThis as { Bun?: { main?: string } }).Bun?.main ?? "");
  if (runner && isTestProcess(env) && path === defaultPath && env[DEFAULT_LEND_JOURNAL_OK] !== "1") throw new TestIsolationViolation(`以默认路径打开出借 journal ${path}（全量各测试文件共用）；传独立的临时 journalPath`);
}
