// 全量测试闸：全量判定、宿主策略、进程树观察、CI 短路、preload 接线、test:gate 命令（docs/architecture/full-test-gate.md）。
// 真实并发与信号在 tests/full-test-gate-run.test.ts。一律用临时 HOME / 临时闸目录，不写真实宿主闸。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBunArgv, classifyTestArgs, readOwnArgv } from "../src/lib/full-test-gate-args.ts";
import {
  approvalVerifier, fullTestGateDir, permitConfig, policyPath, readGatePolicy, writeGatePolicy, type GatePolicy,
} from "../src/lib/full-test-gate-policy.ts";
import { observeTree, readPermitEntries, runLogPath } from "../src/lib/full-test-gate.ts";
import { lendCheckPermit } from "../src/lib/lend-check-permit.ts";

const ROOT = join(import.meta.dir, "..");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "full-gate-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("[验收线 2] 全量判定", () => {
  test("没有位置参数 = 全量；选项的取值不是文件", () => {
    for (const args of [[], ["--timeout", "10000"], ["-t", "name"], ["--timeout=5", "-t", "a b", "--bail"], ["--test-name-pattern", "x.test.ts"],
      ["--coverage", "--rerun-each", "3"], ["--shard=1/8"], ["--bail=2"], ["--preload", "./p.ts"]]) {
      expect(classifyTestArgs(args)).toEqual({ kind: "full", args });
    }
  });

  test("带文件 / 路径 = 聚焦", () => {
    for (const args of [["tests/a.test.ts"], ["--timeout", "100", "tests/"], ["-t", "x", "lend"], ["--bail", "3"]]) {
      expect(classifyTestArgs(args).kind).toBe("focused");
    }
  });

  test("认不出的语法报错，不猜", () => {
    for (const args of [["--frobnicate"], ["-x"], ["--timeout"], ["-t"], ["--only=1"], ["--"]]) {
      expect(classifyTestArgs(args).kind).toBe("error");
    }
  });

  test("整条命令行：test 前只许选项，test 后同上", () => {
    expect(classifyBunArgv(["bun", "test"])).toEqual({ kind: "full", args: [] });
    expect(classifyBunArgv(["bun", "--no-env-file", "test", "-t", "x"])).toEqual({ kind: "full", args: ["--no-env-file", "-t", "x"] });
    expect(classifyBunArgv(["bun", "--env-file=e", "test", "a.test.ts"]).kind).toBe("focused");
    expect(classifyBunArgv(["bun", "test", "--test-worker"]).kind).toBe("worker");
    expect(classifyBunArgv(["bun", "run", "test"]).kind).toBe("error");
    expect(classifyBunArgv(["bun", "x.ts"]).kind).toBe("error");
  });

  test("preload 能读到本进程逐词原样的命令行（process.argv 已被 bun test 改写）", async () => {
    const argv = await readOwnArgv();
    if (process.platform !== "linux" && process.platform !== "darwin") return expect(argv).toBeNull();
    expect(argv).toContain("test");
    expect(classifyBunArgv(argv!).kind).not.toBe("error");
  });
});

describe("宿主策略", () => {
  test("闸目录跟宿主状态根，不跟 CLAUDESTRA_STATE_DIR", () => {
    expect(fullTestGateDir("/h")).toBe("/h/.claude-orchestrator/locks/full-tests");
    expect(process.env.CLAUDESTRA_STATE_DIR).toBeTruthy(); // preload 换成了临时目录
    expect(fullTestGateDir()).not.toContain(process.env.CLAUDESTRA_STATE_DIR!);
  });

  test("[验收线 6] 缺失 / 坏 JSON / 坏值 / on 缺 source 一律 observe，后三种有说明", () => {
    expect(readGatePolicy(root)).toMatchObject({ mode: "observe", max: 2, maxWaitMin: 60, notes: [] });
    writeFileSync(policyPath(root), "{bad");
    expect(readGatePolicy(root)).toMatchObject({ mode: "observe", notes: [expect.stringContaining("按 observe")] });
    writeFileSync(policyPath(root), JSON.stringify({ mode: "on", max: 0, source: "x" }));
    expect(readGatePolicy(root)).toMatchObject({ mode: "observe", notes: [expect.stringContaining("按 observe")] });
    writeGatePolicy(root, { mode: "on", max: 2 });
    expect(readGatePolicy(root)).toMatchObject({ mode: "observe", notes: [expect.stringContaining("缺 source")] });
    writeGatePolicy(root, { mode: "on", max: 3, maxWaitMin: 5, source: "ask_1" });
    expect(readGatePolicy(root)).toEqual({ mode: "on", max: 3, maxWaitMin: 5, source: "ask_1", notes: [] });
  });

  test("批准只认同一份宿主策略里的数字和出处", () => {
    const policy: GatePolicy = { mode: "on", max: 2, maxWaitMin: 60, source: "ask_1", notes: [] };
    const approval = permitConfig(policy).ownerApproval!;
    expect(approvalVerifier(policy)(approval)).toBe(true);
    expect(approvalVerifier(policy)({ ...approval, maxConcurrentFullChecks: 3 })).toBe(false);
    expect(approvalVerifier(policy)({ ...approval, reference: "forged" })).toBe(false);
    expect(permitConfig({ ...policy, mode: "off" })).toEqual({ mode: "off" });
  });
});

