// app-server 后代追踪与分层清理（I12、R22、R34、R35）：先用注入的 ps 测分类、持久登记、lstart 核对，再用真进程树测逃逸和环境标记。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePs, type ProcInfo, ProcTree, survivorText } from "../src/lib/acp/codex-adapter/proc-tree.ts";
import { testChildEnv } from "./test-env.ts";

const num = (xs: number[]) => [...xs].sort((a, b) => a - b);
const P = (pid: number, ppid: number, pgid: number, exe = "x", lstart = "Mon Oct  5 10:00:00 2026"): ProcInfo => ({ pid, ppid, pgid, exe, lstart });

/** 注入的进程表：table 可以随时改（模拟崩溃、逃逸、pid 复用） */
function fake(table: ProcInfo[], env: Record<number, ("tree" | "control")[]> = {}, clean = false) {
  const kills: [number, string][] = [];
  const logs: string[] = [];
  const tree = new ProcTree({
    rootPid: 100, treeMark: "T=1", controlMark: "C=1", clean, log: (m) => void logs.push(m),
    ps: async () => table, kill: (t, s) => void kills.push([t, s]), self: { pid: 1, pgid: 1 },
    envMarks: async (pids) => new Map(Object.entries(env).filter(([p]) => !pids || pids.includes(+p)).map(([p, m]) => [+p, new Set(m)])),
  });
  return { tree, kills, logs, table };
}

// Q0-6 的真实形状：npm shim 是组长、原生程序同组；MCP server 和在跑的命令各自成组；命令留下的后台进程改了组
const SHAPE = () => [
  P(100, 50, 100, "node"), P(101, 100, 100, "codex"), P(200, 101, 200, "bun"), P(300, 101, 300, "sleep"),
  P(301, 300, 300, "sh"), P(400, 300, 400, "daemon"), P(900, 1, 900, "other"),
];

describe("分类与清理集合（注入的 ps）", () => {
  test("parsePs：lstart 五段、comm 只留 basename", () => {
    expect(parsePs("  12   1   12 Mon Oct  5 10:00:00 2026 /usr/local/bin/codex app\n bad line\n")).toEqual([P(12, 1, 12, "codex app", "Mon Oct 5 10:00:00 2026")]);
  });

  test("R22(d) 根组 + 根组直接子进程各自的组算 T1；命令留下的改组进程算 T2，普通模式只报告不杀", async () => {
    const f = fake(SHAPE(), { 200: ["tree", "control"], 300: ["tree"], 400: ["tree"] });
    await f.tree.scan();
    f.tree.kill("SIGKILL");
    expect(num(f.kills.map(([t]) => t))).toEqual([-300, -200, -100, 100, 101, 200, 300, 301]);
    const roles = Object.fromEntries((await f.tree.survivors()).map((s) => [s.pid, s.role]));
    expect(roles).toEqual({ 100: "root", 101: "root", 200: "control", 300: "exec", 301: "exec", 400: "app" });
  });

  test("出借 worker（clean）：T2 也清", async () => {
    const f = fake(SHAPE(), { 400: ["tree"] }, true);
    await f.tree.scan();
    f.tree.kill("SIGTERM");
    expect(f.kills.map(([t]) => t)).toContain(400);
    expect(f.kills.map(([t]) => t)).not.toContain(900);
  });

  test("R22(e) 已登记的命令在 app-server 崩溃后成了孤儿（PPID=1）：按登记的身份连同进程组照清，不依赖现在的父子关系", async () => {
    const f = fake(SHAPE());
    await f.tree.scan();
    f.table.splice(0, f.table.length, P(300, 1, 300, "sleep"), P(301, 300, 300, "sh"));
    await f.tree.scan();
    expect(f.tree.alive()).toBe(true);
    f.tree.kill("SIGKILL");
    expect(num(f.kills.map(([t]) => t))).toEqual([-300, 300, 301]);
  });

  test("R22(e) 没来得及登记的命令子进程：只能靠环境标记发现，按「未登记、用途不明」报告，普通模式不杀", async () => {
    const f = fake([P(100, 50, 100, "node")], { 700: ["tree"] });
    await f.tree.scan();
    f.table.splice(0, f.table.length, P(700, 1, 700, "sleep"));
    expect(await f.tree.survivors()).toEqual([{ pid: 700, ppid: 1, pgid: 700, exe: "sleep", role: "app", source: "env" }]);
    f.tree.kill("SIGKILL");
    expect(f.kills).toEqual([]);
  });

  test("R34 带控制标记的进程先逃逸、扫描前就脱离：环境标记认出来，按控制进程清理", async () => {
    const f = fake([P(100, 50, 100, "node"), P(800, 1, 800, "bun")], { 800: ["tree", "control"] });
    await f.tree.survivors();
    f.tree.kill("SIGKILL");
    expect(num(f.kills.map(([t]) => t))).toEqual([-800, -100, 100, 800]);
  });

  test("pid 被复用（lstart 不同）：不杀、不报", async () => {
    const f = fake(SHAPE());
    await f.tree.scan();
    f.table.splice(0, f.table.length, P(300, 1, 300, "vim", "Tue Oct  6 09:00:00 2026"));
    await f.tree.scan();
    expect(f.tree.alive()).toBe(false);
    f.tree.kill("SIGKILL");
    expect(f.kills).toEqual([]);
    expect(await f.tree.survivors()).toEqual([]);
  });

  test("报告只有 pid、ppid、pgid、可执行文件名、角色和来源", () => {
    expect(survivorText({ pid: 1, ppid: 2, pgid: 3, exe: "sleep", role: "app", source: "env" })).toBe("pid=1 ppid=2 pgid=3 exe=sleep role=app source=env");
  });
});

