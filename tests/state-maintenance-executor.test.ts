/**
 * 维护执行器状态机:隔离服务(launchd / ps / lsof / tmux 全是模拟)、临时根、合成数据。不碰真实服务与生产目录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { nodeStateFs } from "../src/lib/floka-migration/state/fs-adapter.ts";
import type { StateFs } from "../src/lib/floka-migration/state/types.ts";
import { barrierActive } from "../src/lib/state-maintenance/barrier.ts";
import { executeRun, recoverRun, rootsDigest, type ExecDeps } from "../src/lib/state-maintenance/executor.ts";
import { maintPaths, prepareMaintenanceRoot } from "../src/lib/state-maintenance/paths.ts";
import type { Run } from "../src/lib/state-maintenance/probe.ts";
import { buildObserveReport, sha256Hex, writeReport } from "../src/lib/state-maintenance/report.ts";
import { createRequest, loadState, newState, saveState } from "../src/lib/state-maintenance/run-store.ts";
import { SERVICE_LABELS } from "../src/lib/state-maintenance/services.ts";

class Crash extends Error {}
const PEM = String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

interface Sim {
  mode: string;
  loaded: Set<string>;
  sessionsAlive: boolean;
  procs: string[];
  files: { pid: number; name: string }[];
  stuck: Set<string>;
  calls: string[];
  notes: unknown[];
  noteFails: boolean;
}

interface Fx { home: string; oldRoot: string; newRoot: string; maint: string; sim: Sim }

/** 隔离环境:/tmp 下(macOS 的 /var/folders 随机段会被凭据脱敏误认),旧根带身份与合成数据 */
function fixture(): Fx {
  const base = mkdtempSync(join(realpathSync("/tmp"), "smaint-exec-"));
  bases.push(base);
  const home = join(base, "home");
  const oldRoot = join(home, ".claude-orchestrator");
  mkdirSync(join(oldRoot, "ledger"), { recursive: true, mode: 0o700 });
  writeFileSync(join(oldRoot, "instance-id"), "a1b2c3d4e5f6\n", { mode: 0o600 });
  writeFileSync(join(oldRoot, "instance-key.pem"), PEM, { mode: 0o600 });
  writeFileSync(join(oldRoot, "peers.json"), "{\"httpPeers\":{}}", { mode: 0o600 });
  writeFileSync(join(oldRoot, "ledger", "ledger.sqlite"), "synthetic-ledger");
  const sim: Sim = { mode: "on", loaded: new Set(SERVICE_LABELS), sessionsAlive: true, procs: [], files: [], stuck: new Set(), calls: [], notes: [], noteFails: false };
  return { home, oldRoot, newRoot: join(home, ".floka"), maint: join(home, ".claudestra-maintenance", "state"), sim };
}

const ok = { code: 0, stdout: "", stderr: "" };

function fakeRun(fx: Fx): Run {
  const canary = join(maintPaths(fx.maint).control, "executor.lock");
  return async (cmd) => {
    fx.sim.calls.push(cmd.join(" "));
    const [tool, sub, target = ""] = cmd;
    if (tool === "launchctl") {
      const label = target.split("/").pop()!.replace(/\.plist$/, "");
      if (sub === "print") return { ...ok, code: fx.sim.loaded.has(label) ? 0 : 113 };
      if (sub === "bootout" && !fx.sim.stuck.has(label)) fx.sim.loaded.delete(label);
      if (sub === "bootstrap") fx.sim.loaded.add(cmd[3]!.split("/").pop()!.replace(/\.plist$/, ""));
      return ok;
    }
    if (tool === "ps") return { ...ok, stdout: [`${process.pid} 1 bun state-maintenance-runner.ts exec run-1`, ...fx.sim.procs].join("\n") };
    if (tool === "lsof") return { ...ok, stdout: [`p${process.pid}`, "f3", `n${canary}`, ...fx.sim.files.flatMap((f) => [`p${f.pid}`, "f9", `n${f.name}`])].join("\n") };
    return { ...ok, code: 1 };
  };
}

