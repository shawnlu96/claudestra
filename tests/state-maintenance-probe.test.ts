/**
 * 真实停写探针与停 / 恢复写者:命令输出全是模拟(隔离服务),核判定规则——任何失败、未知句柄、恒空扫描都不放行。
 */
import { describe, expect, test } from "bun:test";
import { confirmStopped, scanOnce, type ProbeDeps, type RunResult } from "../src/lib/state-maintenance/probe.ts";
import { restoreAll, stopAll, SERVICE_LABELS, type ServiceDeps } from "../src/lib/state-maintenance/services.ts";

const ROOTS = ["/tmp/smaint-probe/home/.claude-orchestrator", "/tmp/smaint-probe/home/.floka"];
const CANARY = "/tmp/smaint-probe/home/.claudestra-maintenance/state/control/executor.lock";
const SELF = 5000;

interface World { loaded: string[]; ps: string[]; lsof: string[]; fail: Partial<Record<string, RunResult>>; scans: number }

const world = (over: Partial<World> = {}): World => ({ loaded: [], ps: [`${SELF} 1 bun state-maintenance-runner.ts exec run-1`], lsof: [`p${SELF}`, `n${CANARY}`], fail: {}, scans: 0, ...over });

function deps(w: World, recorded: number[] = []): ProbeDeps {
  return {
    selfPid: SELF, uid: 501, labels: SERVICE_LABELS, canaryPath: CANARY, recordedPids: () => recorded, sleep: async () => {},
    run: async (cmd) => {
      const failed = w.fail[cmd[0]!];
      if (failed) return failed;
      if (cmd[0] === "launchctl") return { code: w.loaded.includes(cmd[2]!.split("/").pop()!) ? 0 : 113, stdout: "", stderr: "" };
      if (cmd[0] === "ps") return { code: 0, stdout: w.ps.join("\n"), stderr: "" };
      w.scans++;
      return { code: 0, stdout: w.lsof.join("\n"), stderr: "" };
    },
  };
}

describe("[验收线 2] 真实停写探针", () => {
  test("全停:launchd 无服务、无写者进程、两根无句柄、能看到自己与 canary → 两次都干净才通过", async () => {
    const w = world();
    expect(await confirmStopped(deps(w), ROOTS, 0)).toEqual([]);
    expect(w.scans).toBe(2);
  });

  test("任一守护进程仍在 launchd 里即拒绝", async () => {
    for (const label of SERVICE_LABELS) expect((await scanOnce(deps(world({ loaded: [label] })), ROOTS)).join()).toContain(label);
  });

  test("会话、channel-server、手工 manager、部署 / 更新进程、记录在案的后代 pid 都算写者", async () => {
    const lines = ["11 1 /Users/x/.local/bin/claude --resume abc", "12 11 bun /repo/src/channel-server.ts", "13 1 bun /repo/src/manager.ts restart a",
      "14 1 bun /repo/src/setup.ts", "15 1 codex exec", "16 1 tmux -S /tmp/claude-orchestrator/tmux.sock new"];
    for (const l of lines) expect(await scanOnce(deps(world({ ps: [...world().ps, l] })), ROOTS)).not.toEqual([]);
    const descendant = world({ ps: [...world().ps, "77 1 sleep 100"] });
    expect((await scanOnce(deps(descendant, [77]), ROOTS)).join()).toContain("已记录的会话进程 pid 77");
  });

  test("两根里的打开文件:未知进程、SQLite WAL / SHM、目录 / cwd、已删除仍打开的句柄、执行器自己——都拒绝", async () => {
    const holders = [
      ["p900", `n${ROOTS[0]}/ledger.sqlite-wal`], ["p901", `n${ROOTS[1]}/x.sqlite-shm`], ["p902", "fcwd", `n${ROOTS[0]}`],
      ["p903", `n${ROOTS[0]}/old.log (deleted)`], [`p${SELF}`, `n${ROOTS[0]}/registry.json`],
    ];
    for (const h of holders) {
      const out = await scanOnce(deps(world({ lsof: [...world().lsof, ...h] })), ROOTS);
      expect(out.join()).toMatch(/打开着 (legacy|floka)-state/);
    }
    expect((await scanOnce(deps(world({ lsof: [...world().lsof, "p903", `n${ROOTS[0]}/x`] })), ROOTS)).join()).toContain("未知进程 pid 903");
  });

  test("工具缺失、权限不足、退出码非 0、超时 → 探针失败即拒绝", async () => {
    const bad: RunResult[] = [
      { code: null, stdout: "", stderr: "", spawnError: "ENOENT" }, { code: 0, stdout: "", stderr: "lsof: Permission denied" },
      { code: 1, stdout: "", stderr: "" }, { code: null, stdout: "", stderr: "" },
    ];
    for (const tool of ["lsof", "ps", "launchctl"]) {
      for (const r of bad) {
        if (tool === "launchctl" && r.code === 1) continue; // launchctl 非 0 / 113 的码单独在下面
        expect(await scanOnce(deps(world({ fail: { [tool]: r } })), ROOTS)).not.toEqual([]);
      }
    }
    expect((await scanOnce(deps(world({ fail: { launchctl: { code: 5, stdout: "", stderr: "" } } })), ROOTS)).join()).toContain("探针失败");
  });

  test("恒空探针不算数:ps 里看不到自己、lsof 里看不到 canary,都判扫描不可信", async () => {
    expect((await scanOnce(deps(world({ ps: [] })), ROOTS)).join()).toContain("扫描不可信");
    expect((await scanOnce(deps(world({ lsof: [] })), ROOTS)).join()).toContain("扫描不可信");
  });

  test("单次为空不够:第二次扫到新写者即拒绝", async () => {
    const w = world();
    const d = deps(w);
    const run = d.run;
    d.run = async (cmd) => (cmd[0] === "ps" && w.scans >= 1 ? { code: 0, stdout: [...w.ps, "88 1 claude"].join("\n"), stderr: "" } : run(cmd));
    expect((await confirmStopped(d, ROOTS, 0)).join()).toContain("pid 88");
  });
});

