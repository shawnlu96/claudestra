/** 测试进程的隔离闸（src/lib/test-guard.ts、bridge-url 的测试闸、readDotenvFileSync 的短路、tests/test-env.ts） */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_BRIDGE_PORT, resolveBridgePort, resolveBridgeUrl, testBridgeProblem } from "../src/lib/bridge-url.js";
import { readDotenvFileSync, repoEnvVar } from "../src/lib/env-file.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { assertNoRepoEnvWriteInTest, isRepoEnvFile, isTestProcess, testSafeStateDir } from "../src/lib/test-guard.js";
import { testChildEnv } from "./test-env.ts";

const KEYS = ["BRIDGE_URL", "BRIDGE_PORT", "CLAUDESTRA_SANDBOX", "CLAUDESTRA_STATE_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("认测试进程", () => {
  test("CLAUDESTRA_TEST=1 或 NODE_ENV=test；别的值、生产环境都不算", () => {
    expect([isTestProcess({ CLAUDESTRA_TEST: "1" }), isTestProcess({ NODE_ENV: "test" }), isTestProcess(process.env)]).toEqual([true, true, true]);
    expect([isTestProcess({}), isTestProcess({ CLAUDESTRA_TEST: "0" }), isTestProcess({ NODE_ENV: "production" })]).toEqual([false, false, false]);
  });
});

describe("bridge 地址", () => {
  test("读 process.env 时：没显式配、默认端口、非回环一律抛错；preload 给的死端口照常", () => {
    delete process.env.BRIDGE_URL;
    delete process.env.BRIDGE_PORT;
    expect(() => resolveBridgeUrl()).toThrow("回落到默认端口");
    expect(() => resolveBridgePort()).toThrow("回落到默认端口");
    process.env.BRIDGE_PORT = String(DEFAULT_BRIDGE_PORT);
    expect(() => resolveBridgeUrl()).toThrow("默认端口或仓库 .env 里配的端口");
    process.env.BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
    expect(() => resolveBridgeUrl()).toThrow("默认端口");
    process.env.BRIDGE_URL = "ws://10.0.0.2:9999";
    expect(() => resolveBridgeUrl()).toThrow("不是本机回环");
    process.env.BRIDGE_URL = "ws://127.0.0.1:9";
    process.env.BRIDGE_PORT = "9";
    expect([resolveBridgeUrl(), resolveBridgePort()]).toEqual(["ws://127.0.0.1:9", 9]);
  });

  test("仓库 .env 里配的 bridge / peer 端口也拒（纯函数，repoEnv 显式传）", () => {
    const repoEnv = { BRIDGE_PORT: "13847", PEER_INGRESS_PORT: "13848" };
    expect(testBridgeProblem("ws://localhost:13847", repoEnv)).toContain("仓库 .env");
    expect(testBridgeProblem("ws://127.0.0.1:13848", repoEnv)).toContain("仓库 .env");
    expect(testBridgeProblem("ws://127.0.0.1:23901", repoEnv)).toBeNull();
    expect(testBridgeProblem(null, {})).toContain("回落到默认端口");
  });

  test("显式传 env 参数的调用不受闸（只算地址不连：bridge-url 单测、doctor 按 .env 推端口）", () => {
    expect(resolveBridgeUrl({})).toBe(`ws://localhost:${DEFAULT_BRIDGE_PORT}`);
    expect(resolveBridgePort({ BRIDGE_PORT: String(DEFAULT_BRIDGE_PORT) })).toBe(DEFAULT_BRIDGE_PORT);
  });

  test("沙箱进程归沙箱的闸管（口径不动）：非生产端口放行", () => {
    process.env.CLAUDESTRA_SANDBOX = "1";
    delete process.env.BRIDGE_URL;
    process.env.BRIDGE_PORT = "23901";
    expect(resolveBridgeUrl()).toBe("ws://localhost:23901");
  });
});