function deps(fx: Fx, over: Partial<ExecDeps> = {}): ExecDeps {
  const run = fakeRun(fx);
  const sleep = async () => {};
  const windows = ["master:master", "master:agent-a"];
  return {
    maintRoot: fx.maint, home: fx.home, oldRoot: fx.oldRoot, newRoot: fx.newRoot, fs: nodeStateFs,
    probe: { run, selfPid: process.pid, uid: 501, labels: SERVICE_LABELS, sleep },
    services: {
      run, uid: 501, home: fx.home, pidAlive: (p) => fx.sim.sessionsAlive && (p === 9001 || p === 9002), sleep, drainMs: 20,
      sessions: {
        snapshot: async () => ({ windows, pids: [9001, 9002] }),
        stop: async () => void (fx.sim.sessionsAlive = false),
        windows: async () => (fx.sim.loaded.has("com.claudestra.launcher") ? windows : []),
      },
    },
    readMode: () => fx.sim.mode, baseline: async () => "base1", version: "test", now: () => Date.now(), probeGapMs: 0, restoreWaitMs: 20,
    writeNote: async (n) => (fx.sim.notes.push(n), fx.sim.noteFails ? { ok: false, error: "留存未完成:台账锁住" } : { ok: true }),
    flushNotes: async () => ({ ok: true }),
    ...over,
  };
}

/** 预演报告 + 已授权请求 + 维护页就绪(ready),与生产 manager / serve 做的一致 */
async function prepare(fx: Fx, over: { expiresIn?: number; runId?: string } = {}): Promise<string> {
  const runId = over.runId ?? "run-1";
  prepareMaintenanceRoot(fx.maint, [fx.oldRoot, fx.newRoot]);
  const report = await buildObserveReport({ ...fx, fs: nodeStateFs, maintRoot: fx.maint, runId: "obs-1", mode: "on", version: "test", baseline: "base1", now: Date.now() });
  const saved = writeReport(fx.maint, "obs-1", "observe", report);
  createRequest(fx.maint, {
    runId, actor: "owner", reportRunId: "obs-1", reportRel: saved.rel, reportSha256: saved.sha256, baseline: "base1",
    rootsDigest: rootsDigest(fx.oldRoot, fx.newRoot), createdAt: Date.now(), expiresAt: Date.now() + (over.expiresIn ?? 600_000),
  });
  saveState(fx.maint, newState(runId), "ready");
  return runId;
}

const bootstraps = (fx: Fx) => fx.sim.calls.filter((c) => c.startsWith("launchctl bootstrap")).length;
const stages = (s: { comparisons: { stage: string; executed: boolean }[] }) => Object.fromEntries(s.comparisons.map((c) => [c.stage, c.executed]));

/** 适配器包一层:按名字注入一次故障或副作用 */
function hookFs(hook: Partial<Record<keyof StateFs, (...a: string[]) => Promise<void>>>): StateFs {
  return Object.fromEntries(Object.entries(nodeStateFs).map(([k, fn]) => [k, async (...a: string[]) => {
    const h = hook[k as keyof StateFs];
    if (h) await h(...a);
    return (fn as (...x: string[]) => unknown)(...a);
  }])) as unknown as StateFs;
}

