/**
 * 整机部署锁(src/lib/pm-deploy-lock.ts)的进程内回归:CAS 释放、死亡 / pid 复用接管、活持有者不按年龄被偷、
 * 未知死活与坏记录 fail-closed、受控重入只认 token + 祖先关系。真实多进程竞争见 tests/pm-deploy-lock-cli.test.ts。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDeployLock, holderLiveness, readDeployLock, realProbe, reentrantHolder, type DeployLockRecord, type ProcProbe,
} from "../src/lib/pm-deploy-lock.ts";

let dir = "";
let lock = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-deploy-lock-"));
  lock = join(dir, "pm-deploy.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deadPid = () => Bun.spawnSync(["/usr/bin/true"]).pid;
const myStart = () => realProbe.startOf(process.pid)!;
function fakeRecord(over: Partial<DeployLockRecord> = {}): DeployLockRecord {
  return {
    v: 1, token: "f".repeat(32), label: "deploy-full", uid: realProbe.uid(),
    holder: { pid: process.pid, startId: myStart() }, acquiredAt: "2020-01-01T00:00:00.000Z", ...over,
  };
}
async function take(label = "deploy-full", waitMs = 0, probe?: ProcProbe) {
  return acquireDeployLock({ label, waitMs, path: lock, pollMs: 20, probe });
}
async function held(label = "deploy-full", probe?: ProcProbe) {
  const r = await take(label, 0, probe);
  if (r.kind !== "acquired") throw new Error(`没拿到锁:${JSON.stringify(r)}`);
  return r.handle;
}

describe("获取 / 释放", () => {
  test("拿到锁:记录带 label、本进程 pid 与启动代次、uid、获取时间;释放后锁文件消失", async () => {
    const h = await held("card-merge");
    const r = readDeployLock(lock);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.record).toMatchObject({ label: "card-merge", holder: { pid: process.pid, startId: myStart() }, uid: realProbe.uid() });
    expect(Date.parse(r.record.acquiredAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(h.release()).toBe("released");
    expect(readDeployLock(lock).status).toBe("missing");
  });

  test("不同 label 共享同一把锁:deploy-full 持有时 card-merge 拿不到", async () => {
    const h = await held("deploy-full");
    const r = await take("card-merge", 100);
    expect(r.kind).toBe("timeout");
    if (r.kind === "timeout") expect(r.holder?.label).toBe("deploy-full");
    h.release();
    expect((await take("card-merge")).kind).toBe("acquired");
  });

  test("旧释放 CAS:重复释放 / 锁被换人后旧句柄释放,不删新持有者的锁", async () => {
    const h1 = await held();
    expect(h1.release()).toBe("released");
    const h2 = await held();
    expect(h1.release()).toBe("not-owner");
    expect(readDeployLock(lock)).toMatchObject({ status: "ok", record: { token: h2.record.token } });
    unlinkSync(lock); // 外部删掉 h2 的锁,h3 拿到
    const h3 = await held();
    expect(h2.release()).toBe("not-owner");
    expect(readDeployLock(lock)).toMatchObject({ status: "ok", record: { token: h3.record.token } });
    expect(h3.release()).toBe("released");
    expect(h3.release()).toBe("gone");
  });

  test("recordChild 先核 token:锁已换人时抛错且不覆盖新持有者的记录", async () => {
    const h1 = await held();
    h1.recordChild(process.pid);
    expect(readDeployLock(lock)).toMatchObject({ status: "ok", record: { child: { pid: process.pid, startId: myStart() } } });
    unlinkSync(lock);
    const h2 = await held();
    expect(() => h1.recordChild(process.pid)).toThrow();
    expect(readDeployLock(lock)).toMatchObject({ status: "ok", record: { token: h2.record.token } });
    h2.release();
  });

  test("recordChild:子进程活着但启动代次查不到 → 抛错,记录不写入 startId=null", async () => {
    const h = await held("deploy-full", { ...realProbe, startOf: (pid) => (pid === process.pid ? myStart() : null) });
    const child = Bun.spawn(["sleep", "5"]);
    try {
      expect(() => h.recordChild(child.pid)).toThrow();
      expect(readDeployLock(lock)).toMatchObject({ status: "ok", record: { token: h.record.token } });
      if (readDeployLock(lock).status === "ok") expect((readDeployLock(lock) as { record: DeployLockRecord }).record.child).toBeUndefined();
    } finally {
      child.kill("SIGKILL");
      h.release();
    }
  });

  test("recordChild(group):子进程不是自己进程组组长 → 抛错", async () => {
    const h = await held();
    const child = Bun.spawn(["sleep", "5"]);
    try {
      expect(() => h.recordChild(child.pid, { group: true })).toThrow();
    } finally {
      child.kill("SIGKILL");
      h.release();
    }
  });

  test("label 不合法 → error(零部署),不建锁", async () => {
    for (const label of ["", "a b", "x;rm", "é", "a".repeat(65)]) expect((await take(label)).kind).toBe("error");
    expect(readDeployLock(lock).status).toBe("missing");
  });

  test("同进程内并发抢锁:任一时刻只一个在关键区", async () => {
    let inside = 0;
    let peak = 0;
    const worker = async (i: number) => {
      const r = await acquireDeployLock({ label: `w${i}`, waitMs: 10_000, path: lock, pollMs: 5 });
      if (r.kind !== "acquired") throw new Error(r.kind);
      peak = Math.max(peak, ++inside);
      await Bun.sleep(15);
      inside--;
      r.handle.release();
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => worker(i)));
    expect(peak).toBe(1);
  });
});

describe("死活判断与接管", () => {
  test("持有者已死 → 接管", async () => {
    writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: deadPid(), startId: "Thu Jan 1 00:00:00 2026" } })));
    expect((await take()).kind).toBe("acquired");
  });

  test("pid 复用(pid 活着但启动代次不符)→ 原持有者已死,接管", async () => {
    writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: process.pid, startId: "Thu Jan 1 00:00:00 1998" } })));
    expect(holderLiveness(fakeRecord({ holder: { pid: process.pid, startId: "Thu Jan 1 00:00:00 1998" } }))).toBe("dead");
    expect((await take()).kind).toBe("acquired");
  });

  test("活持有者不因 mtime / 获取时间很旧被偷:有界等待后超时,锁原样", async () => {
    const rec = fakeRecord();
    writeFileSync(lock, JSON.stringify(rec));
    const old = new Date(Date.now() - 7 * 86_400_000);
    utimesSync(lock, old, old);
    const before = readFileSync(lock, "utf8");
    const t0 = Date.now();
    const r = await take("card-merge", 300);
    expect(r).toMatchObject({ kind: "timeout", state: "live", holder: { label: "deploy-full", holder: { pid: process.pid } } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(readFileSync(lock, "utf8")).toBe(before);
  });

  test("部署子进程还活着(wrapper 已死)→ 仍算持有,不接管", async () => {
    const rec = fakeRecord({ holder: { pid: deadPid(), startId: "x" }, child: { pid: process.pid, startId: myStart() } });
    writeFileSync(lock, JSON.stringify(rec));
    expect(await take("deploy-full", 100)).toMatchObject({ kind: "timeout", state: "live" });
  });

  test("部署子进程组:组长已退但组里还有进程 → live;整组退完 → dead", async () => {
    const leader = Bun.spawn(["sh", "-c", "sleep 2 & exit 0"], { detached: true, stdio: ["ignore", "ignore", "ignore"] } as Parameters<typeof Bun.spawn>[1]);
    await leader.exited;
    const rec = fakeRecord({ holder: { pid: deadPid(), startId: "x" }, child: { pid: leader.pid, startId: "Thu Jan 1 00:00:00 1998", pgid: leader.pid } });
    expect(holderLiveness(rec)).toBe("live");
    writeFileSync(lock, JSON.stringify(rec));
    expect(await take("deploy-full", 100)).toMatchObject({ kind: "timeout", state: "live" });
    process.kill(-leader.pid, "SIGKILL");
    await Bun.sleep(200);
    expect(holderLiveness(rec)).toBe("dead");
    expect((await take()).kind).toBe("acquired");
  });

  test("死活未知(EPERM / ps 读不到 / 代次没记 / uid 不符)→ 不接管,有界超时", async () => {
    const eperm: ProcProbe = { ...realProbe, signal0: (pid) => (pid === 4242 ? "unknown" : realProbe.signal0(pid)) };
    writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: 4242, startId: "x" } })));
    expect(await take("deploy-full", 100, eperm)).toMatchObject({ kind: "timeout", state: "unknown" });
    const noPs: ProcProbe = { ...realProbe, startOf: (pid) => (pid === process.pid ? myStart() : null) };
    const child = Bun.spawn(["sleep", "5"]);
    try {
      writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: child.pid, startId: "x" } })));
      expect(await take("deploy-full", 100, noPs)).toMatchObject({ kind: "timeout", state: "unknown" });
      writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: child.pid, startId: null } })));
      expect(await take("deploy-full", 100)).toMatchObject({ kind: "timeout", state: "unknown" });
    } finally {
      child.kill("SIGKILL");
    }
    writeFileSync(lock, JSON.stringify(fakeRecord({ uid: realProbe.uid() + 1, holder: { pid: deadPid(), startId: "x" } })));
    expect(await take("deploy-full", 100)).toMatchObject({ kind: "timeout", state: "unknown" });
    expect(readDeployLock(lock).status).toBe("ok");
  });

  test("锁记录损坏 → 不删、有界超时(corrupt)", async () => {
    for (const bad of ["", "{not json", JSON.stringify({ v: 1, token: "short" })]) {
      writeFileSync(lock, bad);
      expect(await take("deploy-full", 60)).toMatchObject({ kind: "timeout", state: "corrupt" });
      expect(readFileSync(lock, "utf8")).toBe(bad);
    }
  });

  test("读不到自己的启动代次 → error,不建锁", async () => {
    const r = await take("deploy-full", 0, { ...realProbe, startOf: () => null });
    expect(r.kind).toBe("error");
    expect(readDeployLock(lock).status).toBe("missing");
  });

  test("等锁期间被 abort → aborted,不进关键区", async () => {
    const h = await held();
    const r = await acquireDeployLock({ label: "x", waitMs: 5_000, path: lock, pollMs: 10, aborted: () => true });
    expect(r.kind).toBe("aborted");
    h.release();
  });
});

describe("受控重入", () => {
  test("没有 token / token 不对 / 持有者不是祖先(同进程自己)→ 不重入", async () => {
    const h = await held();
    expect(reentrantHolder(undefined, { path: lock })).toBeNull();
    expect(reentrantHolder("0".repeat(32), { path: lock })).toBeNull();
    expect(reentrantHolder(h.record.token, { path: lock })).toBeNull();
    h.release();
  });

  test("token 对且持有者是祖先 → 重入;ps 读不到 ppid → 不重入", () => {
    writeFileSync(lock, JSON.stringify(fakeRecord({ holder: { pid: process.ppid, startId: realProbe.startOf(process.ppid) } })));
    const token = "f".repeat(32);
    expect(reentrantHolder(token, { path: lock })?.holder.pid).toBe(process.ppid);
    expect(reentrantHolder(token, { path: lock, probe: { ...realProbe, ppidOf: () => null } })).toBeNull();
  });
});
