/**
 * 身份生成屏障:真实身份读取器(instance-id / instance-key / key-file)在维护中零生成、零状态写入并明确拒绝;窗口外首次生成照旧。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { instanceIdSync } from "../src/lib/instance-id.ts";
import { instanceKeySync } from "../src/lib/instance-key.ts";
import { readOrCreateKeyFile } from "../src/lib/key-file.ts";
import { MaintenanceBarrierError, raiseBarrier } from "../src/lib/state-maintenance/barrier.ts";
import { maintenanceRoot, maintPaths, prepareMaintenanceRoot } from "../src/lib/state-maintenance/paths.ts";

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

function fx(withBarrier: boolean): { home: string; state: string; maint: string } {
  const home = mkdtempSync(join(realpathSync("/tmp"), "smaint-barrier-"));
  bases.push(home);
  const state = join(home, ".claude-orchestrator");
  const maint = maintenanceRoot(home);
  prepareMaintenanceRoot(maint, [state]);
  if (withBarrier) raiseBarrier(maint, { runId: "run-1", since: Date.now(), reason: "test" });
  return { home, state, maint };
}

const genKey = () => "-----BEGIN PRIVATE KEY-----\nnot-used\n-----END PRIVATE KEY-----\n";

describe("[验收线 3] 身份生成屏障", () => {
  test("缺失:instance-id / 签名私钥 / 机器钥都明确拒绝,状态目录一个文件、一个目录都不建", () => {
    const f = fx(true);
    expect(() => instanceIdSync(f.state, f.maint)).toThrow(MaintenanceBarrierError);
    expect(() => instanceKeySync(f.state, f.maint)).toThrow(MaintenanceBarrierError);
    expect(() => readOrCreateKeyFile(join(f.state, "e2e-key.pem"), genKey, f.maint)).toThrow(MaintenanceBarrierError);
    expect(existsSync(f.state)).toBe(false);
  });

  test("无效:坏 instance-id、坏私钥都拒绝替换,原文件逐字不变,不留临时文件", () => {
    const f = fx(true);
    mkdirSync(f.state);
    writeFileSync(join(f.state, "instance-id"), "bad id with spaces\n");
    writeFileSync(join(f.state, "instance-key.pem"), "garbage");
    expect(() => instanceIdSync(f.state, f.maint)).toThrow(MaintenanceBarrierError);
    expect(() => instanceKeySync(f.state, f.maint)).toThrow(MaintenanceBarrierError);
    expect(readFileSync(join(f.state, "instance-id"), "utf8")).toBe("bad id with spaces\n");
    expect(readFileSync(join(f.state, "instance-key.pem"), "utf8")).toBe("garbage");
    expect(readdirSync(f.state).sort()).toEqual(["instance-id", "instance-key.pem"]);
  });

  test("维护错误不被吞成「不带 id / 不带签名」继续:错误原样抛给调用方", () => {
    const f = fx(true);
    let caught: unknown = null;
    try {
      instanceIdSync(f.state, f.maint);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MaintenanceBarrierError);
    expect((caught as Error).message).toContain("拒绝生成");
  });

  test("屏障不随进程消失:落屏障的进程退出后,文件仍在、仍生效", async () => {
    const f = fx(false);
    const child = Bun.spawn([process.execPath, "-e",
      `const b = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/state-maintenance/barrier.ts"))});
       b.raiseBarrier(${JSON.stringify(f.maint)}, { runId: "run-x", since: 1, reason: "child" });`], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(() => instanceIdSync(f.state, f.maint)).toThrow(MaintenanceBarrierError);
  });

  test("检查后并发进入维护:读取器已过第一次检查、在等互斥时屏障落下 → 取到互斥后再查,零生成", async () => {
    const f = fx(false);
    const lock = join(maintPaths(f.maint).control, "identity.lock");
    writeFileSync(lock, String(process.pid)); // 模拟执行器正持有互斥
    const child = Bun.spawn([process.execPath, "-e",
      `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/instance-id.ts"))});
       try { console.log("ID:" + m.instanceIdSync(${JSON.stringify(f.state)}, ${JSON.stringify(f.maint)})); }
       catch (e) { console.log("ERR:" + e.name); }`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: f.home } });
    await Bun.sleep(400);
    writeFileSync(join(maintPaths(f.maint).control, "barrier.json"), JSON.stringify({ runId: "run-1", since: Date.now(), reason: "x" }));
    unlinkSync(lock);
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out.trim()).toBe("ERR:MaintenanceBarrierError");
    expect(existsSync(f.state)).toBe(false);
  });

  test("默认维护根(真实 home 下的固定位置)同样生效:子进程只设 HOME,不传任何路径", async () => {
    const f = fx(true);
    const child = Bun.spawn([process.execPath, "-e",
      `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/instance-key.ts"))});
       try { m.instanceKeySync(${JSON.stringify(f.state)}); console.log("GEN"); } catch (e) { console.log("ERR:" + e.name); }`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: f.home, CLAUDESTRA_STATE_DIR: f.state } });
    expect((await new Response(child.stdout).text()).trim()).toBe("ERR:MaintenanceBarrierError");
    expect(existsSync(f.state)).toBe(false);
  });

  test("真实机器钥读取器 machineE2eKey:缺失、无效都把屏障错误原样抛给调用方,且不缓存失败", async () => {
    const f = fx(true);
    mkdirSync(f.state, { recursive: true });
    const child = Bun.spawn([process.execPath, "-e",
      `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/e2e-machine-key.ts"))});
       const fs = await import("node:fs");
       const dir = ${JSON.stringify(f.state)}, pem = dir + "/e2e-key.pem", barrier = ${JSON.stringify(join(maintPaths(f.maint).control, "barrier.json"))};
       const out = [];
       const tryLoad = async () => { try { const k = await m.machineE2eKey(dir); out.push(k ? "KEY" : "NULL"); } catch (e) { out.push("ERR:" + e.name); } };
       await tryLoad();
       out.push(fs.existsSync(pem) ? "PEM" : "NOPEM");
       fs.writeFileSync(pem, "garbage", { mode: 0o600 });
       await tryLoad();
       out.push(fs.readFileSync(pem, "utf8"));
       fs.unlinkSync(pem); fs.unlinkSync(barrier);
       await tryLoad();
       console.log(out.join(","));`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: f.home } });
    const out = (await new Response(child.stdout).text()).trim();
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    // 缺失 → 屏障错误、没生成;无效 → 屏障错误、原文不动;屏障撤掉后再调 → 生成(证明前两次失败没进缓存)
    expect(out).toBe("ERR:MaintenanceBarrierError,NOPEM,ERR:MaintenanceBarrierError,garbage,KEY");
    expect(readdirSync(f.state)).toEqual(["e2e-key.pem"]);
  });

  test("窗口外首次生成照旧:没有屏障(控制目录在 / 不在)都会生成并落盘,再读是同一个", () => {
    const f = fx(false);
    const id = instanceIdSync(f.state, f.maint);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(readFileSync(join(f.state, "instance-id"), "utf8").trim()).toBe(id);
    expect(instanceKeySync(f.state, f.maint)?.publicKey).toBeTruthy();
    expect(existsSync(join(maintPaths(f.maint).control, "identity.lock"))).toBe(false);
    const bare = mkdtempSync(join(realpathSync("/tmp"), "smaint-nomaint-"));
    bases.push(bare);
    const other = join(bare, "state");
    expect(instanceIdSync(other, join(bare, "never-created"))).toMatch(/^[0-9a-f]{24}$/);
    expect(existsSync(join(bare, "never-created"))).toBe(false);
  });
});
