/**
 * 独立执行器入口与维护页:参数、依赖图(不带 manager 主入口与身份模块)、维护页的单次访问与固定动作、
 * 以及「bridge 被杀掉之后维护页与恢复按钮仍可用」。子进程都带测试标记,碰不到真实 launchd / tmux。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { raiseBarrier } from "../src/lib/state-maintenance/barrier.ts";
import { pageHandler } from "../src/lib/state-maintenance/page.ts";
import { maintenanceRoot, prepareMaintenanceRoot } from "../src/lib/state-maintenance/paths.ts";
import { createRequest, loadState, newState, readJson, runPaths, saveState, takeRequest } from "../src/lib/state-maintenance/run-store.ts";
import { parseRunnerArgs } from "../src/lib/state-maintenance/runner-args.ts";

const SRC = resolve(import.meta.dir, "../src");
const bases: string[] = [];
const kill: number[] = [];
afterEach(() => {
  for (const p of kill.splice(0)) try { process.kill(p, "SIGKILL"); } catch { /* 已经退出 */ }
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function fx(phase: "ready" | "failed-holding") {
  const home = mkdtempSync(join(realpathSync("/tmp"), "smaint-runner-"));
  bases.push(home);
  const oldRoot = join(home, ".claude-orchestrator");
  mkdirSync(oldRoot);
  const maint = maintenanceRoot(home);
  prepareMaintenanceRoot(maint, [oldRoot]);
  createRequest(maint, { runId: "run-1", actor: "owner", reportRunId: "obs-1", reportRel: "reports/obs-1/observe.json", reportSha256: "x",
    baseline: "b", rootsDigest: "d", createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  if (phase === "failed-holding") {
    takeRequest(maint, "run-1");
    raiseBarrier(maint, { runId: "run-1", since: Date.now(), reason: "test" });
  }
  saveState(maint, newState("run-1"), phase);
  return { home, oldRoot, maint };
}

describe("[验收线 2] 独立执行器入口", () => {
  test("参数:只认固定子命令,runId 校验,不接受任意路径以外的东西", () => {
    expect(parseRunnerArgs(["serve", "run-1"])).toEqual({ cmd: "serve", runId: "run-1", recover: false });
    expect(parseRunnerArgs(["serve", "run-1", "--recover"])).toEqual({ cmd: "serve", runId: "run-1", recover: true });
    expect(parseRunnerArgs(["exec", "../etc"])).toHaveProperty("error");
    expect(parseRunnerArgs(["shell", "x"])).toHaveProperty("error");
    expect(parseRunnerArgs(["note", "relative"])).toHaveProperty("error");
  });

  test("静态依赖图不含 manager 主入口、台账与任何身份读取 / 生成模块(台账只在 note 子进程里动态加载)", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const seen = new Set<string>();
    const dynamic: string[] = [];
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const i of t.scanImports(readFileSync(f, "utf8"))) {
        if (!i.path.startsWith(".")) continue;
        const p = resolve(dirname(f), i.path).replace(/\.js$/, ".ts");
        if (p.endsWith("/state-maintenance/ledger-access.ts")) dynamic.push(`${i.kind}:${p.slice(SRC.length)}`);
        else if (existsSync(p)) walk(p); // 其余动态 import 也一起走:运行时同样会加载
      }
    };
    walk(join(SRC, "state-maintenance-runner.ts"));
    const bad = [...seen].filter((f) => /\/(manager|bridge)\.ts$|instance-id|instance-key|key-file|e2e-machine-key|ledger-/.test(f));
    expect(bad).toEqual([]);
    expect(dynamic).toEqual(["dynamic-import:/lib/state-maintenance/ledger-access.ts"]);
  });

  test("manager.ts 只加了一行动态分派,bridge 面板入口一行转交", () => {
    const m = readFileSync(join(SRC, "manager.ts"), "utf8").split("\n").filter((l) => l.includes("state-maintenance"));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('import("./manager/state-maintenance.js")');
    const b = readFileSync(join(SRC, "bridge/management.ts"), "utf8").split("\n").filter((l) => l.includes("smaint"));
    expect(b).toHaveLength(2);
  });
});