describe("[验收线 4] 迁移、校验与回滚", () => {
  test("停写后迁移:清单前后一致,别名就位,屏障解除,原服务与会话按清单恢复,指针留存", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("migrated");
    expect(s.phase).toBe("done");
    expect(lstatSync(fx.oldRoot).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(fx.newRoot, "instance-key.pem"), "utf8")).toBe(PEM);
    const after = s.comparisons.find((c) => c.stage === "迁移后")!;
    expect(after.identityDiff).toEqual([]);
    expect(after.treeDiff).toEqual([]);
    expect(stages(s)).toEqual({ 迁移前: true, 迁移后: true, 回滚前: false, 回滚后: false });
    expect(s.comparisons.find((c) => c.stage === "回滚前")!.note).toBe("未执行");
    expect(barrierActive(fx.maint)).toBe(false);
    expect([...fx.sim.loaded].sort()).toEqual([...SERVICE_LABELS].sort());
    expect(s.restore).toEqual({ ok: true, problems: [], missingWindows: [] } as never);
    expect(fx.sim.notes).toHaveLength(1);
    expect(JSON.stringify(fx.sim.notes)).not.toContain(fx.home);
    const run = readFileSync(join(fx.maint, "reports", runId, "run.json"), "utf8");
    expect(run).not.toContain(fx.home);
    expect(run).not.toContain("PRIVATE KEY");
  });

  test("迁移后核对不过:持续停写下自动回滚当前数据,保留迁移期间新增的合成数据,留存真实前后对照", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    let injected = false;
    const fs = hookFs({
      symlink: async () => {
        if (injected) return;
        injected = true; // 建别名之前往新根塞一份新增数据:迁移后清单对不上 → 回滚,且回滚必须把它一起搬回
        writeFileSync(join(fx.newRoot, "added-during-window.json"), "{}");
      },
    });
    const s = await executeRun(deps(fx, { fs }), runId);
    expect(s.outcome).toBe("rolled-back");
    expect(s.phase).toBe("done");
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(existsSync(fx.newRoot)).toBe(false);
    expect(existsSync(join(fx.oldRoot, "added-during-window.json"))).toBe(true);
    expect(stages(s)).toEqual({ 迁移前: true, 迁移后: true, 回滚前: true, 回滚后: true });
    expect(s.comparisons.find((c) => c.stage === "迁移后")!.treeDiff!.join()).toContain("added-during-window.json");
    expect(s.comparisons.find((c) => c.stage === "回滚后")!.treeDiff).toEqual([]);
    expect(barrierActive(fx.maint)).toBe(false);
    expect(bootstraps(fx)).toBe(4);
  });

  test("执行器在搬根后崩溃:屏障与停写保持;恢复按原 journal 续补偿,不重复迁移", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const crash = (p: string) => { if (p === "applied:state-move") throw new Crash(p); };
    await expect(executeRun(deps(fx, { crashAt: crash }), runId)).rejects.toThrow(Crash);
    expect(loadState(fx.maint, runId)!.phase).toBe("migrating");
    expect(barrierActive(fx.maint)).toBe(true);
    expect(bootstraps(fx)).toBe(0);
    expect(existsSync(fx.oldRoot)).toBe(false);
    const s = await recoverRun(deps(fx), runId);
    expect(s.outcome).toBe("rolled-back");
    expect(readFileSync(join(fx.oldRoot, "instance-id"), "utf8")).toBe("a1b2c3d4e5f6\n");
    expect(existsSync(fx.newRoot)).toBe(false);
    expect(barrierActive(fx.maint)).toBe(false);
    expect(bootstraps(fx)).toBe(4);
    await expect(executeRun(deps(fx), runId)).rejects.toThrow("拒绝重复执行");
  });

  test("failed-holding 后再恢复成功:新结果另存一版报告与指针,旧失败报告字节不变,回滚证据真实留存", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const crash = (p: string) => { if (p === "applied:state-move") throw new Crash(p); };
    await expect(executeRun(deps(fx, { crashAt: crash }), runId)).rejects.toThrow(Crash);
    const ledger = new Map<string, string>();
    const writeNote: ExecDeps["writeNote"] = async (n) => {
      const key = `${n.runId}:${n.op}:${n.seq ?? 1}`;
      if (!ledger.has(key)) ledger.set(key, n.reportSha256);
      return ledger.get(key) === n.reportSha256 ? { ok: true } : { ok: false, error: "指针写入后复核不到,按未落库处理" };
    };
    const d = deps(fx, { writeNote });
    const inner = d.probe.run;
    let lsofDown = true;
    d.probe.run = async (cmd) => (cmd[0] === "lsof" && lsofDown ? { code: null, stdout: "", stderr: "", spawnError: "ENOENT" } : inner(cmd));
    const first = await recoverRun(d, runId);
    expect([first.outcome, first.phase]).toEqual(["failed", "failed-holding"]);
    const failedRel = first.report!.rel;
    const failedBytes = readFileSync(join(fx.maint, failedRel), "utf8");
    lsofDown = false;
    const s = await recoverRun(d, runId);
    expect([s.outcome, s.phase]).toEqual(["rolled-back", "done"]);
    expect(s.report!.rel).not.toBe(failedRel);
    expect(readFileSync(join(fx.maint, failedRel), "utf8")).toBe(failedBytes);
    const rep = JSON.parse(readFileSync(join(fx.maint, s.report!.rel), "utf8"));
    expect(rep.outcome).toBe("rolled-back");
    expect(rep.supersedes).toEqual({ rel: failedRel, sha256: first.report!.sha256 });
    expect(Object.fromEntries(rep.comparisons.map((c: { stage: string; executed: boolean }) => [c.stage, c.executed]))).toMatchObject({ 迁移前: true, 迁移后: true, 回滚后: true });
    expect(s.note).toEqual({ ok: true });
    expect(ledger.get(`${runId}:state_maintenance_run:1`)).toBe(first.report!.sha256);
    expect(ledger.get(`${runId}:state_maintenance_run:2`)).toBe(s.report!.sha256);
    expect(barrierActive(fx.maint)).toBe(false);
  });

  test("回滚失败:不解除屏障、不重启任何写者,停在 failed-holding,留存失败原因", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    let phase = 0;
    const fs = hookFs({
      symlink: async () => void (phase === 0 && (phase = 1, writeFileSync(join(fx.newRoot, "drift"), "x"))),
      rename: async (from) => { if (from === fx.newRoot && phase >= 1) throw new Error("EIO 模拟回滚改名失败"); },
    });
    const s = await executeRun(deps(fx, { fs }), runId);
    expect(s.outcome).toBe("failed");
    expect(s.phase).toBe("failed-holding");
    expect(barrierActive(fx.maint)).toBe(true);
    expect(bootstraps(fx)).toBe(0);
    expect(s.error).toContain("回滚没完成");
    expect(existsSync(join(fx.maint, "reports", runId, "run.json"))).toBe(true);
  });
});