function svc(loaded: Set<string>, calls: string[], alive: () => boolean): ServiceDeps {
  return {
    uid: 501, home: "/tmp/smaint-probe/home", sleep: async () => {}, drainMs: 10, pidAlive: alive,
    sessions: { snapshot: async () => ({ windows: ["master:master"], pids: [1] }), stop: async () => {}, windows: async () => ["master:master"] },
    run: async (cmd) => {
      calls.push(cmd.slice(0, 2).join(" ") + " " + (cmd[2] ?? "").split("/").pop());
      const label = (cmd[3] ?? cmd[2] ?? "").split("/").pop()!.replace(/\.plist$/, "");
      if (cmd[1] === "print") return { code: loaded.has(label) ? 0 : 113, stdout: "", stderr: "" };
      if (cmd[1] === "bootout") loaded.delete(label);
      if (cmd[1] === "bootstrap") loaded.add(label);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("[验收线 2] 停 / 恢复写者", () => {
  test("先停自动拉起与入口,再停会话,最后 bridge;用 disable + bootout(不只 kill PID);只恢复原本在跑的", async () => {
    const loaded = new Set(["com.claudestra.launcher", "com.claudestra.cron", "com.claudestra.bridge"]);
    const calls: string[] = [];
    const states = SERVICE_LABELS.map((label) => ({ label, loaded: loaded.has(label), plist: `Library/LaunchAgents/${label}.plist` }));
    const stopped: string[] = [];
    expect(await stopAll(svc(loaded, calls, () => false), states, { windows: ["master:master"], pids: [1] }, stopped)).toBeNull();
    expect(stopped).toEqual(["com.claudestra.launcher", "com.claudestra.cron", "sessions", "com.claudestra.bridge"]);
    expect(calls.filter((c) => c.startsWith("launchctl disable"))).toHaveLength(3);
    expect(calls.some((c) => c.includes("scheduler") && !c.startsWith("launchctl print"))).toBe(false);
    const r = await restoreAll(svc(loaded, calls, () => false), states, { windows: ["master:master"], pids: [1] }, stopped, 10);
    expect(r.ok).toBe(true);
    expect([...loaded].sort()).toEqual(["com.claudestra.bridge", "com.claudestra.cron", "com.claudestra.launcher"]);
  });

  test("会话不愿退出:拒绝,不补刀强杀", async () => {
    const loaded = new Set<string>();
    const calls: string[] = [];
    const states = SERVICE_LABELS.map((label) => ({ label, loaded: false, plist: "" }));
    const err = await stopAll(svc(loaded, calls, () => true), states, { windows: ["master:master"], pids: [1] }, []);
    expect(err).toContain("没有退出");
    expect(calls.some((c) => c.includes("kill"))).toBe(false);
  });
});