describe("仓库 .env", () => {
  test("仓库根的 .env / .env.local / .env.test 认得出，软链路径（/tmp ↔ /private/tmp）也认得出；别的目录、别的文件名不算", () => {
    for (const f of [".env", ".env.local", ".env.test"]) expect(isRepoEnvFile(join(REPO_ROOT, f))).toBe(true);
    expect(isRepoEnvFile(join(REPO_ROOT, ".env.example"))).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "tg-root-"));
    try {
      symlinkSync(dir, `${dir}-link`);
      expect(isRepoEnvFile(join(`${dir}-link`, ".env"), dir)).toBe(true);
      expect(isRepoEnvFile(join(dir, ".env"))).toBe(false);
    } finally {
      rmSync(`${dir}-link`, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("测试进程读仓库根的 .env 一律当没有；测试自己造的临时 repoRoot 照读；repoEnvVar 只剩 process.env", () => {
    expect(readDotenvFileSync(join(REPO_ROOT, ".env"))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "tg-env-"));
    try {
      writeFileSync(join(dir, ".env"), "CONTROL_CHANNEL_ID=from-file\n");
      expect(readDotenvFileSync(join(dir, ".env"))).toEqual({ CONTROL_CHANNEL_ID: "from-file" });
      expect(repoEnvVar("CONTROL_CHANNEL_ID", dir)).toBe("from-file");
      expect(repoEnvVar("CONTROL_CHANNEL_ID")).toBe("");
      // 读闸让仓库 .env 看起来是空的，补键的写入就得一起拦：否则会整份改写线上配置
      expect(() => assertNoRepoEnvWriteInTest(join(REPO_ROOT, ".env"))).toThrow("写仓库根的 .env");
      expect(() => assertNoRepoEnvWriteInTest(join(dir, ".env"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("状态目录", () => {
  test("默认推出来的目录不在临时目录下（真实 ~/.claude-orchestrator）→ 换成临时目录；临时 HOME 下的、显式指定的非默认目录照用", () => {
    const env: Record<string, string | undefined> = { CLAUDESTRA_TEST: "1" };
    const real = "/Users/someone/.claude-orchestrator";
    const got = testSafeStateDir(real, real, env);
    try {
      expect(got).not.toBe(real);
      expect(got.startsWith(tmpdir()) || got.startsWith("/tmp") || got.includes("/var/folders/")).toBe(true);
      expect(env.CLAUDESTRA_STATE_DIR).toBe(got);
    } finally {
      rmSync(got, { recursive: true, force: true });
    }
    const fake = join(tmpdir(), "fakehome", ".claude-orchestrator");
    expect(testSafeStateDir(fake, fake, { CLAUDESTRA_TEST: "1" })).toBe(fake);
    expect(testSafeStateDir("/sbx/state", real, { CLAUDESTRA_TEST: "1" })).toBe("/sbx/state");
    expect(testSafeStateDir(real, real, {})).toBe(real);
  });
});

describe("testChildEnv", () => {
  test("最小 env 带上测试标记与死端口；extra 覆盖，undefined 去掉键；不继承会话里的频道号 / token", () => {
    const env = testChildEnv({ HOME: "/h", LANG: "C", TMPDIR: undefined });
    expect(env).toMatchObject({ CLAUDESTRA_TEST: "1", NODE_ENV: "test", BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9", HOME: "/h", LANG: "C" });
    expect("TMPDIR" in env).toBe(false);
    for (const k of ["DISCORD_CHANNEL_ID", "DISCORD_BOT_TOKEN", "CONTROL_CHANNEL_ID", "CLAUDESTRA_STATE_DIR"]) expect(k in env).toBe(false);
  });

  test("子进程里闸照样生效：去掉 BRIDGE_URL / PORT 后取地址直接抛错", () => {
    const script = `const { resolveBridgeUrl } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/bridge-url.ts"))}); resolveBridgeUrl();`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: testChildEnv({ BRIDGE_URL: undefined, BRIDGE_PORT: undefined }), stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("测试进程");
  });
});
