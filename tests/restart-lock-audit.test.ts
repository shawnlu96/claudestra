/**
 * manager/restart-lock.ts 的所有权不变量（审计 A09-02）：空锁 / 写了一半的锁不当死进程接管，活持有者不因 3 分钟被夺，
 * 释放只删自己建的那把，死锁回收不会读旧删新，异常路径不漏 fd。
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
  afterEach(() => { fs.rmSync(path, { force: true }); fs.rmSync(`${path}.reclaim`, { force: true }); });

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
      expect(fs.existsSync(`${path}.reclaim`)).toBe(false);
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
  let dir = "";
  let clock = 0;
  let alive = new Set<number>();
  let warns: string[] = [];
  let opened: number[] = [];
  let closed: number[] = [];
  /** 调用到某个 fs 操作时先跑一段别的「进程」的动作，做出确定的交错 */
  let hook: Partial<Record<"openSync" | "writeSync" | "unlinkSync" | "fstatSync", (...a: unknown[]) => void>> = {};
  const NAME = "agent-x";
  const lockPath = () => join(dir, `restart-${NAME}.lock`);

  const countingFs = (): RestartLockDeps["fs"] => ({
    ...fs,
    openSync: ((...a: Parameters<typeof fs.openSync>) => { hook.openSync?.(...a); const fd = fs.openSync(...a); opened.push(fd); return fd; }) as typeof fs.openSync,
    closeSync: ((fd: number) => { closed.push(fd); fs.closeSync(fd); }) as typeof fs.closeSync,
    writeSync: ((...a: unknown[]) => { hook.writeSync?.(...a); return (fs.writeSync as (...x: unknown[]) => number)(...a); }) as typeof fs.writeSync,
    unlinkSync: ((...a: unknown[]) => { hook.unlinkSync?.(...a); return (fs.unlinkSync as (...x: unknown[]) => void)(...a); }) as typeof fs.unlinkSync,
    fstatSync: ((...a: unknown[]) => { hook.fstatSync?.(...a); return (fs.fstatSync as (...x: unknown[]) => unknown)(...a); }) as typeof fs.fstatSync,
  });
  const proc = (pid: number) => {
    alive.add(pid);
    return new RestartLock({ dir, pid, now: () => clock, pidAlive: (p) => alive.has(p), fs: countingFs(), warn: (m) => warns.push(m) });
  };
  const noLeak = () => expect([...closed].sort()).toEqual([...opened].sort());

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "rstlock-"));
    clock = 1_791_000_000_000;
    alive = new Set();
    warns = [];
    opened = [];
    closed = [];
    hook = {};
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("[验收线 1] A open wx 后暂停、B 竞争：B 不获锁；A 恢复后唯一持有，释放后 B 才拿到", () => {
    const a = proc(101), b = proc(202);
    let bDuringPause: boolean | undefined, sizeDuringPause = -1;
    hook.writeSync = () => {
      hook = {}; // 只在 A 的这次 write 之前插一次
      sizeDuringPause = fs.statSync(lockPath()).size;
      bDuringPause = b.tryLock(NAME);
    };
    expect(a.tryLock(NAME)).toBe(true);
    expect(sizeDuringPause).toBe(0); // B 来的时候确实是空锁
    expect(bDuringPause).toBe(false);
    expect(warns.join("\n")).toContain("锁是空的");
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^101\n\d{13}\n[0-9a-f]{32}\n$/);
    expect(b.tryLock(NAME)).toBe(false);
    expect(b.inProgress(NAME)).toBe(true);
    b.unlock(NAME); // B 没拿到过：释放是空操作
    expect(a.inspect(NAME)).toMatchObject({ state: "held", pid: 101 });
    a.unlock(NAME);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    noLeak();
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
    hook.openSync = (p) => {
      if (String(p).endsWith(".reclaim")) { hook = {}; r1Got = r1.tryLock(NAME); } // R2 看完死锁、进互斥之前，R1 整个回收并拿到
    };
    expect(r2.tryLock(NAME)).toBe(false);
    expect(r1Got).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toMatch(/^202\n/); // R1 的锁还在
    expect(r1.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
    expect(fs.existsSync(`${lockPath()}.reclaim`)).toBe(false);
    r1.unlock(NAME);
    expect(fs.existsSync(lockPath())).toBe(false);
    noLeak();
  });

  test("[验收线 2] 回收只做一次：回收后又被别的死进程的锁占住，不自旋", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    let unlinks = 0;
    hook.unlinkSync = (p) => { if (String(p) === lockPath()) unlinks++; };
    // 回收删掉之后、重抢之前，路径上又冒出一把死锁
    hook.openSync = (p, flag) => {
      if (String(p) === lockPath() && flag === "wx" && unlinks === 1) fs.writeFileSync(lockPath(), `999\n${clock}`);
    };
    expect(b.tryLock(NAME)).toBe(false);
    expect(unlinks).toBe(1);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(`999\n${clock}`);
    noLeak();
  });

  test("[验收线 2] 回收互斥残留：阻塞并报人工恢复，不删死锁、不自旋", () => {
    const a = proc(101), b = proc(202);
    expect(a.tryLock(NAME)).toBe(true);
    alive.delete(101);
    const body = fs.readFileSync(lockPath(), "utf8");
    fs.writeFileSync(`${lockPath()}.reclaim`, "");
    expect(b.tryLock(NAME)).toBe(false); // 刚建的互斥：别的回收者在忙，不报
    expect(warns).toEqual([]);
    clock = Date.now() + 5 * MIN;
    expect(b.tryLock(NAME)).toBe(false);
    expect(warns.join("\n")).toContain("回收互斥残留");
    expect(warns.join("\n")).toContain(`手动删除 ${lockPath()}.reclaim`);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(body);
    fs.unlinkSync(`${lockPath()}.reclaim`); // 人工恢复
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

  test("[验收线 2] 写锁抛错 / 短写 / fstat 抛错：不算拿到，fd 关掉，撤回自己的空文件，下次照常能拿", () => {
    const a = proc(101), b = proc(202);
    const faults: (() => void)[] = [
      () => { hook.writeSync = () => { hook = {}; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }; },
      () => { hook.fstatSync = () => { hook = {}; throw Object.assign(new Error("io"), { code: "EIO" }); }; },
    ];
    for (const arm of faults) {
      arm();
      expect(a.tryLock(NAME)).toBe(false);
      noLeak();
      expect(fs.existsSync(lockPath())).toBe(false);
      expect(a.inProgress(NAME)).toBe(false);
      a.unlock(NAME); // 没拿到：不会去删后来别人的锁
    }
    expect(warns.join("\n")).toContain("ENOSPC");
    const short = new RestartLock({ dir, pid: 404, now: () => clock, pidAlive: (p) => alive.has(p), warn: (m) => warns.push(m),
      fs: { ...countingFs(), writeSync: ((fd: number, s: string) => fs.writeSync(fd, s.slice(0, 5))) as typeof fs.writeSync } });
    expect(short.tryLock(NAME)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(b.tryLock(NAME)).toBe(true);
    a.unlock(NAME);
    short.unlock(NAME);
    expect(b.inspect(NAME)).toMatchObject({ state: "held", pid: 202 });
    noLeak();
  });

  test("[验收线 2] 释放时 unlink 抛错：不漏 fd，有诊断，不抛给调用方", () => {
    const a = proc(101);
    expect(a.tryLock(NAME)).toBe(true);
    hook.unlinkSync = () => { hook = {}; throw Object.assign(new Error("ro"), { code: "EROFS" }); };
    expect(() => a.unlock(NAME)).not.toThrow();
    expect(warns.join("\n")).toContain("释放失败（EROFS）");
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
