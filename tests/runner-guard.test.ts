/**
 * tests/runner-guard.ts：测试子进程执行体的开工闸（10-12 runner 按真实 HOME 改写 principals.json 的事故）。
 * 「真实家目录」一律由临时目录扮演，不碰本机的家目录。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerHome } from "./api-runner-harness.ts";
import { checkRunnerEnv, isRunnerEntry, passwdHome, RUNNER_MARK, RUNNER_REAL_HOME_ENV, RUNNER_TMP_ROOT_ENV, RunnerGuardViolation, runnerSpawnEnv } from "./runner-guard.ts";
import { testChildEnv } from "./test-env.ts";

const root = mkdtempSync(join(tmpdir(), "cstra-runner-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirs() {
  const realHome = mkdtempSync(join(root, "realhome-"));
  const tempHome = mkdtempSync(join(root, "temphome-"));
  return { realHome, tempHome };
}

test("[验收线 1] 缺标记、HOME 等于真实家目录、HOME 在真实家目录之下，三种都拒", () => {
  const { realHome, tempHome } = dirs();
  const sub = join(realHome, "nested", "home");
  mkdirSync(sub, { recursive: true });
  expect(() => checkRunnerEnv({ HOME: tempHome }, [realHome])).toThrow(RUNNER_MARK);
  expect(() => checkRunnerEnv({ HOME: tempHome, [RUNNER_MARK]: "0" }, [realHome])).toThrow(RunnerGuardViolation);
  expect(() => checkRunnerEnv({ HOME: realHome, [RUNNER_MARK]: "1" }, [realHome])).toThrow("就是真实家目录");
  expect(() => checkRunnerEnv({ HOME: `${realHome}/`, [RUNNER_MARK]: "1" }, [realHome])).toThrow("就是真实家目录");
  expect(() => checkRunnerEnv({ HOME: sub, [RUNNER_MARK]: "1" }, [realHome])).toThrow("之下");
  // 还没建出来的子目录也算在下面
  expect(() => checkRunnerEnv({ HOME: join(realHome, "not-yet"), [RUNNER_MARK]: "1" }, [realHome])).toThrow("之下");
});

test("[验收线 1] 标记 + 临时目录放行", () => {
  const { realHome, tempHome } = dirs();
  expect(() => checkRunnerEnv({ HOME: tempHome, [RUNNER_MARK]: "1" }, [realHome])).not.toThrow();
  // 多个真实家目录（passwd 的 + 测试扮演的）都不沾才放行
  expect(() => checkRunnerEnv({ HOME: tempHome, [RUNNER_MARK]: "1" }, ["/nonexistent-home-x", realHome])).not.toThrow();
});

test("[验收线 1] 指向真实家目录的软链、临时目录外、临时根本身、没设 HOME、认不出真实家目录，都拒", () => {
  const { realHome, tempHome } = dirs();
  const link = join(tempHome, "link-to-real");
  symlinkSync(realHome, link);
  const mark = { [RUNNER_MARK]: "1" };
  expect(() => checkRunnerEnv({ ...mark, HOME: link }, [realHome])).toThrow("就是真实家目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: "/opt/cstra-not-temp" }, [realHome])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: "/run/user/501/cstra-x/home" }, [realHome])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: "/tmp" }, [realHome])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [realHome], [join(root, "elsewhere")])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark }, [realHome])).toThrow("HOME 没设");
  expect(() => checkRunnerEnv({ ...mark, HOME: "rel/home" }, [realHome])).toThrow("HOME 没设");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [])).toThrow("认不出真实家目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [""])).toThrow("认不出真实家目录");
});

test("[验收线 1] HOME 首尾带空白一律拒（不 trim：`safe ` 可以是指向真实家目录的软链，写盘用的是原样的 HOME）", () => {
  const { realHome, tempHome } = dirs();
  mkdirSync(join(tempHome, "safe"));
  symlinkSync(realHome, join(tempHome, "safe "));
  const mark = { [RUNNER_MARK]: "1" };
  expect(() => checkRunnerEnv({ ...mark, HOME: join(tempHome, "safe ") }, [realHome])).toThrow(RunnerGuardViolation);
  expect(() => checkRunnerEnv({ ...mark, HOME: ` ${join(tempHome, "safe")}` }, [realHome])).toThrow("空白");
  expect(() => checkRunnerEnv({ ...mark, HOME: join(tempHome, "safe") }, [realHome])).not.toThrow();
  // 真实家目录参数也按原样解析：带空格的软链扮演的真实家目录照样认得出
  expect(() => checkRunnerEnv({ ...mark, HOME: realHome }, [join(tempHome, "safe ")])).toThrow("就是真实家目录");
});

test("父进程报的临时根（TMPDIR 在 /var/tmp、/run/user/<uid> 之类）放行其下的 HOME，但不放宽真实家目录的排除", () => {
  const { realHome } = dirs();
  const customRoot = mkdtempSync(join(root, "custom-tmp-"));
  const home = join(customRoot, "cstra-x", "home");
  const mark = { [RUNNER_MARK]: "1" };
  const std = [join(root, "elsewhere")]; // 扮演系统临时根，customRoot 不在其下
  expect(() => checkRunnerEnv({ ...mark, HOME: home }, [realHome], std)).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: home, [RUNNER_TMP_ROOT_ENV]: customRoot }, [realHome], std)).not.toThrow();
  expect(() => checkRunnerEnv({ ...mark, HOME: customRoot, [RUNNER_TMP_ROOT_ENV]: customRoot }, [realHome], std)).toThrow("不在系统临时目录");
  // 报的根是 /、是真实家目录、在它下面、或包含它：拒
  for (const bad of ["/", realHome, join(realHome, "tmp"), root, "rel/tmp", `${customRoot} `]) {
    expect(() => checkRunnerEnv({ ...mark, HOME: home, [RUNNER_TMP_ROOT_ENV]: bad }, [realHome], std)).toThrow(RunnerGuardViolation);
  }
  // HOME 在真实家目录下照拒，不管报了什么根
  expect(() => checkRunnerEnv({ ...mark, HOME: join(realHome, "x"), [RUNNER_TMP_ROOT_ENV]: customRoot }, [realHome], std)).toThrow("之下");
  expect(runnerSpawnEnv()).toEqual({ [RUNNER_MARK]: "1", [RUNNER_TMP_ROOT_ENV]: tmpdir() });
});

test("isRunnerEntry：入口是 tests/ 下的非 .test.ts 才算执行体", () => {
  expect(isRunnerEntry(join(import.meta.dir, "relay-enable-fixture.ts"))).toBe(true);
  expect(isRunnerEntry(join(import.meta.dir, "api-route-parity.runner.ts"))).toBe(true);
  expect(isRunnerEntry(import.meta.path)).toBe(false);
  expect(isRunnerEntry(join(process.cwd(), "[eval]"))).toBe(false);
  expect(isRunnerEntry(join(import.meta.dir, "..", "src", "manager.ts"))).toBe(false);
});

test("[验收线 1] 拒绝原因不带 env 里的凭据", () => {
  const { realHome } = dirs();
  const leaky = { HOME: realHome, RUNNER_PRINCIPALS: JSON.stringify([{ secret: "s-leak-me" }]), CLAUDESTRA_TOKEN: "tok-leak-me" };
  for (const e of [leaky, { ...leaky, [RUNNER_MARK]: "1" }]) {
    let msg = "";
    try {
      checkRunnerEnv(e, [realHome]);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("leak-me");
  }
});

test("passwdHome 不读 HOME（Bun 的 os.homedir / userInfo 都读）", () => {
  const { tempHome } = dirs();
  const mod = JSON.stringify(join(import.meta.dir, "runner-guard.ts"));
  const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `import { passwdHome } from ${mod}; process.stdout.write(passwdHome());`], {
    env: testChildEnv({ HOME: tempHome }),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(passwdHome());
  expect(passwdHome().startsWith("/")).toBe(true);
  expect(passwdHome()).not.toBe(tempHome);
});

/** 目录下全部文件的相对路径 → 内容（含目录项本身），比前后是否一字不差、有没有新文件 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) {
        out[`${r}/`] = "";
        walk(p, r);
      } else out[r] = readFileSync(p).toString("base64");
    }
  };
  walk(dir, "");
  return out;
}

const RUNNER = join(import.meta.dir, "api-route-parity.runner.ts");
/** Bun 自己的转译缓存默认落在 $HOME/Library/Caches（macOS）：那是 bun 写的、不是执行体写的，关掉免得混进快照 */
const NO_BUN_CACHE = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };

function runRunner(env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, "--no-env-file", RUNNER, "[]"], { env: testChildEnv({ PATH: "/usr/bin:/bin", LANG: "C", ...NO_BUN_CACHE, ...env }), stdout: "pipe", stderr: "pipe" });
}

test("[验收线 2] 不带标记直接跑 runner：非零退出，扮演真实家目录里的 principals.json 字节不变、不新建文件", () => {
  const fakeReal = mkdtempSync(join(root, "fake-real-home-"));
  const cfg = join(fakeReal, ".claude-orchestrator");
  mkdirSync(cfg);
  const original = JSON.stringify({ principals: [{ id: "token:real", role: "owner", secret: "real-secret-do-not-touch" }] });
  writeFileSync(join(cfg, "principals.json"), original);
  const nested = join(fakeReal, "work");
  mkdirSync(nested);
  const before = snapshot(fakeReal);

  const cases: Record<string, string>[] = [
    // 直接跑：没有标记，HOME 就是（扮演的）真实家目录
    { HOME: fakeReal, TMPDIR: fakeReal },
    { HOME: fakeReal, TMPDIR: fakeReal, [RUNNER_REAL_HOME_ENV]: fakeReal },
    // 有人照抄了标记也不行：HOME 是真实家目录 / 在它下面
    { HOME: fakeReal, TMPDIR: fakeReal, [RUNNER_MARK]: "1", [RUNNER_REAL_HOME_ENV]: fakeReal },
    { HOME: nested, TMPDIR: nested, [RUNNER_MARK]: "1", [RUNNER_REAL_HOME_ENV]: fakeReal },
  ];
  for (const env of cases) {
    const r = runRunner(env);
    expect(r.exitCode).not.toBe(0);
    const err = r.stderr.toString();
    expect(err).toContain("拒跑");
    expect(err).not.toContain("s-full");
    expect(r.stdout.toString()).toBe("");
    expect(snapshot(fakeReal)).toEqual(before);
  }
  expect(readFileSync(join(cfg, "principals.json"), "utf8")).toBe(original);
});

