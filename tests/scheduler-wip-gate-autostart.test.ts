/**
 * dispatch-recovery-WIPGATE1 的 DAG 待开节点（planned 自动开卡）：真 autostartTick + 真 ledger CLI（调度身份，claim 事务里重核），合成 feature / DAG /
 * 规格卡与临时目录；git、create 用替身（建 worktree 一步失败即回滚，开卡结果在两份孪生夹具里相同）。
 * [验收线 2] observe 照常 claim，只多日志；[验收线 3] on 不 claim、不消耗 arm、不落 hold；[验收线 4] 队列降下来下一轮照常开；claim 事务重核。
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { setWipGateIo } from "../src/lib/scheduler-wip-gate-log.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28";
interface Fx { dir: string; path: string; db: Database; now: number; calls: string[][]; logPath: string; statePath: string }
const open: Fx[] = [];
afterEach(() => {
  setWipGateIo(null);
  for (const fx of open.splice(0)) { closeLedger(fx.path); rmSync(fx.dir, { recursive: true, force: true }); }
});

const ledgerDeps = (fx: Fx, actor: string) => ({ db: fx.db, actor, projectIds: [P], now: () => fx.now++, autoProjects: () => [P], autoDispatch: () => true,
  loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "ch-pm", projectId: P } } }) as unknown as Registry, saveRegistry: async () => {} });
const sched = (fx: Fx, ...args: string[]) => runLedger(args, ledgerDeps(fx, "scheduler")) as Promise<Record<string, unknown>>;

function fixture(mode: "on" | "observe" | "off", depth: number): Fx {
  const dir = mkdtempSync(join(tmpdir(), "wipgate-dag-")), path = join(dir, "ledger.sqlite");
  const fx: Fx = { dir, path, db: openLedger(path), now: 1_000, calls: [], logPath: join(dir, "wip.out"), statePath: join(dir, "wip.json") };
  open.push(fx);
  fx.db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(fx.db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  fx.db.query("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?)").run(P, JSON.stringify({ wipGate: mode }));
  createFeature(fx.db, { actor: PM, now: fx.now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(fx.db, { actor: PM, now: fx.now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
  for (let i = 0; i < depth; i++) {
    const id = `Q${String(i).padStart(2, "0")}`;
    createTask(fx.db, { actor: "owner", now: fx.now++ }, { project: P, id, title: id, kind: "code", agent: `agent-${id}` });
    setWorkflow(fx.db, { actor: "owner", now: fx.now++ }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
    fx.db.query("UPDATE tasks SET stage = 'merge' WHERE id = ?").run(id);
  }
  const spec = join(dir, "ledger", "docs", "tasks", "i28-a.md");
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(spec, "# 规格\n\n## 目标\n");
  utimesSync(spec, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  setWipGateIo({ logPath: () => fx.logPath, statePath: () => fx.statePath, now: () => Date.UTC(2026, 9, 11, 10) });
  return fx;
}

function env(fx: Fx): StartTickEnv {
  const specPath = (id: string) => join(fx.dir, "ledger", "docs", "tasks", `${id}.md`);
  return {
    db: fx.db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 50 },
    ledger: async (...args) => { fx.calls.push(args); return sched(fx, ...args.slice(1)); },
    plain: async (args) => { fx.calls.push(args); return { ok: false, error: "替身不建会话" }; },
    startEnv: () => ({ ledgerDir: join(fx.dir, "ledger"), worktreeRoot: join(fx.dir, "wt"), projectDirs: async () => [join(fx.dir, "repo")], agentNames: () => [PM],
      exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null }),
    stepIO: () => ({ git: async () => ({ ok: false, out: "替身 git 失败" }), exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: () => { throw new Error("替身不写文件"); }, remove: () => {}, symlink: () => {}, agentExists: () => false }),
    readSpec: (id) => (existsSync(specPath(id)) ? { mtimeMs: statSync(specPath(id)).mtimeMs, text: readFileSync(specPath(id), "utf8") } : null),
    quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] }),
    notifyPm: async () => {}, memo: new Set(), now: Date.now, attempt: () => "fixed000",
  };
}

const claims = (fx: Fx) => listEvents(fx.db, { target: FID }).filter((e) => e.data.op === "autostart_claim");
const logs = (fx: Fx) => (existsSync(fx.logPath) ? readFileSync(fx.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const strip = (fx: Fx) => fx.calls.map((c) => c.filter((a) => !/^\d{13}$/.test(a)).map((a) => a.replaceAll(fx.dir, "<dir>")));

describe("DAG 待开节点", () => {
  test("[验收线 2] observe 深度 15：照常 claim，执行序列与 off 相同；日志用确定的候选卡号", async () => {
    const off = fixture("off", 15), obs = fixture("observe", 15);
    await autostartTick(env(off));
    await autostartTick(env(obs));
    expect(claims(obs)).toHaveLength(1);
    expect(strip(obs)).toEqual(strip(off));
    expect(logs(obs)).toEqual([{ at: "2026-10-11T10:00:00.000Z", project: P, task: "i28-a", entry: "autostart", depth: 15, threshold: 15, mode: "observe" }]);
    expect(existsSync(off.logPath) || existsSync(off.statePath)).toBe(false);
  });

  for (const depth of [15, 16]) {
    test(`[验收线 3] on 深度 ${depth}：不 claim、不建卡、不落 hold，arm 未消耗；[验收线 4] 移出一张到阈值以下，下一轮照常 claim`, async () => {
      const fx = fixture("on", depth);
      const before = listEvents(fx.db, {}).length;
      expect(await autostartTick(env(fx))).toEqual([]);
      expect(fx.calls.filter((c) => c[2] === "scheduler-autostart")).toEqual([]);
      expect(listEvents(fx.db, {}).length).toBe(before);
      expect(logs(fx).map((l) => [l.task, l.mode, l.depth])).toEqual([["i28-a", "on", depth]]);
      for (let i = 0; i <= depth - 15; i++) fx.db.query("UPDATE tasks SET stage = 'done' WHERE id = ?").run(`Q${String(i).padStart(2, "0")}`);
      await autostartTick(env(fx));
      expect(claims(fx)).toHaveLength(1);
    });
  }

  test("claim 事务重核：选候选后队列涨到阈值（on），真 claim 命令回 conflict、不写 claim；off 照常写", async () => {
    const claim = (fx: Fx) => sched(fx, "scheduler-autostart", "claim", FID, "a", "--arm", "0123456789abcdef", "--template", "code", "--max-workers", "50");
    const on = fixture("on", 15);
    expect(await claim(on)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("合并队列 15 张") });
    expect(claims(on)).toEqual([]);
    expect(existsSync(on.logPath)).toBe(false); // 重核只拦不记
    const off = fixture("off", 15);
    expect(await claim(off)).toMatchObject({ ok: true, duplicate: false });
  });
});