describe("真进程树（R22、R34、R35）", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-proc-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  const bun = process.execPath;
  // 逃逸者：perl fork 出的孙进程 setsid 自成一组、关掉继承的 stdout 后 exec bun（macOS 读不到 Apple 平台二进制如 sleep 的环境，
  // 逃逸者得是第三方程序，环境标记才扫得到）；perl 自己打印孙进程 pid 就退出，孙进程 PPID 变 1
  const ESCAPE = `my $p = fork(); if ($p == 0) { POSIX::setsid(); open(STDOUT, ">", "/dev/null"); exec($ENV{BUN_BIN}, "-e", "await Bun.sleep(30000)"); } print "$p\\n";`;
  // 假 app-server：MCP（带控制标记、自成一组）、在跑的命令（自成一组）、一个逃逸的应用进程、一个逃逸的控制进程
  const root = script("root.ts", `const out = {};
const spawn = (cmd, env) => Bun.spawn(cmd, { detached: true, stdout: "pipe", stdin: "ignore", env: { ...process.env, ...env } });
const escape = ["perl", "-MPOSIX", "-e", process.env.ESCAPE];
out.mcp = spawn(["sleep", "30"], { CLAUDESTRA_ACP_CONTROL: process.env.MARK }).pid;
out.cmd = spawn(["sleep", "30"], {}).pid;
const read = async (p) => Number((await new Response(p.stdout).text()).trim());
out.app = await read(spawn(escape, {}));
out.ctl = await read(spawn(escape, { CLAUDESTRA_ACP_CONTROL: process.env.MARK }));
console.log(JSON.stringify(out));
await Bun.sleep(30000);`);
  const alive = (pid: number) => {
    const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return r.exitCode === 0 && !String(r.stdout).trim().startsWith("Z");
  };

  async function build(id: string) {
    const env = testChildEnv({ CLAUDESTRA_ACP_TREE: id, MARK: id, FAKE_SECRET: "s3cr3t-value", ESCAPE, BUN_BIN: bun });
    const proc = Bun.spawn([bun, root], { detached: true, stdout: "pipe", stdin: "ignore", env });
    const reader = proc.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    return { proc, pids: JSON.parse(first) as { mcp: number; cmd: number; app: number; ctl: number } };
  }

  for (const clean of [false, true]) {
    test(`R22(b)(d) R34 R35 ${clean ? "出借 worker" : "普通模式"}：根组、MCP、命令和逃逸的控制进程都清掉；逃逸的应用进程${clean ? "也清掉" : "只报告、保留"}；日志没有环境变量`, async () => {
      const id = `t-${clean}-${Date.now()}`;
      const { proc, pids } = await build(id);
      const logs: string[] = [];
      const tree = new ProcTree({ rootPid: proc.pid, treeMark: `CLAUDESTRA_ACP_TREE=${id}`, controlMark: `CLAUDESTRA_ACP_CONTROL=${id}`, clean, log: (m) => void logs.push(m) });
      try {
        await tree.scan();
        await tree.survivors();
        tree.kill("SIGTERM");
        await Bun.sleep(300);
        await tree.scan();
        tree.kill("SIGKILL");
        const t1 = [proc.pid, pids.mcp, pids.cmd, pids.ctl];
        for (let i = 0; i < 100 && t1.some(alive); i++) await Bun.sleep(50); // 机器忙时信号送达、回收都慢
        const names = { [proc.pid]: "root", [pids.mcp]: "mcp", [pids.cmd]: "cmd", [pids.ctl]: "ctl" };
        expect(t1.filter(alive).map((p) => names[p])).toEqual([]);
        expect(alive(pids.app)).toBe(!clean);
        const report = (await tree.survivors()).map(survivorText);
        expect(report.some((l) => l.startsWith(`pid=${pids.app} `) && l.includes("role=app"))).toBe(!clean);
        expect(JSON.stringify([logs, report])).not.toContain("s3cr3t-value");
        expect(JSON.stringify([logs, report])).not.toContain("FAKE_SECRET");
      } finally {
        for (const p of [proc.pid, pids.mcp, pids.cmd, pids.ctl, pids.app]) {
          try {
            process.kill(p, "SIGKILL");
          } catch {
            /* 已经被清掉了：正是这个用例要的结果 */
          }
        }
      }
    }, 60_000);
  }
});
