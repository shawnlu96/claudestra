/**
 * rename-floka-ENV1：FLOKA_ / CLAUDESTRA_ 双名环境变量（lib/floka-env/）与最早的隔离入口（paths / sandbox / test-guard）。
 * 解析矩阵在子进程里跑（临时 HOME / 状态 / 运行目录），隔离闸的纯函数直接调。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { ENV_FAMILIES, RENAMED_SUFFIXES, UNBRANDED_STEMS } from "../src/lib/floka-env/names.ts";
import { applyRenamedEnv, readIsolationEnv } from "../src/lib/floka-env/read.ts";
import { enforceSandboxBridgeUrl, isSandbox, sandboxBridgeEnvProblems, sandboxDirProblems, sandboxRelayUrlProblem } from "../src/lib/sandbox.ts";
import { productionDeny, sandboxEnv, sandboxLayout } from "../src/lib/sandbox-env.ts";
import { testChildEnv } from "./test-env.ts";

const LIB = resolve(import.meta.dir, "../src/lib");
const SECRET_A = "sk-synthetic-floka-AAAA1111";
const SECRET_B = "sk-synthetic-floka-BBBB2222";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

interface ChildOut {
  code: number;
  err: string;
  out: { state: string; runtime: string; again: string; envOld?: string; envNew?: string; override: Record<string, string>; tokOld?: string; tokNew?: string };
}

/** 子进程：import paths.ts，按 body 再改 env 后多次调 stateDir()，打印解析结果。HOME 是临时目录 */
function child(extra: Record<string, string | undefined>, body = ""): ChildOut & { home: string } {
  const home = tmp("floka-env-home-");
  const script = [
    `const p = await import(${JSON.stringify(join(LIB, "paths.ts"))});`,
    `const sd = await import(${JSON.stringify(join(LIB, "state-dir.ts"))});`,
    `sd.stateDir(); sd.stateDir();`,
    body,
    `const e = process.env;`,
    `console.log(JSON.stringify({ state: p.STATE_DIR, runtime: p.RUNTIME_DIR, again: sd.stateDir(), envOld: e.CLAUDESTRA_STATE_DIR, envNew: e.FLOKA_STATE_DIR,`,
    `  override: p.pathOverrideEnv(), tokOld: e.CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN, tokNew: e.FLOKA_PM_DEPLOY_LOCK_TOKEN }));`,
  ].join("\n");
  const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { env: testChildEnv({ HOME: home, ...extra }), cwd: home, stdout: "pipe", stderr: "pipe" });
  const stdout = r.stdout.toString().trim().split("\n").pop() || "null";
  return { code: r.exitCode ?? -1, err: r.stderr.toString(), out: r.exitCode === 0 ? JSON.parse(stdout) : ({} as ChildOut["out"]), home };
}

const GEARS = ["off", "observe", "on"] as const;
/** 解析矩阵按生产进程跑（去掉测试标记）：测试进程里状态 / 运行目录两名冲突直接拒（见验收线 2）。目录都在临时目录下，只 import 不写 */
const PROD_LIKE = { CLAUDESTRA_TEST: undefined, NODE_ENV: undefined };

