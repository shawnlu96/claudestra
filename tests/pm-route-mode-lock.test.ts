/**
 * agents-PULLTODO1：pm-digest-mode.json 的三个 setter 共用一把文件锁（lib/pm-route-mode.ts withModeLock）。
 * 验收线 3：两个进程并发调 setPmRouteMode 与 setPmDigestPull（不同项目），两边的写都保留。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { pmDigestPull, pmRouteMode, setPmRouteMode, withModeLock } from "../src/lib/pm-route-mode.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pm-route-lock-")); dirs.push(d); return d; };
const MOD = join(import.meta.dir, "../src/lib/pm-route-mode.ts");
const N = 25;

function writer(path: string, fn: "setPmRouteMode" | "setPmDigestPull", prefix: string, mode: string) {
  const code = `import { ${fn} } from ${JSON.stringify(MOD)};
for (let i = 0; i < ${N}; i++) await ${fn}(${JSON.stringify(path)}, ${JSON.stringify(prefix)} + i, ${JSON.stringify(mode)});`;
  return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
}

test("[验收线 3] 两个进程并发写路由开关与拉取开关（不同项目）：两边的写都保留", async () => {
  const path = join(tmp(), "pm-digest-mode.json");
  const a = writer(path, "setPmRouteMode", "route-", "on"), b = writer(path, "setPmDigestPull", "pull-", "off");
  expect([await a.exited, await b.exited]).toEqual([0, 0]);
  for (let i = 0; i < N; i++) {
    expect(pmRouteMode(path, `route-${i}`)).toBe("on");
    expect(pmDigestPull(path, `pull-${i}`)).toBe("off");
  }
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("三个 setter 在同一进程里不 await 地并发调用也都保留（同一把锁串行）", async () => {
  const dir = tmp(), s = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  await Promise.all([s.setMode("a", "on"), s.setRouteMode("b", "off"), s.setPullMode("c", "off")]);
  expect(JSON.parse(readFileSync(s.modePath, "utf8"))).toEqual({ projects: { a: "on" }, routeProjects: { b: "off" }, pullProjects: { c: "off" } });
});

test("锁在 pm-digest-mode.json 同目录；拿不到锁按超时报错、不写", async () => {
  const dir = tmp(), path = join(dir, "pm-digest-mode.json");
  await withModeLock(path, () => expect(existsSync(`${path}.lock`)).toBe(true));
  mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, "owner"), "someone-else"); // 别人一直占着（未过期）
  let ran = false;
  await expect(withModeLock(path, () => { ran = true; }, 0)).rejects.toThrow("拿不到"); // 到了 file-lock 的等待上限：报错，不裸写
  expect(ran).toBe(false);
  const late = setPmRouteMode(path, "p", "on");
  await expect(Promise.race([late, new Promise((r) => setTimeout(() => r("still-waiting"), 300))])).resolves.toBe("still-waiting");
  rmSync(`${path}.lock`, { recursive: true, force: true }); // 放掉后照常写进去
  await late;
  expect(pmRouteMode(path, "p")).toBe("on");
});
