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
import { identify, liveTree, scanProcesses, type Proc, type TreeRoot } from "../src/lib/full-test-gate-tree.ts";
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

describe("进程树观察（进程组 + 脱组后代）", () => {
  const writeTree = (id: string, body: unknown) => {
    mkdirSync(join(root, "trees"), { recursive: true });
    writeFileSync(join(root, "trees", `${id}.json`), JSON.stringify(body));
  };
  const running = (t: TreeRoot) => ({ state: "running", ...t });
  const proc = (pid: number, extra: Partial<Proc> = {}): Proc => ({ pid, ppid: 1, pgid: pid, start: `s${pid}`, uid: null, uniq: null, puniq: null,
    ver: null, opv: null, ...extra });

  test("没记录 = absent；spawning = absent（放行行没发出，测试没开始也不会开始）；坏记录 / 读不出进程表 = unknown", () => {
    expect(observeTree(root, "none")).toBe("absent");
    writeTree("s", { state: "spawning" });
    expect(observeTree(root, "s", () => { throw new Error("spawning 不该扫进程表"); })).toBe("absent");
    writeTree("bad", { state: "running", pgid: 5 });
    expect(observeTree(root, "bad")).toBe("unknown");
    writeTree("t", running({ pgid: 100, start: "s100", uniq: null, ver: null, uid: null, members: [] }));
    expect(observeTree(root, "t", () => null)).toBe("unknown");
    expect(observeTree(root, "t", () => [proc(7)])).toBe("absent");
    expect(observeTree(root, "t", () => [proc(7), proc(101, { pgid: 100 })])).toBe("present");
  });

  test("成员：根、登记过的成员、根的进程组；组长 PID 换了人 = 原来的组已没了", () => {
    const tree: TreeRoot = { pgid: 100, start: "s100", uniq: null, ver: null, uid: null, members: [{ pid: 300, start: "s300", uniq: null, ver: null }] };
    const pids = (procs: Proc[]) => liveTree(tree, "id", procs, () => null).members.map((p) => p.pid).sort();
    expect(pids([proc(100), proc(101, { pgid: 100 }), proc(300), proc(400)])).toEqual([100, 101, 300]);
    expect(pids([proc(300, { start: "reused" })])).toEqual([]); // 登记过的 PID 换了人
    expect(pids([proc(100, { start: "other" }), proc(101, { pgid: 100 })])).toEqual([]);
  });

  test("脱组后代：macOS 按原始父进程唯一 ID、Linux 按父 PID、两边都认环境标记", () => {
    const tree: TreeRoot = { pgid: 100, start: "s100", uniq: "1000", ver: null, uid: null, members: [{ pid: 200, start: "s200", uniq: "2000", ver: null }] };
    const marker = (pids: number[]) => (pid: number) => (pids.includes(pid) ? ["A=1", "CLAUDESTRA_FULL_TEST_PERMIT=id"] : ["A=1"]);
    const pids = (procs: Proc[], env = marker([])) => liveTree(tree, "id", procs, env).members.map((p) => p.pid).sort();
    // 根和登记过的 200 都已退出：200 的孩子（ppid=1，另一组）和孙子照样认得出
    expect(pids([proc(201, { uniq: "2001", puniq: "2000" }), proc(202, { uniq: "2002", puniq: "2001" }), proc(9, { uniq: "2003", puniq: "5" })]))
      .toEqual([201, 202]);
    // Linux：父 PID 是活成员
    expect(pids([proc(200), proc(210, { ppid: 200 }), proc(211, { ppid: 210 })])).toEqual([200, 210, 211]);
    // 环境标记：认不出父进程的孤儿（macOS 只看根之后被过继的，见下一条）
    expect(pids([proc(500, { uniq: "1500", puniq: "7" }), proc(501, { uniq: "1501", puniq: "1500" })], marker([500]))).toEqual([500, 501]);
    expect(pids([proc(700)], marker([700]))).toEqual([700]);
    expect(pids([proc(700)], marker([]))).toEqual([]);
  });

  test("macOS：按原始父进程 PID 版本号认（过继后不变）；血缘断了、环境读不到的孤儿记作 unclaimed，整树按还在算", () => {
    // 根 ver=1000（已退出），登记过的成员 200（ver=1010，已退出）；版本号全机递增
    const tree: TreeRoot = { pgid: 100, start: "s100", uniq: "1", ver: 1000, uid: 501, members: [{ pid: 200, start: "s200", uniq: "2", ver: 1010 }] };
    const marked = (pids: number[]) => (pid: number) => (pids.includes(pid) ? ["A=1", "CLAUDESTRA_FULL_TEST_PERMIT=id"] : pid === 77 ? ["A=1"] : []);
    const orphan = (pid: number, ver: number, opv: number, extra: Partial<Proc> = {}) => proc(pid, { uid: 501, ver, opv, puniq: "1", ...extra });
    const live = (procs: Proc[], env = marked([])) => {
      const t = liveTree(tree, "id", procs, env);
      return { members: t.members.map((p) => p.pid).sort(), unclaimed: t.unclaimed.map((p) => p.pid).sort() };
    };
    // 过继后 p_puniqueid 被改成 launchd 的 1：按原始父进程版本号照样认出 200 的孩子、孙子
    expect(live([orphan(201, 1011, 1010), orphan(202, 1012, 1011, { ppid: 201 })])).toEqual({ members: [201, 202], unclaimed: [] });
    // 中间一环（ver=1020）没被扫到就退出了：末端认不出，环境读不到 → unclaimed；observeTree 按 present
    expect(live([orphan(300, 1021, 1020)])).toEqual({ members: [], unclaimed: [300] });
    writeTree("v", running(tree));
    expect(observeTree(root, "v", () => [orphan(300, 1021, 1020)])).toBe("present");
    expect(observeTree(root, "v", () => [orphan(301, 990, 980)])).toBe("absent");
    // 只剩 unclaimed：从第一次看到（quietAt 落盘）起只在宽限内算 present，过了按 absent（它可能是本机别的程序）
    expect(JSON.parse(readFileSync(join(root, "trees", "v.json"), "utf8")).quietAt).toBeNumber();
    writeTree("q", running({ ...tree, quietAt: Date.now() - 61_000 }));
    expect(observeTree(root, "q", () => [orphan(300, 1021, 1020)])).toBe("absent");
    expect(observeTree(root, "q", () => [orphan(300, 1021, 1020)], 120_000)).toBe("present");
    // 认得出的成员还在：不受宽限影响
    expect(observeTree(root, "q", () => [orphan(201, 1011, 1010), orphan(300, 1021, 1020)])).toBe("present");
    // 环境里有本次标记 = 成员；读得到环境、没标记 = 外人
    expect(live([orphan(300, 1021, 1020)], marked([300]))).toEqual({ members: [300], unclaimed: [] });
    expect(live([orphan(77, 1021, 1020)])).toEqual({ members: [], unclaimed: [] });
    // 不算：根之前就有的原始父进程、launchd 直接起的（原始父进程是 launchd，版本号很小）、别的用户、父进程还是原来那个（唯一 ID 对得上；它 exec 过、版本号变了也一样）
    expect(live([orphan(400, 1030, 990), orphan(401, 1031, 613), orphan(402, 1032, 1025, { uid: 0 }),
      proc(403, { uid: 501, ver: 1040, opv: 1039, ppid: 404, puniq: "u404" }), proc(404, { uid: 501, ver: 1041, opv: 900, uniq: "u404" })])).toEqual({ members: [], unclaimed: [] });
    // 版本号是 int32，回绕后仍按差值比
    const wrapped: TreeRoot = { ...tree, ver: 2147483600, members: [] };
    expect(liveTree(wrapped, "id", [orphan(500, -2147483600, -2147483640)], () => null).unclaimed.map((p) => p.pid)).toEqual([500]);
  });

  test("真实进程：bun test 换组生出的后代在根退出、被过继之后仍算在树里，退出后才 absent", async () => {
    const id = `full-test-${process.pid}-${Date.now()}`;
    // 根（独立进程组）生一个 detached 的系统程序 sleep 后马上退出：sleep 另起一组、被过继给 init / launchd
    const rootChild = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const c = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`],
    { detached: true, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CLAUDESTRA_FULL_TEST_PERMIT: id } });
    let self = identify(rootChild.pid!);
    while (!self) { await Bun.sleep(5); self = identify(rootChild.pid!); } // 刚 spawn、还在 exec 的那一下读不到
    let out = "";
    rootChild.stdout!.on("data", (d) => { out += d; });
    await new Promise((r) => rootChild.once("close", r)); // close：stdout 读完了（exit 可能先到）
    const sleeper = Number(out.trim());
    expect(sleeper).toBeGreaterThan(1); // 0 会让下面的 kill 打到整个进程组
    try {
      writeTree(id, running({ pgid: rootChild.pid!, start: self.start, uniq: self.uniq, ver: self.ver, uid: self.uid, members: [] }));
      expect(scanProcesses()!.find((p) => p.pid === sleeper)!.pgid).not.toBe(rootChild.pid);
      expect(observeTree(root, id)).toBe("present");
    } finally {
      process.kill(sleeper, "SIGKILL");
    }
    const deadline = Date.now() + 5000;
    while (observeTree(root, id) !== "absent" && Date.now() < deadline) await Bun.sleep(20);
    expect(observeTree(root, id)).toBe("absent");
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