test("[验收线 2] 带标记、HOME 是名字带尾空格且指向真实家目录的软链：runner 拒跑、真实家目录不变", () => {
  const fakeReal = mkdtempSync(join(root, "fake-real-home-ws-"));
  mkdirSync(join(fakeReal, ".claude-orchestrator"));
  writeFileSync(join(fakeReal, ".claude-orchestrator", "principals.json"), JSON.stringify({ principals: [{ id: "token:real" }] }));
  const t = mkdtempSync(join(root, "ws-"));
  mkdirSync(join(t, "safe"));
  symlinkSync(fakeReal, join(t, "safe "));
  const before = snapshot(fakeReal);
  const r = runRunner({ HOME: join(t, "safe "), TMPDIR: join(t, "safe"), [RUNNER_MARK]: "1", [RUNNER_REAL_HOME_ENV]: fakeReal });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("拒跑");
  expect(snapshot(fakeReal)).toEqual(before);
});

test("[验收线 2] 对照：标记 + 临时 HOME 时 runner 照常跑（上面的拒绝不是别的原因）", () => {
  const h = runnerHome("cstra-runner-guard-ok-", { agents: {} });
  try {
    expect(h.run([])).toEqual([]);
    expect(readFileSync(join(h.home, ".claude-orchestrator", "principals.json"), "utf8")).toContain("tok_full");
  } finally {
    h.cleanup();
  }
});

test("[验收线 2] 不带标记直接跑 scheduler-merge-reclaim-world.ts：非零退出，扮演的状态目录不新建文件", () => {
  const fakeReal = mkdtempSync(join(root, "fake-real-home-world-"));
  const state = join(fakeReal, ".claude-orchestrator");
  mkdirSync(state);
  writeFileSync(join(state, "principals.json"), "{}");
  const before = snapshot(fakeReal);
  const env = testChildEnv({ ...NO_BUN_CACHE, HOME: fakeReal, TMPDIR: fakeReal, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(fakeReal, "rt"), [RUNNER_REAL_HOME_ENV]: fakeReal });
  delete env.CLAUDESTRA_TEST;
  delete env.NODE_ENV;
  const r = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "scheduler-merge-reclaim-world.ts")], { env, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("拒跑");
  expect(snapshot(fakeReal)).toEqual(before);
});

test("[验收线 2] 兼当模块的执行体直接跑（NODE_ENV=test、不给运行目录）：静态依赖求值前就拒跑，HOME 下不新建任何东西", () => {
  for (const name of ["local-api-ledger-feed-fixture.ts", "relay-enable-fixture.ts", "scheduler-merge-reclaim-world.ts"]) {
    const home = mkdtempSync(join(root, "import-first-"));
    const before = snapshot(home);
    // TMPDIR 指 HOME：paths.ts 加载时的 testSafeRuntimeDir 会在这里 mkdtemp，守卫晚了就会多出 cstra-test-rt-*
    const env = testChildEnv({ ...NO_BUN_CACHE, PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home });
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, name), "[]"], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(RUNNER_MARK);
    expect(snapshot(home)).toEqual(before);
  }
});
