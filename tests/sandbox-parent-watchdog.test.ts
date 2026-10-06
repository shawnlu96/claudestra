/**
 * 沙箱 bridge 父进程看门狗（lib/sandbox-parent-watchdog.ts）：启动方被 SIGKILL 后几秒内退出；主线程卡死时照样收得掉；
 * 显式给的启动方活着时直接父进程退了也不误退；非沙箱不启用。最后一段用真的 scripts/sandbox.ts up 起沙箱 bridge。
 * 每个用例结束都确认起过的进程已退出，不留孤儿。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { SANDBOX_PARENT_PID_ENV, startSandboxParentWatchdog, watchdogOwner } from "../src/lib/sandbox-parent-watchdog.ts";
import { pidAlive, startSandbox } from "./sandbox-isolation-start-fixture.ts";
import { testChildEnv } from "./test-env.ts";
import { DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.ts";

const REPO = resolve(import.meta.dir, "..");
const BUN = process.execPath;
const MODULE = join(REPO, "src", "lib", "sandbox-parent-watchdog.ts");
const SB = { CLAUDESTRA_SANDBOX: "1" };

describe("watchdogOwner", () => {
  test("非沙箱一律不启用，环境变量给了也不管", () => {
    expect(watchdogOwner({}, 4242)).toBeNull();
    expect(watchdogOwner({ [SANDBOX_PARENT_PID_ENV]: "4242" }, 4242)).toBeNull();
    expect(startSandboxParentWatchdog({ env: {} })).toBeNull();
  });
  test("沙箱：显式 pid 优先；没给看 ppid；0 = 关；ppid 已是 1 没法看；乱写拒绝", () => {
    expect(watchdogOwner({ ...SB, [SANDBOX_PARENT_PID_ENV]: " 4242 " }, 77)).toEqual({ pid: 4242, explicit: true });
    expect(watchdogOwner(SB, 77)).toEqual({ pid: 77, explicit: false });
    expect(watchdogOwner({ ...SB, [SANDBOX_PARENT_PID_ENV]: "0" }, 77)).toBeNull();
    expect(watchdogOwner(SB, 1)).toBeNull();
    for (const bad of ["abc", "1", "-5", "12x"]) expect(() => watchdogOwner({ ...SB, [SANDBOX_PARENT_PID_ENV]: bad }, 77)).toThrow(bad);
  });
});

/** 被看门的进程：起看门狗（短间隔），装 SIGTERM 监听；stuck = 之后主线程死循环（信号处理与主线程定时器都跑不到） */
const childCode = (stuck: boolean) => `
import { writeSync } from "fs";
import { startSandboxParentWatchdog } from ${JSON.stringify(MODULE)};
const w = startSandboxParentWatchdog({ everyMs: 100, graceMs: 800 });
if (!w) { writeSync(1, "off\\n"); process.exit(3); }
await new Promise((r) => w.addEventListener("open", r));
process.on("SIGTERM", () => { writeSync(2, "child got SIGTERM\\n"); process.exit(0); });
writeSync(1, "ready\\n");
${stuck ? "for (;;) {}" : "setInterval(() => {}, 1000);"}
`;
const childArgv = (stuck: boolean) => [BUN, "--no-env-file", "-e", childCode(stuck)];
/** 中间父进程：起被看门的进程后报它的 pid，自己一直等着（测试 SIGKILL 它） */
const middleCode = (stuck: boolean) =>
  `const c = Bun.spawn(${JSON.stringify(childArgv(stuck))}, { stdio: ["ignore", "inherit", "inherit"] });
require("fs").writeSync(1, "child " + c.pid + "\\n"); await c.exited;`;

const live: number[] = [];
afterEach(async () => {
  for (const p of live.splice(0)) if (pidAlive(p)) process.kill(p, "SIGKILL");
  await Bun.sleep(50);
});

/** 读一路输出，直到文本匹配 re（ms 内），返回累计文本 */
function collector(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  void (async () => {
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += new TextDecoder().decode(r.value);
  })();
  return {
    text: () => text,
    until: async (re: RegExp, ms: number) => {
      for (const end = Date.now() + ms; !re.test(text); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`等不到 ${re}：${text}`);
      return text;
    },
  };
}

async function goneWithin(pid: number, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (pidAlive(pid)) {
    if (Date.now() - t0 > ms) return null;
    await Bun.sleep(20);
  }
  return Date.now() - t0;
}

