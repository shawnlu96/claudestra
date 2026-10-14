import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIAG_LIMITS, captureBridgeDiag, diagDirName, execWithTimeout, loadOf, parseSideMode, pruneDiagDirs, summarizeLsof, summarizeVmStat,
  type DiagIo, type ExecResult, type SideMode,
} from "../src/lib/bridge-watchdog-diag.ts";

const T0 = Date.UTC(2026, 9, 13, 20, 48, 35);
const LSOF = [
  "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
  "bun     4242 someone cwd    DIR    1,4      640 1234 /Users/someone/secret-repo",
  "bun     4242 someone txt    REG    1,4  5551234 5678 /Users/someone/.bun/bin/bun",
  "bun     4242 someone  10u   REG    1,4     4096 9012 /Users/someone/state.db",
  "bun     4242 someone  11u  IPv4 0xabc      0t0  TCP 10.1.2.3:51000->203.0.113.9:443 (ESTABLISHED)",
  "bun     4242 someone  12u  IPv6 0xdef      0t0  TCP *:3847 (LISTEN)",
  "bun     4242 someone  13u  unix 0x123      0t0      /tmp/sock",
  "bun     4242 someone  14   PIPE 0x456    16384      ->0x789",
  "",
].join("\n");
const OUTPUTS: Record<string, string> = {
  ps: "  PID  PPID STAT  %CPU %MEM    RSS ELAPSED WCHAN\n 4242     1 S      0.0  1.2 123456 05:15:00 -\n",
  lsof: LSOF,
  sysctl: "vm.swapusage: total = 15360.00M  used = 14745.60M  free = 614.40M  (encrypted)\n",
  vm_stat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1234.\nPages purgeable:  9.\nSwapins:  77.\nSwapouts:  88.\n",
  uptime: "20:48  up 12 days,  3:04, 2 users, load averages: 10.02 9.50 8.75\n",
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeIo(opts: { mode?: SideMode; platform?: string; exec?: (cmd: string[], timeoutMs: number) => Promise<ExecResult>; stepMs?: number } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "bwd2-diag-"));
  dirs.push(baseDir);
  let now = T0;
  const calls = { exec: [] as { cmd: string[]; timeoutMs: number }[], log: [] as string[] };
  const io: DiagIo = {
    mode: () => opts.mode ?? "on",
    platform: opts.platform ?? "darwin",
    baseDir,
    exec: async (cmd, timeoutMs) => {
      calls.exec.push({ cmd, timeoutMs });
      now += opts.stepMs ?? 10;
      if (opts.exec) return opts.exec(cmd, timeoutMs);
      const bin = cmd[0]!.split("/").at(-1)!;
      return { ok: true, out: OUTPUTS[bin] ?? "" };
    },
    log: (l) => void calls.log.push(l),
    now: () => now,
  };
  return { io, calls, baseDir };
}