describe("进程树观察（bun test 的进程组）", () => {
  const writeTree = (id: string, body: unknown) => {
    mkdirSync(join(root, "trees"), { recursive: true });
    writeFileSync(join(root, "trees", `${id}.json`), JSON.stringify(body));
  };

  test("没记录 = absent（获准后没起进程）；spawning / 坏记录 = unknown（保留名额）", () => {
    expect(observeTree(root, "none")).toBe("absent");
    writeTree("s", { state: "spawning" });
    expect(observeTree(root, "s")).toBe("unknown");
    writeTree("bad", { state: "running" });
    expect(observeTree(root, "bad")).toBe("unknown");
  });

  test("组里还有后代就 present，整组没了才 absent；组长 PID 换了人 = 原来的组已没了", async () => {
    // 组长马上退出、后代 sleep 留在组里：只看组长会误判成已退出
    const child = spawn("/bin/sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    writeTree("t", { state: "running", pgid, start: "old-start" });
    const alive = { kind: "present" as const, process: { pid: pgid, start: "old-start" } };
    expect(observeTree(root, "t", () => ({ kind: "absent" }))).toBe("present");
    expect(observeTree(root, "t", () => alive)).toBe("present");
    expect(observeTree(root, "t", () => ({ kind: "present", process: { pid: pgid, start: "new-start" } }))).toBe("absent");
    process.kill(-pgid, "SIGKILL");
    const deadline = Date.now() + 5000;
    while (observeTree(root, "t", () => ({ kind: "absent" })) !== "absent" && Date.now() < deadline) await Bun.sleep(20);
    expect(observeTree(root, "t", () => ({ kind: "absent" }))).toBe("absent");
  });
});

function env(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env, HOME: home, CI: "", GITHUB_ACTIONS: "", ...extra };
  delete out.CLAUDESTRA_FULL_TEST_PERMIT;
  return out;
}