describe("[验收线 1] 新 / 旧 / 双名 / 冲突矩阵", () => {
  const dirs = { old: tmp("floka-env-old-"), neu: tmp("floka-env-new-") };
  const cases = {
    newOnly: { FLOKA_STATE_DIR: dirs.neu },
    oldOnly: { CLAUDESTRA_STATE_DIR: dirs.old },
    both: { CLAUDESTRA_STATE_DIR: dirs.old, FLOKA_STATE_DIR: dirs.old },
    conflict: { CLAUDESTRA_STATE_DIR: dirs.old, FLOKA_STATE_DIR: dirs.neu },
  } as const;
  const expected = (gear: (typeof GEARS)[number], c: keyof typeof cases, home: string): string => {
    const v = cases[c] as Record<string, string>;
    if (gear === "on") return v.FLOKA_STATE_DIR ?? v.CLAUDESTRA_STATE_DIR!;
    return v.CLAUDESTRA_STATE_DIR ?? join(home, ".claude-orchestrator");
  };

  for (const gear of GEARS) {
    for (const c of Object.keys(cases) as (keyof typeof cases)[]) {
      test(`${gear} · ${c}`, () => {
        const r = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: gear, ...cases[c] });
        expect(r.code).toBe(0);
        const want = expected(gear, c, r.home);
        expect(r.out.state).toBe(want);
        expect(r.out.again).toBe(want);
        if (gear === "on") {
          // 过渡期同值双名：进程 env 与子进程启动前缀都带两个名字、同一个值
          expect([r.out.envOld, r.out.envNew]).toEqual([want, want]);
          expect(r.out.override).toMatchObject({ CLAUDESTRA_STATE_DIR: want, FLOKA_STATE_DIR: want, FLOKA_RENAME_ENV: "on" });
        } else {
          expect(r.out.envNew).toBe((cases[c] as Record<string, string>).FLOKA_STATE_DIR);
          expect(Object.keys(r.out.override).filter((k) => k.startsWith("FLOKA_"))).toEqual([]);
        }
        if (gear === "off") expect(r.err).not.toContain("[floka-env]");
        // 日志只有变量名：两个目录值都不出现
        expect(r.err).not.toContain(dirs.old);
        expect(r.err).not.toContain(dirs.neu);
      });
    }
  }

  test("observe 报告新解析候选，冲突时说明 on 档会取新名；解析结果不变", () => {
    const r = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "observe", ...cases.conflict });
    expect(r.out.state).toBe(dirs.old);
    expect(r.err).toContain("observe：与 CLAUDESTRA_STATE_DIR 冲突，on 档取 FLOKA_STATE_DIR");
    expect(r.err.match(/observe：/g)).toHaveLength(1);
  });

  test("on 档只有旧名：告警恰好一次（多次解析不重复）", () => {
    const r = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "on", ...cases.oldOnly });
    expect(r.err.match(/只设了旧名 CLAUDESTRA_STATE_DIR/g)).toHaveLength(1);
  });

  test("on 档冲突：取新名并只记两个变量名", () => {
    const r = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "on", ...cases.conflict });
    expect(r.err).toContain("CLAUDESTRA_STATE_DIR 与 FLOKA_STATE_DIR 不同，取 FLOKA_STATE_DIR");
  });

  test("档位写错按 off", () => {
    const r = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "yes", ...cases.newOnly });
    expect(r.out.state).toBe(join(r.home, ".claude-orchestrator"));
    expect(r.err).toContain("FLOKA_RENAME_ENV 不是 off / observe / on");
  });

  test("运行目录同样按档位：on 新名优先，off 只认旧名", () => {
    const [o, n] = [tmp("floka-env-rt-old-"), tmp("floka-env-rt-new-")];
    expect(child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "on", CLAUDESTRA_RUNTIME_DIR: o, FLOKA_RUNTIME_DIR: n }).out.runtime).toBe(n);
    expect(child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "off", CLAUDESTRA_RUNTIME_DIR: o, FLOKA_RUNTIME_DIR: n }).out.runtime).toBe(o);
  });

  test("普通变量（部署锁令牌）：off / observe 原样，on 新名优先、两名同值；合成秘密不进日志", () => {
    for (const gear of GEARS) {
      const r = child({ FLOKA_RENAME_ENV: gear, CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN: SECRET_A, FLOKA_PM_DEPLOY_LOCK_TOKEN: SECRET_B });
      expect(r.code).toBe(0);
      expect([r.out.tokOld, r.out.tokNew]).toEqual(gear === "on" ? [SECRET_B, SECRET_B] : [SECRET_A, SECRET_B]);
      expect(r.err).not.toContain(SECRET_A);
      expect(r.err).not.toContain(SECRET_B);
    }
    const lone = child({ FLOKA_RENAME_ENV: "off", CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN: SECRET_A });
    expect([lone.out.tokOld, lone.out.tokNew]).toEqual([SECRET_A, undefined]); // off 不往 env 里加新名
  });

  test("on 档运行中只改 / 只删旧名：以旧名为准，不被同步时的新名副本翻回", () => {
    const [a, b] = [tmp("floka-env-run-a-"), tmp("floka-env-run-b-")];
    const set = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "on", CLAUDESTRA_STATE_DIR: a }, `process.env.CLAUDESTRA_STATE_DIR = ${JSON.stringify(b)};`);
    expect(set.out.again).toBe(b);
    const del = child({ ...PROD_LIKE, FLOKA_RENAME_ENV: "on", FLOKA_STATE_DIR: a }, `delete process.env.CLAUDESTRA_STATE_DIR;`);
    expect(del.out.again).toBe(join(del.home, ".claude-orchestrator"));
    expect(set.err + del.err).not.toContain(a);
  });

  test("on 档父子进程：子进程启动处只覆盖 / 删除旧名（pi-acp 前缀、adapter-proc 的 hostEnvBase），子进程拿到的是新值，不还原成父值", () => {
    const home = tmp("floka-env-parent-");
    const probe = [
      `await import(${JSON.stringify(join(LIB, "paths.ts"))});`,
      `const e = process.env, k = ["AGENT", "ACP_RUNTIME", "ACP_AGENT", "PM_DEPLOY_LOCK_TOKEN"];`,
      `console.log(JSON.stringify(Object.fromEntries(k.map((s) => [s, [e["CLAUDESTRA_" + s] ?? null, e["FLOKA_" + s] ?? null]]))));`,
    ].join("\n");
    const parent = [
      `await import(${JSON.stringify(join(LIB, "paths.ts"))});`,
      `const { hostEnvBase } = await import(${JSON.stringify(join(LIB, "acp/adapter-proc.ts"))});`,
      `const last = (r) => JSON.parse(r.stdout.toString().trim().split("\\n").pop());`,
      `const probe = ${JSON.stringify(probe)};`,
      // runtimes/pi-acp.ts 的写法：shell 前缀只带旧名
      `const prefix = Bun.spawnSync(["sh", "-c", 'CLAUDESTRA_AGENT=child CLAUDESTRA_ACP_RUNTIME=pi exec "$0" --no-env-file -e "$1"', process.execPath, probe], { env: process.env, stderr: "pipe" });`,
      // acp/adapter-proc.ts 的写法：拷一份 env、删旧名 CLAUDESTRA_ACP_AGENT，再覆盖旧名
      `const base = { ...hostEnvBase({ base: process.env, logsDir: "/x" }), CLAUDESTRA_AGENT: "child" };`,
      `const adapter = Bun.spawnSync([process.execPath, "--no-env-file", "-e", probe], { env: base, stderr: "pipe" });`,
      `console.log(JSON.stringify({ prefix: last(prefix), adapter: last(adapter), err: prefix.stderr.toString() + adapter.stderr.toString() }));`,
    ].join("\n");
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", parent], {
      env: testChildEnv({ ...PROD_LIKE, HOME: home, FLOKA_RENAME_ENV: "on", CLAUDESTRA_AGENT: "parent", CLAUDESTRA_ACP_RUNTIME: "codex",
        CLAUDESTRA_ACP_AGENT: "codex-acp", FLOKA_PM_DEPLOY_LOCK_TOKEN: SECRET_A }),
      cwd: home, stdout: "pipe", stderr: "pipe",
    });
    expect(r.stderr.toString()).not.toContain("Error");
    expect(r.exitCode).toBe(0);
    const got = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    expect(got.prefix).toEqual({ AGENT: ["child", "child"], ACP_RUNTIME: ["pi", "pi"], ACP_AGENT: ["codex-acp", "codex-acp"], PM_DEPLOY_LOCK_TOKEN: [SECRET_A, SECRET_A] });
    expect(got.adapter).toEqual({ AGENT: ["child", "child"], ACP_RUNTIME: ["codex", "codex"], ACP_AGENT: [null, null], PM_DEPLOY_LOCK_TOKEN: [SECRET_A, SECRET_A] });
    expect(got.err + r.stderr.toString()).not.toContain(SECRET_A);
  });

  test("登记表覆盖规格列的各族，且不生出 BRIDGE / MCP_NAME / RELAY / DISCORD 的同义名", () => {
    for (const s of ["STATE_DIR", "RUNTIME_DIR", "ACP_AGENT", "PI_ARGS", "CODEX_BIN", "CALLER_CRED_FILE", "MCP_PROFILE", "AGENT", "SESSION_ID", "RUNTIME",
      "SANDBOX", "SANDBOX_LAB", "LAB_ROOT", "LAB_RELAY_PORT", "SCHEDULER_SERVICE", "LEND_WORKER", "PM_DEPLOY_LOCK_TOKEN", "TEST"]) expect(RENAMED_SUFFIXES).toContain(s);
    expect(Object.keys(ENV_FAMILIES)).toEqual(expect.arrayContaining(["state-runtime", "acp-pi-codex", "caller", "profile", "agent-session", "sandbox-lab", "scheduler-lend", "deploy-lock", "test"]));
    expect(RENAMED_SUFFIXES.filter((s) => UNBRANDED_STEMS.test(s))).toEqual([]);
    for (const s of ["BRIDGE_URL", "MCP_NAME", "RELAY_URL", "DISCORD_CHANNEL_ID"]) expect(UNBRANDED_STEMS.test(s)).toBe(true);
    expect(new Set(RENAMED_SUFFIXES).size).toBe(RENAMED_SUFFIXES.length);
  });
});