describe("抓现场：on", () => {
  test("跑规格列的命令，落到 bridge-stuck-<UTC>/，返回目录名", async () => {
    const { io, calls, baseDir } = fakeIo();
    const name = await captureBridgeDiag(4242, io);
    expect(name).toBe("bridge-stuck-20261013T204835Z");
    const cmds = calls.exec.map((c) => c.cmd.join(" "));
    expect(cmds).toContain(`/usr/bin/sample 4242 3 -file ${join(baseDir, name!, "sample.txt")}`);
    expect(cmds).toContain("ps -o pid,ppid,stat,%cpu,%mem,rss,etime,wchan -p 4242");
    expect(cmds).toContain("lsof -n -P -p 4242");
    expect(cmds).toContain("sysctl vm.swapusage");
    expect(cmds).toContain("vm_stat");
    expect(cmds).toContain("uptime");
    expect(calls.exec.length).toBe(6);
    for (const c of calls.exec) expect(c.timeoutMs).toBeLessThanOrEqual(DIAG_LIMITS.sampleMs);
    const dir = join(baseDir, name!);
    expect(readdirSync(dir).sort()).toEqual(["load.txt", "lsof-counts.txt", "ps.txt", "summary.txt", "swap.txt", "vm_stat.txt"]);
    expect(readFileSync(join(dir, "load.txt"), "utf8")).toBe("load averages: 10.02 9.50 8.75\n");
    expect(readFileSync(join(dir, "swap.txt"), "utf8")).toContain("used = 14745.60M");
    expect(readFileSync(join(dir, "vm_stat.txt"), "utf8")).not.toContain("purgeable");
    expect(calls.log.length).toBe(1);
  });

  test("lsof 只存条目数和按类型计数，路径和地址不落盘", async () => {
    const { io, baseDir } = fakeIo();
    const name = await captureBridgeDiag(4242, io);
    const text = readFileSync(join(baseDir, name!, "lsof-counts.txt"), "utf8");
    expect(text).toBe("total 7\nREG 2\nIPv4 1\nIPv6 1\nunix 1\nPIPE 1\nother 1\n");
    const all = readdirSync(join(baseDir, name!)).map((f) => readFileSync(join(baseDir, name!, f), "utf8")).join("\n");
    for (const leak of ["secret-repo", "someone", "203.0.113.9", "10.1.2.3", "/tmp/sock"]) expect(all).not.toContain(leak);
  });

  test("非 darwin 没有 sample，其余照抓", async () => {
    const { io, calls } = fakeIo({ platform: "linux" });
    expect(await captureBridgeDiag(4242, io)).not.toBeNull();
    expect(calls.exec.map((c) => c.cmd[0])).toEqual(["ps", "lsof", "sysctl", "vm_stat", "uptime"]);
  });

  test("命令失败 / 起不来只记进摘要，不抛，其余照抓", async () => {
    const { io, calls, baseDir } = fakeIo({ exec: async (cmd) => (cmd[0] === "ps" ? { ok: false, error: "exit 1" } : { ok: true, out: "x\n" }) });
    const name = await captureBridgeDiag(4242, io);
    expect(name).not.toBeNull();
    expect(existsSync(join(baseDir, name!, "ps.txt"))).toBe(false);
    expect(existsSync(join(baseDir, name!, "swap.txt"))).toBe(true);
    expect(calls.log[0]).toContain("ps: 失败（exit 1）");
  });

  test("总时限到了就跳过剩下的命令，照常返回", async () => {
    const { io, calls } = fakeIo({ stepMs: DIAG_LIMITS.totalMs }); // 第一条命令就把总时限耗完
    const name = await captureBridgeDiag(4242, io);
    expect(name).not.toBeNull();
    expect(calls.exec.length).toBeLessThanOrEqual(2); // sample 与顺序链的第一条并行起，其余不再起
    expect(calls.log[0]).toContain("跳过（总时限已到）");
  });

  test("exec 抛错 / 目录建不出来：记一行日志，返回 null，不抛", async () => {
    const a = fakeIo({ exec: async () => { throw new Error("spawn boom"); } });
    expect(await captureBridgeDiag(4242, a.io)).toBeNull();
    expect(a.calls.log[0]).toContain("spawn boom");
    const b = fakeIo();
    writeFileSync(join(b.baseDir, "blocker"), "");
    b.io.baseDir = join(b.baseDir, "blocker"); // 父路径是普通文件
    expect(await captureBridgeDiag(4242, b.io)).toBeNull();
    expect(b.calls.exec.length).toBe(0);
    expect(b.calls.log.length).toBe(1);
  });
});