async function run(argv: string[], opts: { cwd?: string; env: Record<string, string | undefined> }) {
  const p = Bun.spawn(argv, { cwd: opts.cwd ?? ROOT, env: opts.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, all: out + err, code };
}

describe("[验收线 3] CI 短路：不读策略、不碰 permit 库，发现探针输出不变", () => {
  for (const flag of ["CI", "GITHUB_ACTIONS"]) {
    test(`${flag}=true`, async () => {
      const home = join(root, "home");
      mkdirSync(home);
      const e = env(home, { [flag]: "true" });
      const viaScript = await run([process.execPath, "scripts/test.ts", "--shard=99999/99999"], { env: e });
      const direct = await run([process.execPath, "test", "--shard=99999/99999"], { env: e });
      const probe = (s: string) => s.match(/: running 0\/(\d+) test files/)?.[1];
      expect(probe(viaScript.all)).toBeTruthy();
      expect(probe(viaScript.all)).toBe(probe(direct.all));
      expect(viaScript.code).toBe(direct.code);
      expect(viaScript.all).not.toContain("full-test-gate");
      expect(existsSync(join(home, ".claude-orchestrator"))).toBe(false);
    }, 60_000);
  }
});

describe("[验收线 5] 直接 bun test 经 preload 占槽；经 scripts/test.ts 只占一次", () => {
  test("名额被占时直接 bun test 排队，放出后才跑；两条路各登记一次", async () => {
    const home = join(root, "home");
    const proj = join(root, "proj");
    const out = join(root, "seen");
    mkdirSync(home);
    mkdirSync(proj);
    writeFileSync(join(proj, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(join(ROOT, "tests/preload.ts"))}]\n`);
    writeFileSync(join(proj, "x.test.ts"), `import { test } from "bun:test"; import { appendFileSync } from "node:fs";
      test("x", () => appendFileSync(${JSON.stringify(out)}, (process.env.CLAUDESTRA_FULL_TEST_PERMIT ?? "none") + "\\n"));`);
    const dir = fullTestGateDir(home);
    writeGatePolicy(dir, { mode: "on", max: 1, source: "ask_test" });
    // 本进程先占住唯一的名额（不起进程树，释放时没有树记录 = absent）
    const policy = readGatePolicy(dir);
    const deps = { verifyOwnerApproval: approvalVerifier(policy), observeCheckTree: (x: { id: string }) => observeTree(dir, x.id) };
    const holder = (action: "acquire" | "release") => lendCheckPermit({ directory: dir, config: permitConfig(policy), action,
      request: { id: "holder", orderId: "test", workerId: "test", cost: "full" } }, undefined, deps);
    expect(holder("acquire")).toMatchObject({ allowed: true, status: "granted" });

    const direct = run([process.execPath, "test"], { cwd: proj, env: env(home) });
    const log = () => existsSync(runLogPath(dir)) ? readFileSync(runLogPath(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const deadline = Date.now() + 30_000;
    while (!log().some((r) => r.event === "queued") && Date.now() < deadline) await Bun.sleep(50);
    expect(log().some((r) => r.event === "queued")).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect(holder("release")).toMatchObject({ status: "released" });
    const first = await direct;
    expect(first.code).toBe(0);
    expect(first.err).toContain("获准 mode=on max=1");

    const viaScript = await run([process.execPath, join(ROOT, "scripts/test.ts")], { cwd: proj, env: env(home) });
    expect(viaScript.code).toBe(0);
    const seen = readFileSync(out, "utf8").trim().split("\n");
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.startsWith("full-"))).toBe(true);
    expect(log().filter((r) => r.event === "start").map((r) => r.id)).toEqual(seen);
    expect(readPermitEntries(dir)).toEqual([]);

    // 带文件的直接调用：preload 不申请
    const focused = await run([process.execPath, "test", "./x.test.ts"], { cwd: proj, env: env(home) });
    expect(focused.code).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n").at(-1)).toBe("none");
    expect(log().filter((r) => r.event === "start")).toHaveLength(2);
  }, 90_000);
});

describe("test:gate 命令", () => {
  test("set / status 读写宿主闸目录的 policy.json，不跟 CLAUDESTRA_STATE_DIR", async () => {
    const home = join(root, "home");
    mkdirSync(home);
    const e = env(home, { CLAUDESTRA_STATE_DIR: join(root, "elsewhere") });
    const gate = (...args: string[]) => run([process.execPath, "scripts/test-gate.ts", ...args], { env: e });
    expect((await gate("set", "on", "--max", "2")).code).toBe(2);
    expect(existsSync(policyPath(fullTestGateDir(home)))).toBe(false);
    expect((await gate("set", "on", "--max", "2", "--source", "ask_1")).code).toBe(0);
    expect(JSON.parse(readFileSync(policyPath(fullTestGateDir(home)), "utf8"))).toEqual({ mode: "on", max: 2, source: "ask_1" });
    expect((await gate("set", "observe", "--max-wait-min", "30")).code).toBe(0);
    expect(readGatePolicy(fullTestGateDir(home))).toMatchObject({ mode: "observe", max: 2, maxWaitMin: 30, source: "ask_1" });
    expect((await gate("set", "on", "--max", "0", "--source", "x")).code).toBe(2);
    const status = await gate("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("生效策略：mode=observe max=2 maxWaitMin=30 source=ask_1");
    expect(existsSync(join(root, "elsewhere"))).toBe(false);
  }, 30_000);
});