describe("[验收线 2] 隔离闸认两套生产根与端口，不看档位", () => {
  const home = tmp("floka-env-prod-home-");
  const prodOld = join(home, ".claude-orchestrator");
  const prodNew = join(home, ".floka");
  mkdirSync(prodNew);
  const runOld = join(tmp("floka-env-prod-run-"), "claude-orchestrator");
  const runNew = join(runOld, "..", "floka");
  const sbx = tmp("floka-env-sbx-");
  const alias = join(sbx, "alias");
  symlinkSync(prodNew, alias);
  const check = (env: Record<string, string>, stateDir: string, runtimeDir: string) =>
    sandboxDirProblems({ env, stateDir, runtimeDir, defaultStateDir: prodOld, defaultRuntimeDir: runOld });
  const okRun = join(sbx, "run");

  for (const gear of GEARS) {
    test(`${gear}：状态 / 运行目录落在新旧任一生产根（含 realpath 别名）都拒`, () => {
      const base = { FLOKA_RENAME_ENV: gear, CLAUDESTRA_SANDBOX: "1" };
      for (const [state, run] of [[join(prodOld, "s"), okRun], [join(prodNew, "s"), okRun], [join(alias, "s"), okRun], [join(sbx, "state"), join(runNew, "x")]]) {
        const env = { ...base, CLAUDESTRA_STATE_DIR: state!, CLAUDESTRA_RUNTIME_DIR: run! };
        expect(check(env, state!, run!).join("\n")).toContain("重叠");
      }
      expect(check({ ...base, CLAUDESTRA_STATE_DIR: join(sbx, "state"), CLAUDESTRA_RUNTIME_DIR: okRun }, join(sbx, "state"), okRun)).toEqual([]);
    });

    test(`${gear}：生产端口（默认值与新旧两名拒绝清单）都拒`, () => {
      const env = { FLOKA_RENAME_ENV: gear, CLAUDESTRA_SANDBOX: "1", FLOKA_SANDBOX_DENY_PORTS: "4100" };
      expect(() => enforceSandboxBridgeUrl("ws://127.0.0.1:3847", 3847, env)).toThrow("生产端口");
      expect(() => enforceSandboxBridgeUrl("ws://127.0.0.1:4100", 3847, env)).toThrow("生产端口");
      expect(sandboxBridgeEnvProblems(3847, { ...env, BRIDGE_PORT: "4100" }).join()).toContain("是生产端口");
      expect(() => enforceSandboxBridgeUrl("ws://127.0.0.1:4200", 3847, env)).not.toThrow();
    });
  }

  test("只设新名的沙箱开关也认作沙箱；开关冲突拒绝，不选一边", () => {
    expect(isSandbox({ FLOKA_SANDBOX: "1" })).toBe(true);
    expect(() => isSandbox({ CLAUDESTRA_SANDBOX: "1", FLOKA_SANDBOX: "0" })).toThrow("FLOKA_SANDBOX");
    expect(() => isSandbox({ FLOKA_SANDBOX_LAB: "1" })).toThrow("lab 只能和");
  });

  test("沙箱目录变量两名冲突拒绝；只设新名而档位 off 时解析到生产默认值，照样拒", () => {
    const env = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_STATE_DIR: join(sbx, "a"), FLOKA_STATE_DIR: prodOld, CLAUDESTRA_RUNTIME_DIR: okRun };
    expect(check(env, join(sbx, "a"), okRun).join()).toContain("FLOKA_STATE_DIR");
    const off = { CLAUDESTRA_SANDBOX: "1", FLOKA_STATE_DIR: join(sbx, "a"), CLAUDESTRA_RUNTIME_DIR: okRun };
    expect(check(off, prodOld, okRun).join()).toContain("重叠");
  });

  const LAB = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_LAB: "1" };
  for (const gear of GEARS) {
    test(`${gear}：lab 中继端口两名都认（只新名 / 双名一致放行，冲突拒绝），经 lab 实际入口 sandboxRelayUrlProblem`, () => {
      const url = "ws://127.0.0.1:4200";
      expect(sandboxRelayUrlProblem(url, { ...LAB, FLOKA_RENAME_ENV: gear, FLOKA_LAB_RELAY_PORT: "4200" })).toBeNull();
      expect(sandboxRelayUrlProblem(url, { FLOKA_SANDBOX: "1", FLOKA_SANDBOX_LAB: "1", FLOKA_RENAME_ENV: gear, FLOKA_LAB_RELAY_PORT: "4200" })).toBeNull();
      expect(sandboxRelayUrlProblem(url, { ...LAB, FLOKA_RENAME_ENV: gear, CLAUDESTRA_LAB_RELAY_PORT: "4200", FLOKA_LAB_RELAY_PORT: "4200" })).toBeNull();
      expect(sandboxRelayUrlProblem(url, { ...LAB, FLOKA_RENAME_ENV: gear })).toContain("没有 lab 中继");
      const conflict = { ...LAB, FLOKA_RENAME_ENV: gear, CLAUDESTRA_LAB_RELAY_PORT: "4100", FLOKA_LAB_RELAY_PORT: "4200" };
      expect(() => sandboxRelayUrlProblem(url, conflict)).toThrow("FLOKA_LAB_RELAY_PORT");
      expect(() => applyRenamedEnv({ ...conflict })).toThrow("FLOKA_LAB_RELAY_PORT");
    });
  }

  test("on 档只设新名的 lab 中继端口：入口写回旧名，直接读旧名的 lab 代码也看得到", () => {
    const env: Record<string, string | undefined> = { ...LAB, FLOKA_RENAME_ENV: "on", FLOKA_LAB_RELAY_PORT: "4200" };
    applyRenamedEnv(env);
    expect(env.CLAUDESTRA_LAB_RELAY_PORT).toBe("4200");
  });

  test("隔离变量的同步副本：同步后只改旧名取旧名（同 off 档）；只删旧名不算删；没同步过或两边都改了照样冲突拒绝", () => {
    const parent: Record<string, string | undefined> = { FLOKA_RENAME_ENV: "on", CLAUDESTRA_SANDBOX_ROOT: "/sbx/a" };
    applyRenamedEnv(parent);
    expect(parent.FLOKA_SANDBOX_ROOT).toBe("/sbx/a");
    expect(readIsolationEnv("SANDBOX_ROOT", { ...parent, CLAUDESTRA_SANDBOX_ROOT: "/sbx/b" })).toBe("/sbx/b");
    const dropped: Record<string, string | undefined> = { ...parent, CLAUDESTRA_SANDBOX_ROOT: undefined };
    expect(readIsolationEnv("SANDBOX_ROOT", dropped)).toBe("/sbx/a");
    applyRenamedEnv(dropped);
    expect([dropped.CLAUDESTRA_SANDBOX_ROOT, dropped.FLOKA_SANDBOX_ROOT]).toEqual(["/sbx/a", "/sbx/a"]);
    expect(() => readIsolationEnv("SANDBOX_ROOT", { ...parent, CLAUDESTRA_SANDBOX_ROOT: "/sbx/b", FLOKA_SANDBOX_ROOT: "/sbx/c" })).toThrow("FLOKA_SANDBOX_ROOT");
    expect(() => readIsolationEnv("SANDBOX_ROOT", { CLAUDESTRA_SANDBOX_ROOT: "/sbx/b", FLOKA_SANDBOX_ROOT: "/sbx/a" })).toThrow("FLOKA_SANDBOX_ROOT");
    expect(parent.FLOKA_RENAME_ENV_SYNC).not.toContain("/sbx/a"); // 指纹不含值
  });

  test("生产配置里的 FLOKA_ 目录进拒绝清单", () => {
    expect(productionDeny([{ FLOKA_STATE_DIR: "/srv/floka-state" }], { port: 3847, dirs: [] }).dirs).toContain("/srv/floka-state");
  });

  test("沙箱环境：off 逐字节不带新名；on 另出同值新名，且不生出无品牌同义名", () => {
    const opts = { layout: sandboxLayout(sbx), port: 4300, deny: { ports: [3847], dirs: [] } };
    const off = sandboxEnv({ PATH: "/bin" }, opts);
    expect(Object.keys(off).filter((k) => k.startsWith("FLOKA_"))).toEqual([]);
    const on = sandboxEnv({ PATH: "/bin", FLOKA_RENAME_ENV: "on" }, opts);
    expect(on.FLOKA_STATE_DIR).toBe(off.CLAUDESTRA_STATE_DIR!);
    expect(on.FLOKA_SANDBOX).toBe("1");
    expect(Object.keys(on).filter((k) => /^FLOKA_(BRIDGE|MCP_NAME|RELAY|DISCORD)/.test(k))).toEqual([]);
  });

  test("测试标记只剩新名（旧标记与 NODE_ENV 都缺）：非临时状态目录照样换成临时目录", () => {
    const fake = "/floka-env-not-temp/state";
    const r = child({ CLAUDESTRA_TEST: undefined, NODE_ENV: undefined, FLOKA_TEST: "1", CLAUDESTRA_STATE_DIR: fake });
    expect(r.code).toBe(0);
    expect(r.out.state).not.toBe(fake);
    expect(r.out.state.startsWith(fake)).toBe(false);
  });

  for (const gear of GEARS) {
    test(`${gear}：测试进程里新名指向真实目录也换掉，两个名字都改写`, () => {
      const r = child({ FLOKA_RENAME_ENV: gear, FLOKA_STATE_DIR: "/floka-env-not-temp/new" });
      expect(r.code).toBe(0);
      expect(r.out.envNew).not.toContain("floka-env-not-temp");
      expect(r.out.state).not.toContain("floka-env-not-temp");
    });
  }

  test("测试进程的运行目录落在新根（同级的 floka）也换掉", () => {
    const r = child({ FLOKA_RENAME_ENV: "on", FLOKA_RUNTIME_DIR: "/tmp/floka/x" });
    expect(r.code).toBe(0);
    expect(r.out.runtime).not.toContain("/tmp/floka");
  });

  test("测试标记 / 测试进程里的目录两名冲突：拒绝加载", () => {
    const flag = child({ CLAUDESTRA_TEST: "1", FLOKA_TEST: "0" });
    expect(flag.code).not.toBe(0);
    expect(flag.err).toContain("FLOKA_TEST");
    const dir = child({ CLAUDESTRA_STATE_DIR: tmp("floka-env-a-"), FLOKA_STATE_DIR: tmp("floka-env-b-") });
    expect(dir.code).not.toBe(0);
    expect(dir.err).toContain("FLOKA_STATE_DIR");
  });
});

