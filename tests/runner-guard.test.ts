/**
 * tests/runner-guard.ts：测试子进程执行体的开工闸（10-12 runner 按真实 HOME 改写 principals.json 的事故）。
 * 「真实家目录」一律由临时目录扮演，不碰本机的家目录。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerHome } from "./api-runner-harness.ts";
import { checkRunnerEnv, passwdHome, RUNNER_MARK, RUNNER_REAL_HOME_ENV, RunnerGuardViolation } from "./runner-guard.ts";
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
  // TMPDIR 设在非标准位置（如 /run/user/<uid>）时 harness 建的 HOME 会落到这里：报错要点明是 TMPDIR 的环境原因
  expect(() => checkRunnerEnv({ ...mark, HOME: "/run/user/501/cstra-x/home" }, [realHome])).toThrow("TMPDIR");
  expect(() => checkRunnerEnv({ ...mark, HOME: "/tmp" }, [realHome])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [realHome], [join(root, "elsewhere")])).toThrow("不在系统临时目录");
  expect(() => checkRunnerEnv({ ...mark }, [realHome])).toThrow("HOME 没设");
  expect(() => checkRunnerEnv({ ...mark, HOME: "rel/home" }, [realHome])).toThrow("HOME 没设");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [])).toThrow("认不出真实家目录");
  expect(() => checkRunnerEnv({ ...mark, HOME: tempHome }, [""])).toThrow("认不出真实家目录");
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