describe("[验收线 5] 边界与留存", () => {
  test("双数据根:停写复核时拒绝,不搬根,恢复写者并解除屏障", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    mkdirSync(fx.newRoot);
    writeFileSync(join(fx.newRoot, "other"), "x");
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(s.error).toContain("根形态");
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(barrierActive(fx.maint)).toBe(false);
    expect(bootstraps(fx)).toBe(4);
  });

  test("未知别名:旧根是指向别处的 symlink,拒绝", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const elsewhere = join(fx.home, "elsewhere");
    rmSync(fx.oldRoot, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, fx.oldRoot);
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(lstatSync(fx.oldRoot).isSymbolicLink()).toBe(true);
  });

  test("跨设备:迁移被拒、不复制,根原样", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const fs: StateFs = { ...nodeStateFs, lstat: async (p) => {
      const st = await nodeStateFs.lstat(p);
      return st && p === fx.home ? { ...st, dev: st.dev + 1 } : st;
    } };
    const s = await executeRun(deps(fx, { fs }), runId);
    expect(s.outcome).toBe("refused");
    expect(s.error).toContain("同一文件系统");
    expect(existsSync(fx.newRoot)).toBe(false);
  });

  test("缺身份:停写后发现私钥没了,拒绝且不生成", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    rmSync(join(fx.oldRoot, "instance-key.pem"));
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(existsSync(join(fx.oldRoot, "instance-key.pem"))).toBe(false);
  });

  test("过期请求、报告变了、档位不是 on:还没停任何服务就拒绝", async () => {
    for (const mut of ["expired", "report", "mode"] as const) {
      const fx = fixture();
      const runId = await prepare(fx, { expiresIn: mut === "expired" ? -1 : 600_000 });
      if (mut === "report") writeFileSync(join(fx.maint, "reports", "obs-1", "observe.json"), "{}");
      if (mut === "mode") fx.sim.mode = "observe";
      const s = await executeRun(deps(fx), runId);
      expect(s.outcome).toBe("refused");
      expect(fx.sim.calls.filter((c) => c.includes("bootout"))).toEqual([]);
      expect(barrierActive(fx.maint)).toBe(false);
    }
  });

  test("停写后身份与批准报告不一致:拒绝", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    writeFileSync(join(fx.oldRoot, "instance-id"), "ffffffff\n");
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(s.error).toContain("身份与批准的报告不一致");
  });

  test("指针写失败:明确留存未完成;恢复按钮补记,不重复迁移", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    fx.sim.noteFails = true;
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("migrated");
    expect(s.note).toEqual({ ok: false, error: "留存未完成:台账锁住" });
    let flushed = 0;
    const r = await recoverRun(deps(fx, { flushNotes: async () => (flushed++, { ok: true }) }), runId);
    expect(flushed).toBe(1);
    expect(r.note).toEqual({ ok: true });
    expect(r.outcome).toBe("migrated");
    expect(fx.sim.calls.filter((c) => c.includes("bootout")).length).toBe(4);
  });

  test("执行器在落屏障后、迁移前崩溃:恢复时确认没动根,恢复写者并解除屏障", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    await expect(executeRun(deps(fx, { crashAt: (p) => { if (p === "migrate:start") throw new Crash(p); } }), runId)).rejects.toThrow(Crash);
    expect(barrierActive(fx.maint)).toBe(true);
    const s = await recoverRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(barrierActive(fx.maint)).toBe(false);
    expect(bootstraps(fx)).toBe(4);
  });
});

