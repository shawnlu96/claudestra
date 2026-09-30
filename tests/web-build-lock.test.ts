/**
 * web 构建锁（src/lib/web-build-lock.ts）：锁文件从诞生起就带完整 pid；内容异常不删、直接失败；只接管已死的持有者；
 * 多进程反复抢锁时临界区里永远只有一个（codex 复核用两个进程复现过旧写法的双持有）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { lockStatus, releaseLock, takeLock } from "../src/lib/web-build-lock.js";

const LOCK = join(STATE_DIR, "web-build.lock");
afterEach(() => rmSync(LOCK, { force: true }));

/** 一个已经退出的进程的 pid */
function deadPid(): number {
  const p = Bun.spawnSync(["/usr/bin/true"]);
  return p.pid;
}

describe("takeLock / releaseLock", () => {
  test("空闲时拿到锁，锁文件里是本进程 pid；release 后删除", () => {
    expect(takeLock()).toBe(true);
    expect(readFileSync(LOCK, "utf8")).toBe(String(process.pid));
    releaseLock();
    expect(existsSync(LOCK)).toBe(false);
  });
  test("锁内容为空或不是 pid：不删、直接失败（身份不确定时宁可这轮不建）", () => {
    for (const content of ["", "abc", "0", "-5"]) {
      writeFileSync(LOCK, content);
      expect(takeLock()).toBe(false);
      expect(readFileSync(LOCK, "utf8")).toBe(content);
    }
  });
  test("持有者还活着且是 bun（这里用本进程）→ 拿不到，也不动它的锁", () => {
    writeFileSync(LOCK, String(process.pid));
    expect(takeLock()).toBe(false);
    expect(readFileSync(LOCK, "utf8")).toBe(String(process.pid));
  });
  test("持有者已死 → 接管，锁换成本进程 pid", () => {
    writeFileSync(LOCK, String(deadPid()));
    expect(takeLock()).toBe(true);
    expect(readFileSync(LOCK, "utf8")).toBe(String(process.pid));
    releaseLock();
  });
  test("别人在构建：返回 false，lockStatus 给出持有者 pid、没有 problem", () => {
    writeFileSync(LOCK, String(process.pid));
    expect(takeLock()).toBe(false);
    expect(lockStatus()).toEqual({ holder: process.pid });
  });
  test("锁内容异常 / 文件系统出错：不抛、按错误报出去（带路径），自动更新不会当成「别人在构建」静默跳过", () => {
    writeFileSync(LOCK, "");
    expect(takeLock()).toBe(false);
    expect(lockStatus().problem).toContain(LOCK);
    rmSync(LOCK, { force: true });
    chmodSync(STATE_DIR, 0o500); // 状态目录不可写：建临时文件失败
    try {
      expect(takeLock()).toBe(false);
      expect(lockStatus().problem).toContain("web 构建锁出错");
    } finally {
      chmodSync(STATE_DIR, 0o700);
    }
  });
  test("接管锁残留（主人已死）：不接管、按 problem 报出去，两把锁都不动", () => {
    const dead = String(deadPid());
    writeFileSync(LOCK, dead);
    writeFileSync(`${LOCK}.reap`, dead);
    try {
      expect(takeLock()).toBe(false);
      expect(lockStatus().problem).toContain(`${LOCK}.reap`);
      expect(readFileSync(LOCK, "utf8")).toBe(dead);
    } finally {
      rmSync(`${LOCK}.reap`, { force: true });
    }
  });
  test("接管锁一直被活 bun 占着（等价于 pid 被复用）：不动锁，等满后按 problem 报出占用者", () => {
    const dead = String(deadPid());
    writeFileSync(LOCK, dead);
    writeFileSync(`${LOCK}.reap`, String(process.pid));
    try {
      expect(takeLock()).toBe(false);
      expect(lockStatus().problem).toContain(`pid ${process.pid}`);
      expect(readFileSync(LOCK, "utf8")).toBe(dead);
    } finally {
      rmSync(`${LOCK}.reap`, { force: true });
    }
  });
  test("release 只删自己的锁", () => {
    writeFileSync(LOCK, "999999");
    releaseLock();
    expect(readFileSync(LOCK, "utf8")).toBe("999999");
  });
});

/** 起 n 个子进程跑同一段脚本，统一在 startAt 时刻起跑（屏障），返回各自打印的 JSON */
async function race<T>(dir: string, body: string, n: number, extraEnv: Record<string, string> = {}): Promise<T[]> {
  const mod = resolve(import.meta.dir, "../src/lib/web-build-lock.ts");
  const id = Math.random().toString(36).slice(2);
  const script = join(dir, `worker-${id}.ts`), readyDir = join(dir, `ready-${id}`);
  mkdirSync(readyDir);
  writeFileSync(script, `import { closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { releaseLock, takeLock } from ${JSON.stringify(mod)};
const startAt = Number(process.env.START_AT);
writeFileSync(process.env.READY_DIR + "/" + process.pid, "");
const deadline = Date.now() + 10000;
while (readdirSync(process.env.READY_DIR).length < Number(process.env.RACE_N)) {
  if (Date.now() > deadline) throw new Error("race start barrier timed out");
  await Bun.sleep(5);
}
while (Date.now() < startAt) {}
${body}`);
  const env = { ...process.env, CLAUDESTRA_STATE_DIR: join(dir, "state"), START_AT: String(Date.now() + 1500), READY_DIR: readyDir,
    RACE_N: String(n), ...extraEnv };
  const procs = Array.from({ length: n }, () => Bun.spawn(["bun", script], { env, stdout: "pipe", stderr: "pipe" }));
  return Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as T));
}

describe("多进程抢锁", () => {
  // 旧写法（rename 活锁再放回）在这里约三成轮次出现 2~3 个持有者，8 轮几乎必挂
  test("预置一个死持有者的锁，4 个进程同时起跑抢接管：只有一个拿到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-build-lock-dead-"));
    try {
      for (let round = 0; round < 8; round++) {
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(join(dir, "state", "web-build.lock"), String(deadPid()));
        const outs = await race<{ got: boolean }>(dir, `const got = takeLock(); await Bun.sleep(750); if (got) releaseLock(); console.log(JSON.stringify({ got }));`, 4);
        expect(outs.filter((o) => o.got)).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("4 个进程同时起跑、各抢 30 次：临界区里从没出现过两个持有者，且确实都拿到过锁", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-build-lock-"));
    try {
      const body = `const marker = process.env.MARKER!;
let got = 0, overlap = 0;
for (let i = 0; i < 30; i++) {
  if (!takeLock()) { await Bun.sleep(1); continue; }
  got++;
  try { closeSync(openSync(marker, "wx")); } catch { overlap++; }
  await Bun.sleep(2);
  try { unlinkSync(marker); } catch {}
  releaseLock();
}
console.log(JSON.stringify({ got, overlap }));`;
      const outs = await race<{ got: number; overlap: number }>(dir, body, 4, { MARKER: join(dir, "inside") });
      expect(outs.reduce((n, o) => n + o.overlap, 0)).toBe(0);
      expect(outs.reduce((n, o) => n + o.got, 0)).toBeGreaterThan(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
