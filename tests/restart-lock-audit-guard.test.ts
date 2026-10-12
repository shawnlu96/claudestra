/**
 * manager/restart-lock.ts 的 `.guard` 互斥在持有者崩溃后的自动恢复（审查 P2 guard-crash-manual-recovery）：
 * 崩在互斥里留下的是完整的死互斥，后来者接在它后面拿到互斥、离开时把它清掉；持有进程活着的互斥不按时长接管；
 * 接链的人不会和「已经清完链、在新链头上的持有者」同时进互斥；认不出持有者 / 叠得过深的才报人工恢复。
 * 全程注入依赖：临时目录、假 pid 表、假时钟、带钩子的 fs——不碰真实进程。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RestartLock, type RestartLockDeps } from "../src/manager/restart-lock.js";

describe("互斥持有者崩溃后的恢复（两个实例 = 两个进程）", () => {
  type Op = "openSync" | "writeSync" | "renameSync" | "linkSync";
  let dir = "";
  let clock = 0;
  let alive = new Set<number>();
  let warns: string[] = [];
  let opened: number[] = [];
  let closed: number[] = [];
  let sleeps = 0;
  /** 「崩了」的进程：从这一刻起它的任何 fs 操作都不再落盘（实现里的 finally / 撤回全都做不成，和真崩一样） */
  let crashed = new Set<number>();
  /** 调用到某个 fs 操作之前先跑一段别的「进程」的动作；参数是该操作的路径（link / rename 另带目标） */
  let hook: Partial<Record<Op, (path: string, to?: unknown) => void>> = {};
  const fdPath = new Map<number, string>();
  const NAME = "agent-x";
  const lockPath = () => join(dir, `restart-${NAME}.lock`);
  const guardPath = () => `${lockPath()}.guard`;
  const tok = (c: string) => c.repeat(32);
  const body = (pid: number, c: string) => `${pid}\n${clock}\n${tok(c)}\n`;
  const link = (c: string) => `${guardPath()}.${tok(c)}`;
  const ino = (path: string) => fs.statSync(path, { bigint: true }).ino;

  const hookedFs = (pid: number): RestartLockDeps["fs"] => new Proxy({
    ...fs,
    openSync: ((...a: Parameters<typeof fs.openSync>) => {
      hook.openSync?.(String(a[0]), a[1]);
      const fd = fs.openSync(...a);
      opened.push(fd);
      fdPath.set(fd, String(a[0]));
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd: number) => { closed.push(fd); fs.closeSync(fd); }) as typeof fs.closeSync,
    writeSync: ((...a: unknown[]) => { hook.writeSync?.(fdPath.get(a[0] as number) ?? ""); return (fs.writeSync as (...x: unknown[]) => number)(...a); }) as typeof fs.writeSync,
    renameSync: ((...a: unknown[]) => { hook.renameSync?.(String(a[0]), a[1]); return (fs.renameSync as (...x: unknown[]) => void)(...a); }) as typeof fs.renameSync,
    linkSync: ((...a: unknown[]) => { hook.linkSync?.(String(a[0]), a[1]); return (fs.linkSync as (...x: unknown[]) => void)(...a); }) as typeof fs.linkSync,
  }, {
    get: (t, k) => (...a: unknown[]) => {
      if (crashed.has(pid)) throw new Error("crashed");
      return (t as unknown as Record<PropertyKey, (...x: unknown[]) => unknown>)[k]!(...a);
    },
  });
  const crash = (pid: number): never => { crashed.add(pid); alive.delete(pid); hook = {}; throw new Error("crashed"); };
  const proc = (pid: number) => {
    alive.add(pid);
    return new RestartLock({ dir, pid, now: () => clock, pidAlive: (p) => alive.has(p), fs: hookedFs(pid), warn: (m) => warns.push(m), sleep: () => { sleeps++; } });
  };
  const noLeak = () => expect([...closed].sort()).toEqual([...opened].sort());
  const files = () => fs.readdirSync(dir).map((f) => join(dir, f)).sort();

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "rstguard-"));
    clock = Date.now();
    alive = new Set();
    crashed = new Set();
    warns = [];
    opened = [];
    closed = [];
    sleeps = 0;
    hook = {};
    fdPath.clear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("[验收线 2] 持有者崩在互斥里、主锁不在：不算 inProgress，下一个直接拿到，死互斥被清掉", () => {
    const a = proc(101), b = proc(202);
    hook.openSync = (p, flag) => { if (p === lockPath() && flag === "wx") crash(101); }; // A 进了互斥、还没建锁就没了
    expect(a.tryLock(NAME)).toBe(false);
    warns = [];
    expect(fs.readFileSync(guardPath(), "utf8")).toMatch(/^101\n\d{13}\n[0-9a-f]{32}\n$/);
    clock += 10 * 60_000;
    expect(b.inProgress(NAME)).toBe(false);
    expect(b.inspect(NAME).state).toBe("free");
    expect(b.tryLock(NAME)).toBe(true);
    expect(sleeps).toBe(0);
    expect(warns).toEqual([]);
    expect(files()).toEqual([lockPath()]); // 死互斥、自己那环、临时名都没留下
    b.unlock(NAME);
    expect(files()).toEqual([]);
    noLeak();
  });

  test("[验收线 2] 持有者崩在互斥里、主锁也是它的死锁：接过互斥后回收死锁一次并拿到", () => {
    const b = proc(202);
    fs.writeFileSync(lockPath(), body(101, "a"));
    fs.writeFileSync(guardPath(), body(101, "g"));
    expect(b.inspect(NAME)).toMatchObject({ state: "dead", pid: 101 });
    expect(b.inProgress(NAME)).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^202\n/);
    expect(files()).toEqual([lockPath()]);
    noLeak();
  });

  test("[验收线 2] 互斥持有进程还活着：过多久都不接管，互斥原样，超时只出人工恢复诊断", () => {
    const b = proc(202);
    alive.add(101);
    fs.writeFileSync(guardPath(), body(101, "g"));
    const before = ino(guardPath());
    for (const later of [0, 4 * 60_000, 24 * 3600_000]) {
      clock += later;
      expect(b.tryLock(NAME)).toBe(false);
      expect(b.inProgress(NAME)).toBe(true);
      expect(ino(guardPath())).toBe(before);
    }
    expect(sleeps).toBeLessThan(1000); // 每次都是有界等待
    expect(files()).toEqual([guardPath()]);
    expect(warns.length).toBe(2);
    expect(warns.every((w) => w.includes("pid 101 还在，不接管") && w.includes(`手动删除 ${guardPath()}`))).toBe(true);
    noLeak();
  });

  test("[验收线 2] 两个接链者交错：后到的建完后继发现链头已换，撤回，不和新链头上的持有者同时进互斥", () => {
    const r1 = proc(202), r2 = proc(303);
    fs.writeFileSync(guardPath(), body(101, "g"));
    let r1Got: boolean | undefined, wxOnLock = 0;
    // R2 看完死互斥、正要把后继 link 到位：R1 整个接链、拿锁、清链、离开；随后 R3 在新链头上进了互斥
    hook.linkSync = (_p, to) => {
      if (to !== link("g")) return;
      hook = { openSync: (p, flag) => { if (p === lockPath() && flag === "wx") wxOnLock++; } };
      r1Got = r1.tryLock(NAME);
      wxOnLock = 0;
      alive.add(404);
      fs.writeFileSync(guardPath(), body(404, "n"));
    };
    expect(r2.tryLock(NAME)).toBe(false);
    expect(r1Got).toBe(true);
    expect(wxOnLock).toBe(0); // R2 从头到尾没进过临界区（没去建锁）
    expect(fs.readFileSync(guardPath(), "utf8")).toBe(body(404, "n")); // R3 的互斥没被碰
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^202\n/);
    expect(files()).toEqual([lockPath(), guardPath()]); // R2 作废的后继撤回了
    noLeak();
  });

  test("[验收线 2] 接链者自己也崩在互斥里（死链两层）：下一个接在链尾，离开时整条清掉", () => {
    const b = proc(202);
    fs.writeFileSync(guardPath(), body(101, "g"));
    fs.writeFileSync(link("g"), body(102, "h"));
    expect(b.inProgress(NAME)).toBe(false);
    let chainDuringHold: string[] = [];
    hook.openSync = (p, flag) => { if (p === lockPath() && flag === "wx") chainDuringHold = files(); };
    expect(b.tryLock(NAME)).toBe(true);
    expect(chainDuringHold).toEqual([guardPath(), link("g"), link("h")].sort()); // 临界区里死链原样，自己在链尾
    expect(files()).toEqual([lockPath()]);
    noLeak();
  });

  test("[验收线 2] 清链清到一半崩了留下的断环：不在链上，不挡后来的，也不会被接上去", () => {
    const b = proc(202);
    fs.writeFileSync(link("g"), body(102, "h")); // 链头已清，第二环和当时的链尾还在
    fs.writeFileSync(link("h"), body(103, "i"));
    expect(b.inProgress(NAME)).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    b.unlock(NAME);
    expect(files()).toEqual([link("g"), link("h")].sort());
    expect(warns).toEqual([]);
    noLeak();
  });

  test("[验收线 2] 清链时链头被直接换成别人的活互斥（绕过协议）：不删它，后面的环也不动", () => {
    const b = proc(202);
    fs.writeFileSync(guardPath(), body(101, "g"));
    alive.add(404);
    let theirIno: bigint | undefined;
    hook.renameSync = (p) => {
      if (p !== guardPath()) return;
      hook = {};
      fs.rmSync(guardPath());
      fs.writeFileSync(guardPath(), body(404, "n"));
      theirIno = ino(guardPath());
    };
    expect(b.tryLock(NAME)).toBe(true);
    expect(theirIno).toBeDefined();
    expect(ino(guardPath())).toBe(theirIno!);
    expect(fs.readFileSync(guardPath(), "utf8")).toBe(body(404, "n"));
    expect(files()).toEqual([lockPath(), guardPath()]);
    noLeak();
  });

  test("[验收线 2] 死互斥叠得过深：不无限往下走，有界等待后阻塞并报人工恢复；清掉最深一环即恢复", () => {
    const b = proc(202);
    const chain = ["g", "h", "i", "j", "k"];
    chain.forEach((c, i) => fs.writeFileSync(i === 0 ? guardPath() : link(chain[i - 1]!), body(101 + i, c)));
    const deepest = link("j");
    clock += 5 * 60_000;
    expect(b.tryLock(NAME)).toBe(false);
    expect(sleeps).toBeLessThan(1000);
    expect(b.inProgress(NAME)).toBe(true);
    const st = b.inspect(NAME);
    expect(st.state === "blocked" && st.detail).toContain(`手动删除 ${deepest}`);
    expect(warns.join("\n")).toContain(`手动删除 ${deepest}`);
    expect(fs.readdirSync(dir).length).toBe(5);
    fs.unlinkSync(deepest); // 人工恢复
    expect(b.tryLock(NAME)).toBe(true);
    expect(files()).toEqual([lockPath()]);
    noLeak();
  });

  test("[验收线 2] 互斥到位即完整：写内容时互斥路径上还没有文件；崩在写之前只留下自己独有的临时名，不挡别人", () => {
    const a = proc(101), b = proc(202);
    let atWrite: boolean | undefined;
    hook.writeSync = (p) => {
      if (!p.startsWith(`${guardPath()}.new-101-`)) return;
      atWrite = fs.existsSync(guardPath());
      crash(101);
    };
    expect(a.tryLock(NAME)).toBe(false);
    expect(atWrite).toBe(false);
    expect(fs.existsSync(guardPath())).toBe(false);
    expect(fs.readdirSync(dir).length).toBe(1); // 空的临时名
    expect(b.inProgress(NAME)).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    expect(sleeps).toBe(0);
  });
});