/** 起中间父进程 → 被看门的进程；返回两者 pid 与输出 */
async function launch(stuck: boolean, extra: Record<string, string> = {}) {
  const middle = Bun.spawn([BUN, "--no-env-file", "-e", middleCode(stuck)], { env: testChildEnv({ ...SB, ...extra }), stdout: "pipe", stderr: "pipe" });
  live.push(middle.pid);
  const out = collector(middle.stdout);
  const err = collector(middle.stderr);
  const child = Number(/child (\d+)/.exec(await out.until(/child \d+/, 10_000))![1]);
  live.push(child);
  await out.until(/ready/, 10_000);
  return { middle, child, out, err };
}

describe("看门狗进程行为", () => {
  test("父进程活着不误退；SIGKILL 中间父进程后走 SIGTERM 正常关停，几秒内退出", async () => {
    const { middle, child, err } = await launch(false);
    await Bun.sleep(700); // 7 个检查周期
    expect(pidAlive(child)).toBe(true);
    process.kill(middle.pid, "SIGKILL");
    expect(await goneWithin(child, 3_000)).not.toBeNull();
    await err.until(/child got SIGTERM/, 2_000);
    expect(err.text()).toContain("沙箱看门狗：启动方");
  }, 30_000);

  test("主线程卡死（SIGTERM 处理跑不到）：宽限期过后 SIGKILL 硬退出，不会挂住", async () => {
    const { middle, child, err } = await launch(true);
    process.kill(middle.pid, "SIGKILL");
    expect(await goneWithin(child, 3_000)).not.toBeNull();
    expect(err.text()).toContain("沙箱看门狗：启动方");
    expect(err.text()).not.toContain("child got SIGTERM");
  }, 30_000);

  test("显式给的启动方活着时，直接父进程退了也不退（scripts/sandbox.ts up 的情形）；启动方一死就退", async () => {
    const owner = Bun.spawn(["sleep", "60"]);
    live.push(owner.pid);
    const { middle, child } = await launch(false, { [SANDBOX_PARENT_PID_ENV]: String(owner.pid) });
    process.kill(middle.pid, "SIGKILL");
    await Bun.sleep(700);
    expect(pidAlive(child)).toBe(true);
    owner.kill("SIGKILL");
    expect(await goneWithin(child, 3_000)).not.toBeNull();
  }, 30_000);

  test("非沙箱：不起看门狗", async () => {
    const p = Bun.spawn(childArgv(false), { env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
    live.push(p.pid);
    expect(await p.exited).toBe(3);
    expect(await new Response(p.stdout).text()).toBe("off\n");
  }, 30_000);
});

describe("真的沙箱 bridge", () => {
  test("经 scripts/sandbox.ts up 起、启动方被 SIGKILL 后几秒内退出", async () => {
    const tmp = mkdtempSync("/tmp/sbxw-"); // 短路径：unix socket 上限 104 字节
    const [home, shim, root] = [join(tmp, "home"), join(tmp, "shim"), join(tmp, "sbx")];
    mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
    mkdirSync(shim);
    for (const n of ["launchctl", "codex", "npm", "curl", "open", "osascript", "tailscale", "claude", "pi"]) {
      writeFileSync(join(shim, n), "#!/bin/sh\nexit 1\n");
      chmodSync(join(shim, n), 0o755);
    }
    const owner = Bun.spawn(["sleep", "120"]);
    live.push(owner.pid);
    const env = () => testChildEnv({
      PATH: `${shim}:${process.env.PATH}`, HOME: home, TMPDIR: tmp, LANG: "en_US.UTF-8", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      [SANDBOX_PARENT_PID_ENV]: String(owner.pid),
    });
    const argv = (sub: "up" | "down", p: number) => [BUN, join(REPO, "scripts", "sandbox.ts"), sub, "--port", String(p), "--root", root];
    let port = 0;
    try {
      const up = await startSandbox({ root, argv, env, cwd: REPO, deadline: Date.now() + 40_000, avoid: [DEFAULT_BRIDGE_PORT] });
      port = up.port;
      live.push(up.pid);
      await Bun.sleep(2_500); // 比检查间隔（2s）长：up 的脚本已退出、bridge 被收养，启动方还活着就不能退
      expect(pidAlive(up.pid)).toBe(true);
      owner.kill("SIGKILL");
      expect(await goneWithin(up.pid, 10_000)).not.toBeNull();
      expect(readFileSync(join(root, "bridge.log"), "utf8")).toContain("沙箱看门狗：启动方");
    } finally {
      if (port && existsSync(root)) Bun.spawnSync(argv("down", port), { cwd: REPO, env: env(), stdout: "pipe", stderr: "pipe" }); // 关沙箱 tmux
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});