describe("[验收线 5] 停 / 恢复写者途中崩溃可幂等恢复", () => {
  /** 包一层 launchctl:命中第一次就让执行器「崩溃」(异常穿出 executeRun),之后照常 */
  function crashOnce(fx: Fx, d: ExecDeps, hit: (cmd: string[]) => boolean, after = true): ExecDeps {
    let fired = false;
    const inner = d.services.run;
    d.services.run = async (cmd, t) => {
      if (!fired && hit(cmd)) {
        fired = true;
        if (after) await inner(cmd, t);
        throw new Crash(cmd.join(" "));
      }
      return inner(cmd, t);
    };
    return d;
  }

  test("launcher 已卸载后执行器崩溃:停用意图先落盘,恢复按钮按它拉回 launcher、解除屏障", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const d = crashOnce(fx, deps(fx), (c) => c[1] === "bootout" && c[2]!.endsWith("launcher"));
    await expect(executeRun(d, runId)).rejects.toThrow(Crash);
    expect(fx.sim.loaded.has("com.claudestra.launcher")).toBe(false);
    expect(loadState(fx.maint, runId)!.stopped).toEqual(["com.claudestra.launcher"]);
    const s = await recoverRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(s.phase).toBe("refused");
    expect([...fx.sim.loaded].sort()).toEqual([...SERVICE_LABELS].sort());
    expect(bootstraps(fx)).toBe(1); // 只拉回真停了的那个,在跑的不重复 bootstrap
    expect(barrierActive(fx.maint)).toBe(false);
  });

  test("停用命令发出前崩溃(意图已落、实际没停):恢复不重复拉起在跑的服务", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const d = crashOnce(fx, deps(fx), (c) => c[1] === "disable" && c[2]!.endsWith("scheduler"), false);
    await expect(executeRun(d, runId)).rejects.toThrow(Crash);
    const s = await recoverRun(deps(fx), runId);
    expect(s.phase).toBe("refused");
    expect([...fx.sim.loaded].sort()).toEqual([...SERVICE_LABELS].sort());
    expect(bootstraps(fx)).toBe(1);
  });

  test("迁移成功、解除屏障前崩溃:phase=restoring;恢复解除屏障并按原清单恢复,不重复迁移", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    await expect(executeRun(deps(fx, { crashAt: (p) => { if (p === "restore:before-lift") throw new Crash(p); } }), runId)).rejects.toThrow(Crash);
    expect(loadState(fx.maint, runId)!.phase).toBe("restoring");
    expect(barrierActive(fx.maint)).toBe(true);
    const s = await recoverRun(deps(fx), runId);
    expect([s.outcome, s.phase]).toEqual(["migrated", "done"]);
    expect(barrierActive(fx.maint)).toBe(false);
    expect([...fx.sim.loaded].sort()).toEqual([...SERVICE_LABELS].sort());
    expect(fx.sim.notes).toHaveLength(1);
    expect(lstatSync(fx.oldRoot).isSymbolicLink()).toBe(true);
  });

  test("屏障已解除、恢复写者前崩溃(phase=restoring、无屏障):恢复按钮续恢复,不报「需人工核查」", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const d = crashOnce(fx, deps(fx), (c) => c[1] === "enable", false);
    // 第一次 enable 抛出:进程内被记为恢复失败;再模拟进程真崩在 restoring(状态改回 restoring)
    const first = await executeRun(d, runId);
    expect(first.phase).toBe("restore-failed");
    expect(barrierActive(fx.maint)).toBe(false);
    saveState(fx.maint, { ...first, restore: undefined }, "restoring");
    const s = await recoverRun(deps(fx), runId);
    expect([s.outcome, s.phase]).toEqual(["migrated", "done"]);
    expect([...fx.sim.loaded].sort()).toEqual([...SERVICE_LABELS].sort());
    expect(s.restore?.ok).toBe(true);
  });

  test("留存阶段崩溃(写指针时):屏障保持;恢复补完留存与恢复,指针只记一条", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    let boom = true;
    const writeNote: ExecDeps["writeNote"] = async (n) => {
      if (boom) { boom = false; throw new Crash("note"); }
      fx.sim.notes.push(n);
      return { ok: true };
    };
    await expect(executeRun(deps(fx, { writeNote }), runId)).rejects.toThrow(Crash);
    expect(loadState(fx.maint, runId)!.phase).toBe("recording");
    expect(barrierActive(fx.maint)).toBe(true);
    const s = await recoverRun(deps(fx, { writeNote }), runId);
    expect([s.outcome, s.phase]).toEqual(["migrated", "done"]);
    expect(fx.sim.notes).toHaveLength(1);
    expect(barrierActive(fx.maint)).toBe(false);
  });

  /** 模拟台账:dedupKey 按 runId+op 只认第一条;重写同 key 时复核哈希(与 ledger-access.writePointerNote 一致) */
  function dedupLedger(crash: { once: boolean }) {
    const committed = new Map<string, string>();
    const writeNote: ExecDeps["writeNote"] = async (n) => {
      const key = `${n.runId}:${n.op}`;
      if (!committed.has(key)) committed.set(key, n.reportSha256);
      if (crash.once) { crash.once = false; throw new Crash("after-commit"); } // note 已落库、s.note 还没落盘
      return committed.get(key) === n.reportSha256 ? { ok: true } : { ok: false, error: "指针写入后复核不到,按未落库处理" };
    };
    return { committed, writeNote };
  }
  const reportSha = (fx: Fx, runId: string) => sha256Hex(readFileSync(join(fx.maint, "reports", runId, "run.json"), "utf8"));

  test("recording recovery preserves report pointer hash:note 已落库、返回前崩溃,恢复不重写报告,指针仍指向当前报告", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const { committed, writeNote } = dedupLedger({ once: true });
    await expect(executeRun(deps(fx, { writeNote }), runId)).rejects.toThrow(Crash);
    expect(loadState(fx.maint, runId)!.phase).toBe("recording");
    const first = reportSha(fx, runId);
    const s = await recoverRun(deps(fx, { writeNote }), runId);
    expect([s.outcome, s.phase]).toEqual(["migrated", "done"]);
    expect(s.note).toEqual({ ok: true });
    expect(reportSha(fx, runId)).toBe(first);
    expect(committed.get(`${runId}:state_maintenance_run`)).toBe(first);
  });

  test("note 已记成功后崩溃:恢复不覆盖报告,指针与报告一致", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const { committed, writeNote } = dedupLedger({ once: false });
    const crashAt = (p: string) => { if (p === "recording:after-note") throw new Crash(p); };
    await expect(executeRun(deps(fx, { writeNote, crashAt }), runId)).rejects.toThrow(Crash);
    const first = reportSha(fx, runId);
    const s = await recoverRun(deps(fx, { writeNote }), runId);
    expect([s.phase, s.note?.ok]).toEqual(["done", true]);
    expect(reportSha(fx, runId)).toBe(first);
    expect(committed.get(`${runId}:state_maintenance_run`)).toBe(first);
  });

  test("固定的报告被改动:恢复不重写、不虚报留存成功", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const { writeNote } = dedupLedger({ once: true });
    await expect(executeRun(deps(fx, { writeNote }), runId)).rejects.toThrow(Crash);
    writeFileSync(join(fx.maint, "reports", runId, "run.json"), "{}");
    const s = await recoverRun(deps(fx, { writeNote }), runId);
    expect(s.note?.ok).toBe(false);
    expect(readFileSync(join(fx.maint, "reports", runId, "run.json"), "utf8")).toBe("{}");
  });
});

