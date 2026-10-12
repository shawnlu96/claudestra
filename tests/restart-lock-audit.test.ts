/**
 * manager/restart-lock.ts 的所有权不变量（审计 A09-02）：空锁 / 写了一半的锁不当死进程接管，活持有者不因 3 分钟被夺，
 * 释放只删自己建的那把，死锁回收不会读旧删新，异常路径不漏 fd；
 * 「最后一次核对身份」到「删」之间换人（守规矩的竞争者、不守规矩的直接换文件）也删不到别人的锁。
 * 前两组走对外的三个函数（落在 preload 给的临时状态目录），是旧实现下会红的反例；后面用注入依赖的 RestartLock 做真交错。
 * 「活进程」用本测试进程和它的父进程的 pid，「死进程」用一个已退出子进程的 pid——全程不发信号。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { statePath } from "../src/lib/paths.js";
import { isRestartInProgress, RestartLock, tryLockRestart, unlockRestart, type RestartLockDeps } from "../src/manager/restart-lock.js";

const MIN = 60_000;
const deadPid = (): number => {
  const p = Bun.spawnSync([process.execPath, "-e", ""]);
  return p.pid;
};
const ino = (path: string) => fs.statSync(path, { bigint: true }).ino;

describe("对外函数（生产实例，临时状态目录）", () => {
  const locks = statePath("locks");
  let n = 0;
  let name = "";
  let path = "";
  beforeEach(() => {
    fs.mkdirSync(locks, { recursive: true });
    name = `agent-rstlock-${process.pid}-${n++}`;
    path = join(locks, `restart-${name}.lock`);
  });
  afterEach(() => { fs.rmSync(path, { force: true }); fs.rmSync(`${path}.guard`, { force: true }); });

  test("[验收线 1] A 刚 open wx 还没写 pid（空锁）：B 抢不到，也不删 A 的文件", () => {
    fs.closeSync(fs.openSync(path, "wx")); // A 停在 open 与 write 之间
    const before = ino(path);
    expect(tryLockRestart(name)).toBe(false);
    expect(isRestartInProgress(name)).toBe(true);
    expect(ino(path)).toBe(before); // 还是 A 建的那个文件
    expect(fs.readFileSync(path, "utf8")).toBe("");
    fs.writeFileSync(path, `${process.ppid}\n${Date.now()}`); // A 恢复、写完
    expect(tryLockRestart(name)).toBe(false);
    expect(ino(path)).toBe(before);
  });

  test("[验收线 1] 路径已换成 B 的锁：A unlock 不删 B", () => {
    expect(tryLockRestart(name)).toBe(true); // A = 本进程
    fs.unlinkSync(path); // A 的锁被人工清掉，B 建了自己的
    const theirs = `${process.ppid}\n${Date.now()}\n${"b".repeat(32)}\n`;
    fs.writeFileSync(path, theirs);
    unlockRestart(name);
    expect(fs.readFileSync(path, "utf8")).toBe(theirs);
    expect(isRestartInProgress(name)).toBe(true);
    expect(tryLockRestart(name)).toBe(false);
  });

  test("[验收线 1] 不是本进程拿的锁：unlock 不删", () => {
    const theirs = `${process.ppid}\n${Date.now()}`;
    fs.writeFileSync(path, theirs);
    unlockRestart(name);
    expect(fs.readFileSync(path, "utf8")).toBe(theirs);
  });

  test("[验收线 2] 活持有者超过 3 分钟：仍 inProgress，竞争被拒，锁原样", () => {
    for (const body of [`${process.ppid}\n${Date.now() - 10 * MIN}`, `${process.ppid}\n${Date.now() - 10 * MIN}\n${"c".repeat(32)}\n`]) {
      fs.writeFileSync(path, body);
      expect(isRestartInProgress(name)).toBe(true);
      expect(tryLockRestart(name)).toBe(false);
      expect(fs.readFileSync(path, "utf8")).toBe(body);
    }
  });

  test("[验收线 2] 死持有者的完整锁（新旧格式）：不算 inProgress，回收一次后拿到，释放后干净", () => {
    for (const body of [`${deadPid()}\n${Date.now()}`, `${deadPid()}\n${Date.now()}\n${"d".repeat(32)}\n`]) {
      fs.writeFileSync(path, body);
      expect(isRestartInProgress(name)).toBe(false);
      expect(tryLockRestart(name)).toBe(true);
      expect(fs.readFileSync(path, "utf8")).toMatch(new RegExp(`^${process.pid}\\n\\d{13}\\n[0-9a-f]{32}\\n$`));
      expect(isRestartInProgress(name)).toBe(true);
      expect(tryLockRestart(name)).toBe(false); // 自己持有时也不重入
      unlockRestart(name);
      expect(fs.existsSync(path)).toBe(false);
      expect(fs.existsSync(`${path}.guard`)).toBe(false);
    }
  });

  test("[验收线 2] 损坏 / 写了一半的锁：保守阻塞，不删", () => {
    for (const body of ["garbage", `${deadPid()}`, `${deadPid()}\n`, `${deadPid()}\n1791`, `${deadPid()}\n${Date.now()}\nshort\n`, "\n\n"]) {
      fs.writeFileSync(path, body);
      expect(tryLockRestart(name)).toBe(false);
      expect(isRestartInProgress(name)).toBe(true);
      expect(fs.readFileSync(path, "utf8")).toBe(body);
    }
  });

  test("正常一轮：拿到 → 在跑 → 释放 → 可再拿", () => {
    expect(isRestartInProgress(name)).toBe(false);
    expect(tryLockRestart(name)).toBe(true);
    expect(isRestartInProgress(name)).toBe(true);
    unlockRestart(name);
    expect(isRestartInProgress(name)).toBe(false);
    expect(tryLockRestart(name)).toBe(true);
    unlockRestart(name);
    unlockRestart(name); // 重复释放无害
    expect(fs.existsSync(path)).toBe(false);
  });
});

describe("注入依赖的 RestartLock（两个实例 = 两个进程）", () => {
  type Op = "openSync" | "writeSync" | "unlinkSync" | "fstatSync" | "closeSync" | "renameSync" | "linkSync";
  let dir = "";
  let clock = 0;
  let alive = new Set<number>();
  let warns: string[] = [];
  let opened: number[] = [];
  let closed: number[] = [];
  let sleeps = 0;
  /** 调用到某个 fs 操作之前先跑一段别的「进程」的动作，做出确定的交错。
   *  第一个参数是该操作针对的路径（fd 类操作换算成打开时的路径） */
  let hook: Partial<Record<Op, (path: string, ...rest: unknown[]) => void>> = {};
  const fdPath = new Map<number, string>();
  const NAME = "agent-x";
  const lockPath = () => join(dir, `restart-${NAME}.lock`);
  const guardPath = () => `${lockPath()}.guard`;

  const countingFs = (): RestartLockDeps["fs"] => ({
    ...fs,
    openSync: ((...a: Parameters<typeof fs.openSync>) => {
      hook.openSync?.(String(a[0]), a[1]);
      const fd = fs.openSync(...a);
      opened.push(fd);
      fdPath.set(fd, String(a[0]));
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd: number) => { hook.closeSync?.(fdPath.get(fd) ?? ""); closed.push(fd); fs.closeSync(fd); }) as typeof fs.closeSync,
    writeSync: ((...a: unknown[]) => { hook.writeSync?.(fdPath.get(a[0] as number) ?? ""); return (fs.writeSync as (...x: unknown[]) => number)(...a); }) as typeof fs.writeSync,
    unlinkSync: ((...a: unknown[]) => { hook.unlinkSync?.(String(a[0])); return (fs.unlinkSync as (...x: unknown[]) => void)(...a); }) as typeof fs.unlinkSync,
    fstatSync: ((...a: unknown[]) => { hook.fstatSync?.(fdPath.get(a[0] as number) ?? ""); return (fs.fstatSync as (...x: unknown[]) => unknown)(...a); }) as typeof fs.fstatSync,
    renameSync: ((...a: unknown[]) => { hook.renameSync?.(String(a[0]), a[1]); return (fs.renameSync as (...x: unknown[]) => void)(...a); }) as typeof fs.renameSync,
    linkSync: ((...a: unknown[]) => { hook.linkSync?.(String(a[0]), a[1]); return (fs.linkSync as (...x: unknown[]) => void)(...a); }) as typeof fs.linkSync,
  });
  const proc = (pid: number) => {
    alive.add(pid);
    return new RestartLock({ dir, pid, now: () => clock, pidAlive: (p) => alive.has(p), fs: countingFs(), warn: (m) => warns.push(m), sleep: () => { sleeps++; } });
  };
  const noLeak = () => expect([...closed].sort()).toEqual([...opened].sort());
  /** 目录里除了列出的文件什么都不剩（互斥、挪开的临时名都清干净了） */
  const onlyFiles = (...names: string[]) => expect(fs.readdirSync(dir).sort()).toEqual(names.map((n) => (n === "lock" ? `restart-${NAME}.lock` : n)).sort());
  /** 不守规矩的替换：绕过互斥，直接把路径上的文件换成另一个 inode */
  const rawReplace = (body: string) => { fs.rmSync(lockPath(), { force: true }); fs.writeFileSync(lockPath(), body); return ino(lockPath()); };

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "rstlock-"));
    clock = 1_791_000_000_000;
    alive = new Set();
    warns = [];
    opened = [];
    closed = [];
    sleeps = 0;
    hook = {};
    fdPath.clear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("[验收线 1] A open wx 后暂停、B 竞争：B 不获锁；A 恢复后唯一持有，释放后 B 才拿到", () => {
    const a = proc(101), b = proc(202);
    let bDuringPause: boolean | undefined, bBusy: boolean | undefined, sizeDuringPause = -1;
    hook.writeSync = (p) => {
      if (p !== lockPath()) return;
      hook = {}; // 只在 A 写锁内容之前插一次
      sizeDuringPause = fs.statSync(lockPath()).size;
      bDuringPause = b.tryLock(NAME);
      bBusy = b.inProgress(NAME);
    };
    expect(a.tryLock(NAME)).toBe(true);
    expect(sizeDuringPause).toBe(0); // B 来的时候确实是空锁
    expect(bDuringPause).toBe(false);
    expect(bBusy).toBe(true);
    expect(sleeps).toBeGreaterThan(0); // B 是有界地等过互斥才放弃的
    expect(sleeps).toBeLessThan(1000);
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^101\n\d{13}\n[0-9a-f]{32}\n$/);
    expect(b.tryLock(NAME)).toBe(false);
    expect(b.inProgress(NAME)).toBe(true);
    b.unlock(NAME); // B 没拿到过：释放是空操作
    expect(a.inspect(NAME)).toMatchObject({ state: "held", pid: 101 });
    onlyFiles("lock");
    a.unlock(NAME);
    onlyFiles();
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 1] A 崩在 open wx 之后（互斥也没了）留下空锁：B 看到空锁保守阻塞", () => {
    const b = proc(202);
    fs.writeFileSync(lockPath(), "");
    expect(b.tryLock(NAME)).toBe(false);
    expect(warns.join("\n")).toContain("锁是空的");
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("");
    onlyFiles("lock");
  });

  test("[验收线 1] 路径换成 B 的锁（A 的被人工删掉后 B 新建）：A unlock 不删 B，B 自己能释放", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    fs.unlinkSync(lockPath());
    expect(b.tryLock(NAME)).toBe(true);
    const theirs = fs.readFileSync(lockPath(), "utf8");
    a.unlock(NAME);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(theirs);
    expect(warns.join("\n")).toContain("不去删别人的");
    expect(a.tryLock(NAME)).toBe(false);
    b.unlock(NAME);
    expect(fs.existsSync(lockPath())).toBe(false);
    noLeak();
  });

  test("[验收线 1] 同 pid、同内容但不是同一个文件（inode 换了）：也不删", () => {
    const a = proc(101);
    expect(a.tryLock(NAME)).toBe(true);
    const body = fs.readFileSync(lockPath(), "utf8");
    fs.writeFileSync(`${lockPath()}.copy`, body); // 新 inode 存在期间旧 inode 还没释放，号码不会被复用
    fs.renameSync(`${lockPath()}.copy`, lockPath());
    a.unlock(NAME);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(body);
  });

  test("[验收线 1] A unlock 读完身份之后、删之前 B 来抢（A 的锁同时被人工删掉）：B 进不了互斥，A 删不到任何人的锁", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    let bGot: boolean | undefined;
    // observe 读完内容关 fd = 最后一次身份读取结束；此刻路径被清空、B 来抢
    hook.closeSync = (p) => {
      if (p !== lockPath()) return;
      hook = {};
      fs.unlinkSync(lockPath());
      bGot = b.tryLock(NAME);
    };
    a.unlock(NAME);
    expect(bGot).toBe(false); // 互斥在 A 手里：B 不可能在 A 核对与删除之间建出新锁
    onlyFiles();
    expect(b.tryLock(NAME)).toBe(true); // A 释放完，B 才拿到
    a.unlock(NAME); // A 已经释放过：不会再碰 B 的
    expect(b.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
    onlyFiles("lock");
    noLeak();
  });

  test("[验收线 1] A unlock 读完身份之后、删之前路径被直接换成 B 的锁（绕过互斥）：B 的锁原样留着", () => {
    for (const at of ["closeSync", "renameSync"] as const) { // 最后一次读刚结束 / 紧贴着删除动作之前
      const a = proc(101);
      expect(a.tryLock(NAME)).toBe(true);
      const theirs = `202\n${clock}\n${"b".repeat(32)}\n`;
      alive.add(202);
      let theirIno: bigint | undefined;
      hook[at] = (p) => { if (p === lockPath()) { hook = {}; theirIno = rawReplace(theirs); } };
      warns = [];
      a.unlock(NAME);
      expect(theirIno).toBeDefined();
      expect(fs.readFileSync(lockPath(), "utf8")).toBe(theirs);
      expect(ino(lockPath())).toBe(theirIno!); // 就是 B 建的那个文件，不是拷回来的
      expect(warns.join("\n")).toContain("不去删别人的");
      expect(a.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
      onlyFiles("lock");
      noLeak();
      fs.unlinkSync(lockPath());
    }
  });

  test("[验收线 1] unlock 时互斥被占：有界等待后不删锁、有诊断；互斥空出来后还能释放", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    fs.writeFileSync(guardPath(), "");
    a.unlock(NAME);
    expect(sleeps).toBeGreaterThan(0);
    expect(sleeps).toBeLessThan(1000);
    expect(warns.join("\n")).toContain("锁没释放");
    expect(a.inspect(NAME)).toMatchObject({ state: "held", pid: 101 });
    fs.unlinkSync(guardPath());
    a.unlock(NAME);
    onlyFiles();
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 2] 活持有者过了 3 分钟、过了一天：仍 inProgress、竞争拒，只多一句诊断", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    clock += 2 * MIN;
    expect(b.tryLock(NAME)).toBe(false);
    expect(warns).toEqual([]);
    for (const later of [4 * MIN, 24 * 60 * MIN]) {
      clock += later;
      expect(b.inProgress(NAME)).toBe(true);
      expect(b.tryLock(NAME)).toBe(false);
      expect(a.inspect(NAME).state).toBe("held");
    }
    expect(warns.every((w) => w.includes("pid 101") && w.includes("不接管"))).toBe(true);
    expect(warns.length).toBe(2);
    a.unlock(NAME);
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 2] 死持有者完整锁：回收恰好一次；两个回收者交错时后到的不删先到者的新锁", () => {
    const a = proc(101), r1 = proc(202), r2 = proc(303);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101); // A 崩了，锁留在盘上
    expect(r1.inProgress(NAME)).toBe(false);
    expect(r1.inspect(NAME)).toMatchObject({ state: "dead", pid: 101 });
    let r1Got: boolean | undefined;
    hook.linkSync = (_p, to) => {
      if (to === guardPath()) { hook = {}; r1Got = r1.tryLock(NAME); } // R2 进互斥之前，R1 整个回收并拿到
    };
    expect(r2.tryLock(NAME)).toBe(false);
    expect(r1Got).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^202\n/); // R1 的锁还在
    expect(r1.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
    onlyFiles("lock");
    r1.unlock(NAME);
    onlyFiles();
    noLeak();
  });

  test("[验收线 2] 回收者看完死锁之后、删之前 B 来抢：B 进不了互斥，只有回收者一个持有者", () => {
    const a = proc(101), b = proc(202), r = proc(303);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    let bGot: boolean | undefined;
    hook.renameSync = (p) => { if (p === lockPath()) { hook = {}; bGot = b.tryLock(NAME); } };
    expect(r.tryLock(NAME)).toBe(true);
    expect(bGot).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^303\n/);
    expect(b.tryLock(NAME)).toBe(false);
    onlyFiles("lock");
    noLeak();
  });

  test("[验收线 2] 回收者看完死锁之后、删之前路径被直接换成 B 的活锁（绕过互斥）：不删 B、自己不获锁", () => {
    for (const at of ["closeSync", "renameSync"] as const) {
      const a = proc(101), r = proc(303);
      expect(a.tryLock(NAME)).toBe(true);
      alive.delete(101);
      alive.add(202);
      const theirs = `202\n${clock}\n${"b".repeat(32)}\n`;
      let theirIno: bigint | undefined;
      hook[at] = (p) => { if (p === lockPath()) { hook = {}; theirIno = rawReplace(theirs); } };
      expect(r.tryLock(NAME)).toBe(false);
      expect(theirIno).toBeDefined();
      expect(fs.readFileSync(lockPath(), "utf8")).toBe(theirs);
      expect(ino(lockPath())).toBe(theirIno!);
      expect(r.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
      r.unlock(NAME); // 没拿到：空操作
      expect(fs.readFileSync(lockPath(), "utf8")).toBe(theirs);
      onlyFiles("lock");
      noLeak();
      fs.unlinkSync(lockPath());
    }
  });

  test("[验收线 2] 挪开的不是预期的锁、原位又已被占：两个文件都不删，诊断里有挪开后的位置", () => {
    const a = proc(101), r = proc(303);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    alive.add(202);
    const theirs = `202\n${clock}\n${"b".repeat(32)}\n`;
    hook.renameSync = (p) => { if (p === lockPath()) rawReplace(theirs); };
    hook.linkSync = (_p, to) => { if (to === lockPath()) { hook = {}; fs.writeFileSync(lockPath(), "third"); } }; // 放回去之前原位又冒出一个文件
    expect(r.tryLock(NAME)).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("third");
    const aside = fs.readdirSync(dir).filter((f) => f.includes(".rm-"));
    expect(aside.length).toBe(1);
    expect(fs.readFileSync(join(dir, aside[0]!), "utf8")).toBe(theirs);
    expect(warns.join("\n")).toContain(join(dir, aside[0]!));
    expect(fs.existsSync(guardPath())).toBe(false);
    noLeak();
  });

  test("[验收线 2] 回收只做一次：回收后又被别的死进程的锁占住，不自旋", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    let removals = 0;
    hook.renameSync = (p) => { if (p === lockPath()) removals++; };
    // 回收删掉之后、重抢之前，路径上又冒出一把死锁
    hook.openSync = (p, flag) => {
      if (p === lockPath() && flag === "wx" && removals === 1) fs.writeFileSync(lockPath(), `999\n${clock}`);
    };
    expect(b.tryLock(NAME)).toBe(false);
    expect(removals).toBe(1);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(`999\n${clock}`);
    onlyFiles("lock");
    noLeak();
  });

  test("[验收线 2] 认不出持有者的互斥残留（外来的空文件）：阻塞并报人工恢复，不删死锁、不自旋", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    const body = fs.readFileSync(lockPath(), "utf8");
    fs.writeFileSync(guardPath(), "");
    expect(b.tryLock(NAME)).toBe(false); // 刚建的互斥：别人在忙，不报
    expect(warns).toEqual([]);
    expect(sleeps).toBeLessThan(1000);
    expect(b.inProgress(NAME)).toBe(true); // 去抢会被拒 = 在跑，与获取同一判据
    const st = b.inspect(NAME);
    expect(st.state === "blocked" && st.detail).toContain(`手动删除 ${guardPath()}`);
    clock = Date.now() + 5 * MIN;
    expect(b.tryLock(NAME)).toBe(false);
    expect(warns.join("\n")).toContain("互斥残留");
    expect(warns.join("\n")).toContain(`手动删除 ${guardPath()}`);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(body);
    expect(fs.readFileSync(guardPath(), "utf8")).toBe(""); // 认不出持有者的互斥不回收
    fs.unlinkSync(guardPath()); // 人工恢复
    expect(b.inProgress(NAME)).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 2] 空锁 / 损坏锁：阻塞，诊断带路径和人工恢复办法，删掉后恢复", () => {
    const b = proc(202);
    for (const [body, word] of [["", "锁是空的"], ["101\n17", "不完整或已损坏"], ["not a lock", "不完整或已损坏"]] as const) {
      warns = [];
      fs.writeFileSync(lockPath(), body);
      expect(b.tryLock(NAME)).toBe(false);
      expect(b.inProgress(NAME)).toBe(true);
      const st = b.inspect(NAME);
      expect(st.state).toBe("blocked");
      expect(st.state === "blocked" && st.detail).toContain(`手动删除 ${lockPath()}`);
      expect(warns.length).toBe(1); // 一次调用一句，不重试
      expect(warns[0]).toContain(word);
      expect(fs.readFileSync(lockPath(), "utf8")).toBe(body);
      fs.unlinkSync(lockPath());
    }
    expect(b.inspect(NAME).state).toBe("free");
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 2] 写锁抛错 / 短写：不算拿到，fd 关掉，撤回自己的文件，下次照常能拿", () => {
    const a = proc(101), b = proc(202);
    for (const hit of [(p: string) => p === lockPath(), (p: string) => p.startsWith(`${guardPath()}.new-`)]) { // 写锁内容失败 / 写互斥内容失败
      hook.writeSync = (p) => { if (hit(p)) { hook = {}; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
      expect(a.tryLock(NAME)).toBe(false);
      noLeak();
      onlyFiles();
      expect(a.inProgress(NAME)).toBe(false);
      a.unlock(NAME); // 没拿到：不会去删后来别人的锁
    }
    expect(warns.filter((w) => w.includes("ENOSPC")).length).toBe(2);
    const short = new RestartLock({ dir, pid: 404, now: () => clock, pidAlive: (p) => alive.has(p), warn: (m) => warns.push(m),
      fs: { ...countingFs(), writeSync: ((fd: number, s: string) => fs.writeSync(fd, s.slice(0, 5))) as typeof fs.writeSync } });
    expect(short.tryLock(NAME)).toBe(false);
    onlyFiles();
    expect(b.tryLock(NAME)).toBe(true);
    a.unlock(NAME);
    short.unlock(NAME);
    expect(b.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
    noLeak();
  });

  test("[验收线 2] 写锁失败、撤回之前路径被直接换成 B 刚建的空锁：不删 B 的", () => {
    const a = proc(101);
    let theirIno: bigint | undefined;
    hook.writeSync = (p) => { if (p === lockPath()) { hook.writeSync = undefined; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
    hook.renameSync = (p) => { if (p === lockPath()) { hook = {}; theirIno = rawReplace(""); } };
    expect(a.tryLock(NAME)).toBe(false);
    expect(theirIno).toBeDefined();
    expect(ino(lockPath())).toBe(theirIno!);
    expect(a.inProgress(NAME)).toBe(true);
    onlyFiles("lock");
    noLeak();
  });

  test("[验收线 2] 建锁后 fstat 抛错（没拿到身份）：不凭「是空的」认领，文件留在原位报人工恢复；期间换成 B 的空锁也不删", () => {
    const a = proc(101), b = proc(202);
    let theirIno: bigint | undefined;
    hook.fstatSync = (p) => {
      if (p !== lockPath()) return;
      hook = {};
      theirIno = rawReplace(""); // A 的空文件被清掉，B 刚 open wx 出自己的空锁
      throw Object.assign(new Error("io"), { code: "EIO" });
    };
    expect(a.tryLock(NAME)).toBe(false);
    noLeak();
    expect(ino(lockPath())).toBe(theirIno!);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("");
    expect(warns.join("\n")).toContain("EIO");
    expect(warns.join("\n")).toContain("没拿到文件身份");
    expect(warns.join("\n")).toContain(`手动删除 ${lockPath()}`);
    expect(a.inProgress(NAME)).toBe(true);
    a.unlock(NAME); // 没拿到：空操作
    expect(b.tryLock(NAME)).toBe(false); // 空锁保守阻塞
    onlyFiles("lock");
    fs.unlinkSync(lockPath()); // 人工恢复
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
  });

  test("[验收线 2] 建互斥时 fstat 抛错（没拿到身份）：同样不认领不删，报人工处理；它不在互斥的位置上，不挡后来的", () => {
    const a = proc(101);
    hook.fstatSync = (p) => { if (p.startsWith(`${guardPath()}.new-`)) { hook = {}; throw Object.assign(new Error("io"), { code: "EIO" }); } };
    expect(a.tryLock(NAME)).toBe(false);
    noLeak();
    const left = fs.readdirSync(dir);
    expect(left.length).toBe(1);
    expect(left[0]).toStartWith(`restart-${NAME}.lock.guard.new-101-`); // 没写完的互斥只出现在自己独有的名字上
    expect(warns.join("\n")).toContain("没拿到文件身份");
    expect(warns.join("\n")).toContain(`手动删除 ${join(dir, left[0]!)}`);
    expect(a.inProgress(NAME)).toBe(false);
    expect(a.tryLock(NAME)).toBe(true);
    onlyFiles("lock", left[0]!);
  });

  test("[验收线 2] 释放时挪不动 / 删不掉：不漏 fd，有诊断，不抛给调用方", () => {
    const a = proc(101);
    expect(a.tryLock(NAME)).toBe(true);
    hook.renameSync = (p) => { if (p === lockPath()) { hook = {}; throw Object.assign(new Error("ro"), { code: "EROFS" }); } };
    expect(() => a.unlock(NAME)).not.toThrow();
    expect(warns.join("\n")).toContain("释放失败（EROFS）");
    expect(a.inspect(NAME)).toMatchObject({ state: "held", pid: 101 }); // 没删成：锁原样
    noLeak();
    fs.unlinkSync(lockPath());
    warns = [];
    expect(a.tryLock(NAME)).toBe(true);
    hook.unlinkSync = (p) => { if (p.startsWith(`${lockPath()}.rm-`)) { hook = {}; throw Object.assign(new Error("io"), { code: "EIO" }); } };
    expect(() => a.unlock(NAME)).not.toThrow();
    expect(warns.join("\n")).toContain("释放失败（EIO）");
    expect(fs.existsSync(lockPath())).toBe(false); // 已经挪开：原位是空的，别人可以拿
    expect(a.inProgress(NAME)).toBe(false);
    noLeak();
    expect(opened.length).toBeGreaterThan(0);
  });

  test("锁目录不存在时自己建；目录建不了是 false 加诊断", () => {
    const nested = new RestartLock({ dir: join(dir, "a", "locks"), pid: 101, now: () => clock, pidAlive: () => true, fs, warn: (m) => warns.push(m) });
    expect(nested.tryLock(NAME)).toBe(true);
    fs.writeFileSync(join(dir, "file"), "");
    const bad = new RestartLock({ dir: join(dir, "file", "locks"), pid: 101, now: () => clock, pidAlive: () => true, fs, warn: (m) => warns.push(m) });
    expect(bad.tryLock(NAME)).toBe(false);
    expect(warns.join("\n")).toContain("锁目录建不了");
  });
});