describe("[验收线 2] 独立维护页", () => {
  const PORT = 4321;
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { host: `127.0.0.1:${PORT}`, ...(init.cookie ? { cookie: init.cookie } : {}) } });

  async function login(h: ReturnType<typeof pageHandler>): Promise<{ cookie: string; csrf: string }> {
    const r = await h.fetch(req(`/?code=${h.code}`));
    expect(r.status).toBe(303);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await h.fetch(req("/", { cookie }))).text();
    return { cookie, csrf: /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "" };
  }

  const form = (csrf: string) => { const f = new FormData(); f.set("csrf", csrf); return f; };

  test("访问码只能用一次;别的 Host、没会话、CSRF 不符都拒绝;没有任意路径 / 命令入口", async () => {
    const f = fx("ready");
    const h = pageHandler({ maintRoot: f.maint, runId: "run-1", executorAlive: () => false, spawnRecover: () => {}, now: () => Date.now() }, () => PORT);
    expect((await h.fetch(new Request(`http://evil.test/?code=${h.code}`, { headers: { host: "evil.test" } }))).status).toBe(403);
    const { cookie, csrf } = await login(h);
    expect((await h.fetch(req(`/?code=${h.code}`))).status).toBe(403);
    expect((await h.fetch(req("/"))).status).toBe(401);
    expect((await h.fetch(req("/cancel", { method: "POST", body: form("bad"), cookie }))).status).toBe(403);
    expect((await h.fetch(req("/run?cmd=rm", { method: "POST", body: form(csrf), cookie }))).status).toBe(404);
    expect((await h.fetch(req("/cancel", { method: "POST", body: form(csrf), cookie }))).status).toBe(200);
    expect(existsSync(runPaths(f.maint, "run-1").cancel)).toBe(true);
  });

  test("已动根的阶段不能取消;执行器还活着不另起恢复;停在 failed-holding 时恢复按钮起恢复执行器", async () => {
    const f = fx("failed-holding");
    let alive = true;
    let spawned = 0;
    const h = pageHandler({ maintRoot: f.maint, runId: "run-1", executorAlive: () => alive, spawnRecover: () => void spawned++, now: () => Date.now() }, () => PORT);
    const { cookie, csrf } = await login(h);
    expect((await h.fetch(req("/cancel", { method: "POST", body: form(csrf), cookie }))).status).toBe(409);
    expect((await h.fetch(req("/recover", { method: "POST", body: form(csrf), cookie }))).status).toBe(409);
    alive = false;
    expect((await h.fetch(req("/recover", { method: "POST", body: form(csrf), cookie }))).status).toBe(200);
    expect(spawned).toBe(1);
  });

  test("bridge 被整组杀掉后,执行器照常跑完、维护页与恢复按钮仍可用", async () => {
    const f = fx("failed-holding");
    const env = { ...process.env, HOME: f.home, CLAUDESTRA_STATE_DIR: f.oldRoot };
    const realDeps = join(SRC, "lib/state-maintenance/real-deps.ts");
    const bridge = spawn(process.execPath, ["-e",
      `const m = await import(${JSON.stringify(realDeps)}); m.spawnRunner(${JSON.stringify(f.maint)}, ["serve", "run-1", "--recover"]); await Bun.sleep(60000);`],
    { detached: true, stdio: "ignore", env });
    kill.push(bridge.pid!);
    const p = runPaths(f.maint, "run-1");
    for (let i = 0; i < 100 && !existsSync(p.access); i++) await Bun.sleep(100);
    const access = readJson<{ port: number; code: string }>(p.access)!;
    kill.push(Number(readFileSync(p.servePid, "utf8")));
    process.kill(-bridge.pid!, "SIGKILL"); // 「bridge」连同它的进程组一起没了
    let s = loadState(f.maint, "run-1")!;
    for (let i = 0; i < 100 && !s.history.some((h) => h.note === "recover" && s.phase === "failed-holding" && s.error); i++) {
      await Bun.sleep(100);
      s = loadState(f.maint, "run-1")!;
    }
    expect(s.error).toContain("测试进程不碰真实 launchd"); // 恢复执行器跑完了,停写确认不过就保持屏障
    const base = `http://127.0.0.1:${access.port}`;
    const login = await fetch(`${base}/?code=${access.code}`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(page).toContain("failed-holding");
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)![1]!;
    const fd = new FormData();
    fd.set("csrf", csrf);
    const r = await fetch(`${base}/recover`, { method: "POST", body: fd, headers: { cookie } });
    expect(await r.text()).toContain("已起恢复执行器");
  }, 30_000);
});