describe("[验收线 2] 真实停写与存活(隔离服务)", () => {
  test("守护进程不肯退出:拒绝,不强杀,已停的恢复", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    fx.sim.stuck.add("com.claudestra.cron");
    const s = await executeRun(deps(fx), runId);
    expect(s.outcome).toBe("refused");
    expect(s.error).toContain("没有退出");
    expect(fx.sim.calls.some((c) => /kill -9|kill -KILL/.test(c))).toBe(false);
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(fx.sim.loaded.has("com.claudestra.launcher")).toBe(true);
  });

  test("会话后代不退出 / channel-server 还在 / 未知进程开着根里的 WAL:都阻止迁移", async () => {
    const cases: ((fx: Fx) => void)[] = [
      (fx) => { fx.sim.sessionsAlive = true; fx.sim.procs.push("9001 1 claude --resume x"); },
      (fx) => fx.sim.procs.push("4242 1 bun /repo/src/channel-server.ts"),
      (fx) => fx.sim.files.push({ pid: 777, name: join(fx.oldRoot, "ledger", "ledger.sqlite-wal") }),
    ];
    for (const [i, arrange] of cases.entries()) {
      const fx = fixture();
      const runId = await prepare(fx);
      const d = deps(fx);
      if (i === 0) d.services.sessions.stop = async () => {}; // 会话收到 SIGHUP 也不退
      else arrange(fx);
      if (i === 0) arrange(fx);
      const s = await executeRun(d, runId);
      expect(s.outcome).toBe("refused");
      expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
      expect(existsSync(fx.newRoot)).toBe(false);
    }
  });

  test("探针扫描失败(lsof 缺失)即拒绝,不当成没有写者", async () => {
    const fx = fixture();
    const runId = await prepare(fx);
    const d = deps(fx);
    const inner = d.probe.run;
    d.probe.run = async (cmd) => (cmd[0] === "lsof" ? { code: null, stdout: "", stderr: "", spawnError: "ENOENT" } : inner(cmd));
    const s = await executeRun(d, runId);
    expect(s.outcome).toBe("refused");
    expect(s.error).toContain("探针失败");
  });
});
