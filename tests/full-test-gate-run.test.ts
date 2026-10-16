// 全量测试闸的真实并发（src/lib/full-test-gate.ts）：每个申请是独立的驱动进程（runFullTestGate + 临时 permit 目录），
// bun test 换成假的子进程——它把 start / end 写进事件文件，等测试放出 go-<名> 才退出。不碰真实宿主闸目录。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_STARTED_EXIT, readPermitEntries, runLogPath } from "../src/lib/full-test-gate.ts";
import { writeGatePolicy } from "../src/lib/full-test-gate-policy.ts";

const ROOT = join(import.meta.dir, "..");
let root: string;
let dir: string;
const kids: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "full-gate-run-"));
  dir = join(root, "gate");
  writeFileSync(join(root, "fake.ts"), `
    import { appendFileSync, existsSync } from "node:fs";
    const [name] = process.argv.slice(2);
    const log = (what) => appendFileSync(${JSON.stringify(join(root, "events"))}, what + " " + name + " " + Date.now() + "\\n");
    log("start");
    if (process.env.DETACH) {
      // 脱组的后代：系统自带的 sh（macOS 读不到它的环境）、detached（另起一组），等 go-x 才退出
      const { spawn } = await import("node:child_process");
      const loop = "while [ ! -e '${root}/go-x' ] && [ -d '${root}' ]; do sleep 0.05; done";
      if (["chain", "known-chain"].includes(process.env.DETACH)) {
        // 短命的中间一环：脱组的 sh 把末端放到后台、写下它的 PID 就退出，监管进程一次也扫不到它；假 bun test 等它退出后也退出
        const wait = process.env.DETACH === "known-chain" ? "while [ ! -e '${root}/go-mid' ] && [ -d '${root}' ]; do sleep 0.05; done; " : "";
        const mid = spawn("/bin/sh", ["-c", \`\${wait}/bin/sh -c "\${loop}" & echo $! >> '${root}/desc'; exit 0\`], { detached: true, stdio: "ignore" });
        appendFileSync(${JSON.stringify(join(root, "mid"))}, mid.pid + "\\n");
        await new Promise((r) => mid.once("exit", r));
        log("end");
        process.exit(0);
      }
      const d = spawn("/bin/sh", ["-c", loop], { detached: true, stdio: "ignore" });
      d.unref();
      appendFileSync(${JSON.stringify(join(root, "desc"))}, d.pid + "\\n");
      if (process.env.DETACH === "exit") { log("end"); process.exit(0); }
    }
    process.on("SIGTERM", () => { log("term"); process.exit(Number(process.env.TERM_CODE ?? 143)); });
    while (!existsSync(${JSON.stringify(root)} + "/go-" + name)) {
      if (!existsSync(${JSON.stringify(root)})) process.exit(0); // 用例收尾删了临时目录：别留下空转的进程
      await Bun.sleep(20);
    }
    log("end");
    process.exit(Number(process.env.CODE ?? 0));
  `);
  writeFileSync(join(root, "driver.ts"), `
    import { runFullTestGate } from ${JSON.stringify(join(ROOT, "src/lib/full-test-gate.ts"))};
    const [dir, name, ...args] = process.argv.slice(2);
    // 在 spawn 之后第一次扫进程表时把自己 SIGKILL：模拟持有者死在「已起子进程、还没登记进程树」的窗口
    const scan = process.env.KILL_AT_SCAN ? () => { process.kill(process.pid, "SIGKILL"); return null; } : undefined;
    process.exit(await runFullTestGate({ scan, args, command: [process.execPath, ${JSON.stringify(join(root, "fake.ts"))}, name], env: process.env, dir,
      pollMs: 50, noticeMs: Number(process.env.NOTICE_MS ?? 30000), drainMs: Number(process.env.DRAIN_MS ?? 2000),
      orphanGraceMs: process.env.GRACE_MS ? Number(process.env.GRACE_MS) : undefined, minuteMs: Number(process.env.MINUTE_MS ?? 60000) }));
  `);
});

afterEach(() => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const name of ["a", "b", "c", "d", "x"]) writeFileSync(join(root, `go-${name}`), ""); // 放走被 SIGKILL 驱动留下的假 bun test / 后代
  rmSync(root, { recursive: true, force: true });
});