describe("抓现场：observe / off", () => {
  test("observe 只记本会抓哪些，不调任何命令、不建目录", async () => {
    const { io, calls, baseDir } = fakeIo({ mode: "observe" });
    expect(await captureBridgeDiag(4242, io)).toBeNull();
    expect(calls.exec.length).toBe(0);
    expect(readdirSync(baseDir)).toEqual([]);
    expect(calls.log.length).toBe(1);
    expect(calls.log[0]).toContain("本会抓");
    for (const n of ["sample", "ps", "lsof", "swap", "vm_stat", "uptime"]) expect(calls.log[0]).toContain(n);
  });

  test("off 完全不调：不执行、不记日志、不建目录", async () => {
    const { io, calls, baseDir } = fakeIo({ mode: "off" });
    expect(await captureBridgeDiag(4242, io)).toBeNull();
    expect(calls.exec.length).toBe(0);
    expect(calls.log.length).toBe(0);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  test("两个新键缺省 / 坏值 = on", () => {
    expect(parseSideMode(undefined)).toBe("on");
    expect(parseSideMode("yes")).toBe("on");
    expect(parseSideMode("observe")).toBe("observe");
    expect(parseSideMode("off")).toBe("off");
  });
});

describe("现场目录保留 5 份", () => {
  test("抓完只留最近 5 份；别的目录、同名文件、名字不合规的都不动", async () => {
    const { io, baseDir } = fakeIo();
    const old = [1, 2, 3, 4, 5, 6, 7].map((d) => diagDirName(Date.UTC(2026, 8, d)));
    for (const n of old) { mkdirSync(join(baseDir, n)); writeFileSync(join(baseDir, n, "ps.txt"), "x"); }
    const bystanders = ["bridge-stuck-notes", "bridge-stuck-20260901T000000Z-keep", "launcher-archive", "acp"];
    for (const n of bystanders) { mkdirSync(join(baseDir, n)); writeFileSync(join(baseDir, n, "f"), "x"); }
    writeFileSync(join(baseDir, "bridge-stuck-20200101T000000Z"), "同名的普通文件");
    writeFileSync(join(baseDir, "bridge.out"), "log");
    const name = await captureBridgeDiag(4242, io);
    const left = readdirSync(baseDir).sort();
    expect(left.filter((n) => /^bridge-stuck-\d{8}T\d{6}Z$/.test(n) && n !== "bridge-stuck-20200101T000000Z")).toEqual([...old.slice(3), name!]);
    for (const n of [...bystanders, "bridge-stuck-20200101T000000Z", "bridge.out"]) expect(left).toContain(n);
    expect(readFileSync(join(baseDir, "launcher-archive", "f"), "utf8")).toBe("x");
  });

  test("pruneDiagDirs：不足 5 份不删", () => {
    const { baseDir } = fakeIo();
    for (const d of [1, 2, 3]) mkdirSync(join(baseDir, diagDirName(Date.UTC(2026, 8, d))));
    expect(pruneDiagDirs(baseDir)).toEqual([]);
    expect(readdirSync(baseDir).length).toBe(3);
  });
});

describe("摘要与真命令", () => {
  test("summarizeLsof / summarizeVmStat / loadOf", () => {
    expect(summarizeLsof("")).toBe("total 0\nREG 0\nIPv4 0\nIPv6 0\nunix 0\nPIPE 0\nother 0\n");
    expect(summarizeVmStat(OUTPUTS.vm_stat!).trim().split("\n").length).toBe(4);
    expect(loadOf(" 20:48:35 up 3 days,  load average: 1.00, 2.00, 3.00\n")).toBe("load average: 1.00, 2.00, 3.00\n");
  });

  test("execWithTimeout：超时就杀并立刻返回；起不来 / 非 0 退出 = ok:false", async () => {
    const t0 = Date.now();
    const r = await execWithTimeout(["sleep", "5"], 100);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect((await execWithTimeout(["/nonexistent-bwd2-binary"], 1_000)).ok).toBe(false);
    expect((await execWithTimeout(["false"], 1_000)).ok).toBe(false);
    expect(await execWithTimeout(["echo", "hi"], 1_000)).toEqual({ ok: true, out: "hi\n" });
  });
});