describe("[验收线 3] Node/Jiti 加载、运行中改 env 生效", () => {
  test("state-dir.ts 与 floka-env/ 只依赖 node: 内置", () => {
    const files = [join(LIB, "state-dir.ts"), ...readdirSync(join(LIB, "floka-env")).map((f) => join(LIB, "floka-env", f))];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bfrom\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(spec.startsWith("node:") || /^\.\/(floka-env\/)?[\w-]+\.(ts|js)$/.test(spec)).toBe(true);
      }
    }
  });

  test("在 Node 里经 Jiti 加载 state-dir.ts：每次现算，旧名 / 档位 / 新名运行中改了立即生效", () => {
    const dir = tmp("floka-env-jiti-");
    const script = join(dir, "load.cjs");
    writeFileSync(script, [
      `const { createJiti } = require(${JSON.stringify(resolve(import.meta.dir, "../node_modules/jiti"))});`,
      `const m = createJiti(__filename)(${JSON.stringify(join(LIB, "state-dir.ts"))});`,
      `const e = process.env, out = [];`,
      `e.CLAUDESTRA_STATE_DIR = "/j/old"; out.push(m.stateDir());`,
      `e.FLOKA_STATE_DIR = "/j/new"; out.push(m.stateDir());`,
      `e.FLOKA_RENAME_ENV = "on"; out.push(m.stateDir());`,
      `delete e.FLOKA_STATE_DIR; out.push(m.stateDir());`,
      `console.log(JSON.stringify(out));`,
    ].join("\n"));
    const r = Bun.spawnSync(["node", script], { env: testChildEnv({ HOME: dir }), stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).not.toContain("Error");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString().trim())).toEqual(["/j/old", "/j/old", "/j/new", "/j/old"]);
  });
});