function drive(name: string, args: string[] = [], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, CI: "", GITHUB_ACTIONS: "", ...extra };
  delete env.CLAUDESTRA_FULL_TEST_PERMIT;
  const child = Bun.spawn([process.execPath, join(root, "driver.ts"), dir, name, ...args], { env, stdout: "pipe", stderr: "pipe" });
  kids.push(child);
  return { child, stderr: new Response(child.stderr).text() };
}

type Ev = { what: string; name: string; at: number };
function events(): Ev[] {
  if (!existsSync(join(root, "events"))) return [];
  return readFileSync(join(root, "events"), "utf8").split("\n").filter(Boolean).map((l) => {
    const [what, name, at] = l.split(" ");
    return { what: what!, name: name!, at: Number(at) };
  });
}
const started = () => events().filter((e) => e.what === "start").map((e) => e.name);
function runLog(): Record<string, unknown>[] {
  return existsSync(runLogPath(dir)) ? readFileSync(runLogPath(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}；events=${JSON.stringify(events())}`);
    await Bun.sleep(30);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const descendant = () => Number(readFileSync(join(root, "desc"), "utf8").trim());
const go = (name: string) => writeFileSync(join(root, `go-${name}`), "");
const on = (max: number, extra: object = {}) => writeGatePolicy(dir, { mode: "on", max, source: "ask_test", ...extra });

describe("[验收线 1] on、max=2：第 3 个全量排队，前一个退出后才开始", () => {
  test("off（等同改前）：3 个同时开始", async () => {
    writeGatePolicy(dir, { mode: "off" });
    const runs = ["a", "b", "c"].map((n) => drive(n));
    await until(() => started().length === 3, "3 个都开始");
    for (const n of ["a", "b", "c"]) go(n);
    expect(await Promise.all(runs.map((r) => r.child.exited))).toEqual([0, 0, 0]);
  }, 30_000);

  test("on：同时最多 2 个，第 3 个等到前一个退出", async () => {
    on(2);
    const runs = ["a", "b", "c"].map((n) => drive(n, [], { NOTICE_MS: "100" }));
    await until(() => started().length === 2, "前 2 个开始");
    await Bun.sleep(800);
    expect(started()).toHaveLength(2);
    const waiting = ["a", "b", "c"].find((n) => !started().includes(n))!;
    const first = started()[0]!;
    go(first);
    await until(() => started().length === 3, "第 3 个开始");
    const end = events().find((e) => e.what === "end" && e.name === first)!;
    const late = events().find((e) => e.what === "start" && e.name === waiting)!;
    expect(late.at).toBeGreaterThanOrEqual(end.at);
    for (const n of ["a", "b", "c"]) go(n);
    expect(await Promise.all(runs.map((r) => r.child.exited))).toEqual([0, 0, 0]);
    const queuedErr = await runs[["a", "b", "c"].indexOf(waiting)]!.stderr;
    expect(queuedErr).toMatch(/排队中 mode=on max=2 队列位置=1 已等 \d+s worktree=.+ id=full-/);
    expect(queuedErr).toMatch(/获准 mode=on max=2，等待 \d+s/);
    expect(readPermitEntries(dir)).toEqual([]);
  }, 30_000);
});

describe("[验收线 2] 带文件不排队；认不出的参数报错退出", () => {
  test("名额占满时带文件的调用照样直接跑，不登记", async () => {
    on(1);
    const a = drive("a");
    await until(() => started().includes("a"), "a 开始");
    const b = drive("b", ["tests/x.test.ts", "--timeout", "100"]);
    await until(() => started().includes("b"), "带文件的 b 直接开始");
    go("b");
    expect(await b.child.exited).toBe(0);
    go("a");
    expect(await a.child.exited).toBe(0);
    expect(runLog().filter((r) => r.event === "start").map((r) => r.id)).toHaveLength(1);
  }, 30_000);

  test("只带 --timeout / -t 取值的是全量：名额满时排队", async () => {
    on(1);
    const a = drive("a");
    await until(() => started().includes("a"), "a 开始");
    const b = drive("b", ["--timeout", "10000", "-t", "name"]);
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    expect(started()).toEqual(["a"]);
    go("a");
    await until(() => started().includes("b"), "b 开始");
    go("b");
    expect([await a.child.exited, await b.child.exited]).toEqual([0, 0]);
  }, 30_000);

  test("认不出的参数：退出码 2，测试未启动", async () => {
    on(1);
    const r = drive("a", ["--frobnicate"]);
    expect(await r.child.exited).toBe(2);
    expect(await r.stderr).toContain("测试未启动");
    expect(started()).toEqual([]);
  }, 30_000);
});

describe("[验收线 4] 信号与回收", () => {
  test("排队中 SIGTERM：撤销、不留占位，测试没启动", async () => {
    on(1);
    const a = drive("a");
    await until(() => started().includes("a"), "a 开始");
    const b = drive("b");
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    b.child.kill("SIGTERM");
    expect(await b.child.exited).toBe(143);
    expect(await b.stderr).toContain("测试未启动");
    expect(readPermitEntries(dir)!.map((e) => e.status)).toEqual(["active"]);
    go("a");
    expect(await a.child.exited).toBe(0);
    expect(started()).toEqual(["a"]);
    expect(readPermitEntries(dir)).toEqual([]);
  }, 30_000);

  test("运行中 SIGTERM：转发给 bun test、等它退出、释放，退出码透传", async () => {
    on(1);
    const a = drive("a", [], { TERM_CODE: "42" });
    await until(() => started().includes("a"), "a 开始");
    a.child.kill("SIGTERM");
    expect(await a.child.exited).toBe(42);
    expect(events().some((e) => e.what === "term" && e.name === "a")).toBe(true);
    expect(readPermitEntries(dir)).toEqual([]);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 42, released: true });
  }, 30_000);

  test("持有者被 SIGKILL：假 bun test 还在跑时名额不放，进程树确认没了才回收", async () => {
    on(1);
    const a = drive("a");
    await until(() => started().includes("a"), "a 开始");
    a.child.kill("SIGKILL");
    await a.child.exited;
    const b = drive("b");
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    await Bun.sleep(500);
    expect(started()).toEqual(["a"]);
    go("a");
    await until(() => started().includes("b"), "a 的进程树没了之后 b 开始");
    const end = events().find((e) => e.what === "end" && e.name === "a")!;
    expect(events().find((e) => e.what === "start" && e.name === "b")!.at).toBeGreaterThanOrEqual(end.at);
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);

  test("持有者死在「已起子进程、还没登记进程树」的窗口：测试不启动，名额经进程树确认回收", async () => {
    on(1);
    const a = drive("a", [], { KILL_AT_SCAN: "1" });
    expect(await a.child.exited).toBe(137);
    const tree = JSON.parse(readFileSync(join(dir, "trees", readdirSync(join(dir, "trees"))[0]!), "utf8"));
    expect(tree).toEqual({ state: "spawning" });
    expect(readPermitEntries(dir)!.map((e) => e.status)).toEqual(["active"]);
    const b = drive("b", [], { MINUTE_MS: "3000" });
    await until(() => started().includes("b"), "b 回收 a 的名额后开始");
    go("b");
    expect(await b.child.exited).toBe(0);
    await Bun.sleep(300);
    expect(started()).toEqual(["b"]); // a 的假 bun test 从没启动
  }, 30_000);

  test("脱组后代：bun test 退出后它还在就不释放，它退出后才回收", async () => {
    on(1);
    const a = drive("a", [], { DETACH: "exit" });
    expect(await a.child.exited).toBe(0);
    expect(alive(descendant())).toBe(true);
    expect(await a.stderr).toContain("名额保留");
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 0, released: false });
    expect(readPermitEntries(dir)!.map((e) => e.status)).toEqual(["active"]);
    const b = drive("b");
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    await Bun.sleep(500);
    expect(started()).toEqual(["a"]);
    go("x");
    await until(() => started().includes("b"), "后代退出后 b 开始");
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);

  test("脱组后代、中间一环在第一次扫描前就生灭：末端还在就不释放，它退出后才回收", async () => {
    on(1);
    const a = drive("a", [], { DETACH: "chain" });
    expect(await a.child.exited).toBe(0);
    expect(alive(descendant())).toBe(true);
    expect(await a.stderr).toContain("名额保留");
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 0, released: false });
    expect(readPermitEntries(dir)!.map((e) => e.status)).toEqual(["active"]);
    const b = drive("b");
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    await Bun.sleep(800);
    expect(started()).toEqual(["a"]);
    go("x");
    await until(() => started().includes("b"), "末端退出后 b 开始");
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);

  test("不可归属的短命父节点脱组后代：宽限后释放并说明近似", async () => {
    on(1);
    const a = drive("a", [], { DETACH: "chain", GRACE_MS: "100", DRAIN_MS: "1000" });
    expect(await a.child.exited).toBe(0);
    expect(alive(descendant())).toBe(true);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 0, released: true });
    expect(await a.stderr).toContain("有无法归属的进程仍在，按宽限释放");
    go("x");
  }, 30_000);

  for (const mode of ["1", "known-chain"]) test(`被采样见过的脱组后代活过宽限（${mode}）：下一全量仍排队`, async () => {
    on(1);
    const a = drive("a", [], { DETACH: mode, GRACE_MS: "100", DRAIN_MS: "500" });
    const sampledFile = mode === "known-chain" ? "mid" : "desc";
    await until(() => existsSync(join(root, sampledFile)), "后代已启动");
    const sampledPid = Number(readFileSync(join(root, sampledFile), "utf8").trim());
    await until(() => readdirSync(join(dir, "trees")).some((f) => {
      const t = JSON.parse(readFileSync(join(dir, "trees", f), "utf8"));
      return t.members?.some((m: { pid: number }) => m.pid === sampledPid);
    }), "后代已持久化");
    go("mid");
    go("a");
    expect(await a.child.exited).toBe(0);
    expect(alive(descendant())).toBe(true);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ released: false });
    const b = drive("b", [], { GRACE_MS: "100" });
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    await Bun.sleep(500);
    expect(started()).toEqual(["a"]);
    go("x");
    await until(() => started().includes("b"), "后代退出后 b 开始");
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);

  // 本机别的程序在测试期间起的脱组进程（不来自假 bun test）：进程表上和血缘断了的后代一样认不出归属，只在宽限内扣住名额
  const outsider = async () => {
    const loop = `while [ -d '${root}' ]; do sleep 0.05; done`;
    const sh = Bun.spawn(["/bin/sh", "-c", `/bin/sh -c "${loop}" & echo $! > '${root}/outside'; exit 0`], { stdio: ["ignore", "ignore", "inherit"] });
    expect(await sh.exited).toBe(0);
    const pid = Number(readFileSync(join(root, "outside"), "utf8").trim());
    expect(alive(pid)).toBe(true);
    return pid;
  };

  test("本次测试没有后代、外部独立孤儿仍活着：宽限过后名额照常释放，下一全量启动", async () => {
    on(1);
    const a = drive("a", [], { GRACE_MS: "1000", DRAIN_MS: "5000" });
    await until(() => started().includes("a"), "a 开始");
    await Bun.sleep(800); // 监管进程至少扫到一次
    const pid = await outsider();
    go("a");
    expect(await a.child.exited).toBe(0);
    expect(alive(pid)).toBe(true);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 0, released: true });
    expect(await a.stderr).toContain("不再算作本次测试");
    expect(readPermitEntries(dir)).toEqual([]);
    const b = drive("b");
    await until(() => started().includes("b"), "b 直接开始");
    go("b");
    expect(await b.child.exited).toBe(0);
    expect(alive(pid)).toBe(true);
  }, 30_000);

  test("持有者已退出、只剩外部独立孤儿：下一个申请者在宽限过后回收，不等到 maxWaitMin", async () => {
    on(1, { maxWaitMin: 1 });
    const a = drive("a");
    await until(() => started().includes("a"), "a 开始");
    await Bun.sleep(800);
    const pid = await outsider();
    go("a");
    expect(await a.child.exited).toBe(0);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 0, released: false }); // 默认宽限 60s > drain 2s
    const b = drive("b", [], { GRACE_MS: "1500", MINUTE_MS: "20000" });
    await until(() => started().includes("b"), "宽限过后 b 开始");
    expect(alive(pid)).toBe(true);
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);

  test("脱组后代 + 运行中 SIGTERM：信号也转给它，整树退出后释放", async () => {
    on(1);
    const a = drive("a", [], { DETACH: "1", TERM_CODE: "42" });
    await until(() => started().includes("a") && existsSync(join(root, "desc")), "a 开始、后代起来");
    await Bun.sleep(800); // 等监管进程至少扫到一次
    const d = descendant();
    a.child.kill("SIGTERM");
    expect(await a.child.exited).toBe(42);
    expect(alive(d)).toBe(false);
    expect(readPermitEntries(dir)).toEqual([]);
    expect(runLog().find((r) => r.event === "end")).toMatchObject({ code: 42, released: true });
  }, 30_000);

  test("脱组后代 + 持有者被 SIGKILL：bun test 和后代都退出后才回收", async () => {
    on(1);
    const a = drive("a", [], { DETACH: "1" });
    await until(() => started().includes("a") && existsSync(join(root, "desc")), "a 开始、后代起来");
    a.child.kill("SIGKILL");
    await a.child.exited;
    const b = drive("b");
    await until(() => runLog().some((r) => r.event === "queued"), "b 排队");
    go("a");
    await until(() => events().some((e) => e.what === "end" && e.name === "a"), "a 的假 bun test 退出");
    await Bun.sleep(800);
    expect(started()).toEqual(["a"]);
    expect(alive(descendant())).toBe(true);
    go("x");
    await until(() => started().includes("b"), "后代也退出后 b 开始");
    go("b");
    expect(await b.child.exited).toBe(0);
  }, 30_000);
});

describe("[验收线 6] observe / 缺策略 / 坏文件：不阻塞、有登记", () => {
  for (const [label, setup] of [
    ["策略缺失", () => {}],
    ["坏文件", () => { writeGatePolicy(dir, { mode: "observe" }); writeFileSync(join(dir, "policy.json"), "{bad"); }],
    ["observe", () => writeGatePolicy(dir, { mode: "observe", max: 2 })],
  ] as const) {
    test(label, async () => {
      setup();
      const runs = ["a", "b", "c"].map((n) => drive(n));
      await until(() => started().length === 3, "3 个都开始（不阻塞）");
      for (const n of ["a", "b", "c"]) go(n);
      expect(await Promise.all(runs.map((r) => r.child.exited))).toEqual([0, 0, 0]);
      const starts = runLog().filter((r) => r.event === "start");
      expect(starts).toHaveLength(3);
      expect(starts.every((r) => r.mode === "observe" && typeof r.running === "number" && typeof r.worktree === "string")).toBe(true);
      expect(Math.max(...starts.map((r) => r.wouldQueueAt as number))).toBe(1);
      if (label === "坏文件") expect((await runs[0]!.stderr)).toContain("按 observe 处理");
    }, 30_000);
  }

  test("on 缺 source：按 observe，不阻塞，stderr 说明", async () => {
    writeGatePolicy(dir, { mode: "on", max: 1 });
    const runs = ["a", "b"].map((n) => drive(n));
    await until(() => started().length === 2, "2 个都开始");
    for (const n of ["a", "b"]) go(n);
    expect(await Promise.all(runs.map((r) => r.child.exited))).toEqual([0, 0]);
    expect(await runs[0]!.stderr).toContain("缺 source");
    expect(runLog().filter((r) => r.event === "start").every((r) => r.mode === "observe")).toBe(true);
  }, 30_000);
});

test("[验收线 7] 等超过 maxWaitMin：非零退出、测试未启动、bun test 没被启动", async () => {
  on(1, { maxWaitMin: 1 });
  const a = drive("a");
  await until(() => started().includes("a"), "a 开始");
  const b = drive("b", [], { MINUTE_MS: "600" });
  expect(await b.child.exited).toBe(NOT_STARTED_EXIT);
  expect(await b.stderr).toContain("测试未启动");
  expect(started()).toEqual(["a"]);
  expect(readPermitEntries(dir)!.map((e) => e.status)).toEqual(["active"]);
  expect(runLog().some((r) => r.event === "timeout")).toBe(true);
  go("a");
  expect(await a.child.exited).toBe(0);
}, 30_000);
