/**
 * 同步 fs 追踪开关（src/lib/sync-fs-trace.ts）：默认不装；开了以后慢调用 / 慢构造 / 事件循环卡顿各记一行。
 * 单测用注入的假 fs / 假时钟，不动本进程真的 node:fs；最后一条起子进程走 --preload，锁住「静态具名导入也被追到」这个前提。
 */
import { describe, test, expect } from "bun:test";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSyncFsTrace, type TraceDeps } from "../src/lib/sync-fs-trace.ts";

const ON = { CLAUDESTRA_SYNC_FS_TRACE: "1" };

function fakeDeps() {
  let clock = 0;
  const lines: string[] = [];
  const ticks: (() => void)[] = [];
  class Database { constructor(public file: string) { clock += 1200; } }
  const deps: TraceDeps = {
    fs: {
      readFileSync: (p: string, cost = 1500) => { clock += cost; return `content of ${p}`; },
      openSync: () => { clock += 2000; throw Object.assign(new Error("EINTR"), { code: "EINTR" }); },
      realpathSync: Object.assign((p: string) => { clock += 5000; return p; }, { native: (p: string) => { clock += 5000; return p; } }),
      notAnFsSyncApi: () => { clock += 9000; },
    },
    sqlite: { Database },
    warn: (l) => lines.push(l),
    now: () => clock,
    every: (fn) => ticks.push(fn),
  };
  return { deps, lines, ticks, Database, advance: (ms: number) => { clock += ms; } };
}

describe("installSyncFsTrace", () => {
  test("开关没开：什么都不装（同一个函数对象、不打点、不出声）", () => {
    const { deps, lines, ticks } = fakeDeps();
    const before = deps.fs.readFileSync;
    for (const env of [{}, { CLAUDESTRA_SYNC_FS_TRACE: "0" }, { CLAUDESTRA_SYNC_FS_TRACE: "true" }]) expect(installSyncFsTrace(env, deps)).toBe(false);
    expect(deps.fs.readFileSync).toBe(before);
    expect(lines).toEqual([]);
    expect(ticks).toEqual([]);
  });

  test("慢于 1s 的同步调用记一行：名字、路径、耗时、调用方的栈；返回值原样；快的不记", () => {
    const { deps, lines } = fakeDeps();
    expect(installSyncFsTrace(ON, deps)).toBe(true);
    lines.length = 0; // 去掉「已开启」那行
    const read = deps.fs.readFileSync as (p: string, cost?: number) => string;
    expect(read("/fast", 10)).toBe("content of /fast");
    expect(lines).toEqual([]);
    expect(read("/Users/u/Documents/x")).toBe("content of /Users/u/Documents/x");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('readFileSync("/Users/u/Documents/x") 1500ms @ ');
    expect(lines[0]).toContain("sync-fs-trace.test.ts");
    expect(lines[0]).not.toContain("\n");
  });

  test("抛错的慢调用照样记，错误原样抛给调用方；realpathSync.native 也套上；名单外的函数不碰", () => {
    const { deps, lines } = fakeDeps();
    const other = deps.fs.notAnFsSyncApi;
    installSyncFsTrace(ON, deps);
    lines.length = 0;
    expect(() => (deps.fs.openSync as (p: number) => void)(7)).toThrow("EINTR");
    expect(lines[0]).toContain("openSync(fd 7) 2000ms");
    (deps.fs.realpathSync as { native: (p: string) => string }).native("/d");
    expect(lines[1]).toContain('realpathSync.native("/d") 5000ms');
    expect(deps.fs.notAnFsSyncApi).toBe(other);
  });

  test("new Database 慢于 1s 记一行，实例还是原来那个类的", () => {
    const { deps, lines, Database } = fakeDeps();
    installSyncFsTrace(ON, deps);
    lines.length = 0;
    const db = new (deps.sqlite.Database as typeof Database)("/state/ledger.db");
    expect(db).toBeInstanceOf(Database);
    expect(db.file).toBe("/state/ledger.db");
    expect(lines[0]).toContain('new Database("/state/ledger.db") 1200ms');
  });

  test("事件循环卡顿：每 500ms 打点，偏差超过 2s 才记", () => {
    const { deps, lines, ticks, advance } = fakeDeps();
    installSyncFsTrace(ON, deps);
    lines.length = 0;
    expect(ticks).toHaveLength(1);
    advance(500); ticks[0]();
    advance(2400); ticks[0](); // 偏差 1900ms：不记
    expect(lines).toEqual([]);
    advance(15_500); ticks[0]();
    expect(lines).toEqual(["⏱ [sync-fs-trace] 事件循环卡了 15000ms（每 500ms 打点）"]);
  });

  test("bunfig.toml 顶层 preload 指向的文件都在（缺一个，仓库根目录下所有 bun 进程都起不来）", () => {
    const bunfig = readFileSync(resolve(import.meta.dir, "../bunfig.toml"), "utf8");
    const top = bunfig.split(/^\[/m)[0];
    const paths = [...top.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toContain("./src/lib/sync-fs-trace.ts");
    for (const p of paths) expect(existsSync(resolve(import.meta.dir, "..", p))).toBe(true);
  });
});

describe("真进程：preload 装上后，静态具名导入的 fs 也被追到", () => {
  test("开关会被子进程继承：默认 spawn（不传 env）拿到的是 1，父进程自己也没把它删掉；启动行写明这一点", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-fs-trace-env-"));
    const script = join(dir, "spawn.ts");
    try {
      const src = [
        `const child = Bun.spawnSync(["/bin/sh", "-c", "printf %s \\"$CLAUDESTRA_SYNC_FS_TRACE\\""]).stdout.toString();`,
        `console.log(JSON.stringify({ parent: process.env.CLAUDESTRA_SYNC_FS_TRACE ?? null, child }));`,
      ];
      writeFileSync(script, src.join("\n") + "\n");
      const env = { ...process.env, CLAUDESTRA_SYNC_FS_TRACE: "1" };
      const proc = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../src/lib/sync-fs-trace.ts"), script], { env, stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ parent: "1", child: "1" });
      expect(await new Response(proc.stderr).text()).toContain("子进程会继承本开关");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("open 一个没人写的 FIFO 卡 1.5s → stderr 一行带路径和调用方", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-fs-trace-"));
    const fifo = join(dir, "pipe");
    const script = join(dir, "slow.ts");
    try {
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // slowRead 不能写成尾调用（return readFileSync(...)）：JSC 会把这一帧省掉
      const src = [`import { readFileSync } from "node:fs";`, `export function slowRead() { return readFileSync(${JSON.stringify(fifo)}, "utf8").length; }`, "slowRead();"];
      writeFileSync(script, src.join("\n") + "\n");
      const env = { ...process.env, CLAUDESTRA_SYNC_FS_TRACE: "1" };
      const child = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../src/lib/sync-fs-trace.ts"), script], { env, stderr: "pipe" });
      await Bun.sleep(1500);
      const w = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); // 有人写了，子进程的 open 才返回；子进程没在等就 ENXIO，不会挂住
      writeSync(w, "x");
      closeSync(w);
      expect(await child.exited).toBe(0);
      const err = await new Response(child.stderr).text();
      expect(err).toContain("已开启");
      const line = err.split("\n").find((l) => l.includes(`readFileSync(${JSON.stringify(fifo)})`)) ?? "";
      expect(line).toMatch(/\) 1\d{3}ms @ .*slowRead/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
