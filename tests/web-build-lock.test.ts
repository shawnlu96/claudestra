/**
 * web 构建锁（src/lib/web-build-lock.ts）：锁文件从诞生起就带完整 pid；内容异常不删、直接失败；只接管已死的持有者；
 * 多进程反复抢锁时临界区里永远只有一个（codex 复核用两个进程复现过旧写法的双持有）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { releaseLock, takeLock } from "../src/lib/web-build-lock.js";

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
  test("release 只删自己的锁", () => {
    writeFileSync(LOCK, "999999");
    releaseLock();
    expect(readFileSync(LOCK, "utf8")).toBe("999999");
  });
});

describe("多进程抢锁", () => {
  test("4 个进程各抢 30 次：临界区里从没出现过两个持有者，且确实都拿到过锁", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-build-lock-"));
    try {
      const mod = resolve(import.meta.dir, "../src/lib/web-build-lock.ts");
      const script = join(dir, "worker.ts");
      writeFileSync(script, `
import { closeSync, openSync, unlinkSync } from "node:fs";
import { releaseLock, takeLock } from ${JSON.stringify(mod)};
const marker = process.env.MARKER!;
let got = 0, overlap = 0;
for (let i = 0; i < 30; i++) {
  if (!takeLock()) { await Bun.sleep(1); continue; }
  got++;
  try { closeSync(openSync(marker, "wx")); } catch { overlap++; }
  await Bun.sleep(2);
  try { unlinkSync(marker); } catch {}
  releaseLock();
}
console.log(JSON.stringify({ got, overlap }));
`);
      const env = { ...process.env, CLAUDESTRA_STATE_DIR: join(dir, "state"), MARKER: join(dir, "inside") };
      const procs = [0, 1, 2, 3].map(() => Bun.spawn(["bun", script], { env, stdout: "pipe", stderr: "pipe" }));
      const outs = await Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as { got: number; overlap: number }));
      expect(outs.reduce((n, o) => n + o.overlap, 0)).toBe(0);
      expect(outs.reduce((n, o) => n + o.got, 0)).toBeGreaterThan(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
