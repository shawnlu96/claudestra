/**
 * i28-A1 §3 调度侧开卡全流程（验收线 1 / 3 / 4 / 7）：git / create / kill 用记账的假实现，调度身份的 ledger CLI 用进程内 runLedger。
 * 覆盖完整开卡、每一步失败后的回滚、同一 arm 不重试、两套依赖并发、中途断掉后的对账、与 PM 的 start_node 同卡号并发、额度线与零影响。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import { TEMPLATE_VERSION } from "../src/lib/scheduler-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28";
let dir: string, repo: string, db: Database, now: number, memo: Set<string>;
let agents: Record<string, { channelId: string; projectId?: string }>;
let branches: Set<string>, worktrees: Map<string, string | null>;
let calls: string[][], notes: string[], creates: number, quota: InventoryQuota;
let failOn: (args: string[]) => boolean;
/** 置上后每个外部调用都抛 SchedulerStopped（进程被杀的模拟：之后什么都写不进去） */
let dead: boolean;

const ledgerDeps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {}, now: () => now++,
  autoDispatch: () => true, autoProjects: () => [P],
});

function guardDead(args: string[]): void {
  if (dead) throw new SchedulerStopped(`进程被杀：${args.slice(0, 4).join(" ")}`);
}

async function schedLedger(...args: string[]): Promise<Record<string, unknown>> {
  guardDead(args);
  calls.push(args);
  if (failOn(args)) return { ok: false, error: `注入失败：${args.slice(1, 5).join(" ")}` };
  return runLedger(args.slice(1), ledgerDeps("scheduler"));
}

async function plain(args: string[]): Promise<any> {
  guardDead(args);
  calls.push(args);
  if (failOn(args)) return { ok: false, error: `注入失败：${args[0]}` };
  if (args[0] === "create") {
    creates++;
    agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
    return { ok: true };
  }
  if (args[0] === "kill") delete agents[args[1]];
  return { ok: true };
}

async function git(_cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  guardDead(["git", ...args]);
  calls.push(["git", ...args]);
  if (failOn(["git", ...args])) return { ok: false, out: "注入失败" };
  const [cmd, sub] = args;
  if (cmd === "worktree" && sub === "add") {
    const path = args.at(-2) as string;
    if (existsSync(path)) return { ok: false, out: "already exists" };
    mkdirSync(path, { recursive: true });
    branches.add(args[args.indexOf("-b") + 1]);
    worktrees.set(path, args[args.indexOf("--reason") + 1] ?? null);
  } else if (cmd === "worktree" && sub === "unlock") worktrees.set(args[2], null);
  else if (cmd === "worktree" && sub === "list") {
    return { ok: true, out: [...worktrees].map(([w, lock]) => `worktree ${w}\nHEAD base0${lock ? `\nlocked ${lock}` : ""}`).join("\n\n") };
  } else if (cmd === "worktree" && sub === "remove") {
    rmSync(args.at(-1) as string, { recursive: true, force: true });
    worktrees.delete(args.at(-1) as string);
  } else if (cmd === "rev-parse") {
    const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", ""));
    return { ok, out: ok ? "base0" : "" };
  } else if (cmd === "branch") branches.delete(args[2]);
  return { ok: true, out: "" };
}

const startEnv = () => ({
  ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
  exists: existsSync, branchExists: async (_r: string, b: string) => branches.has(b), autoReady: () => null, template: () => null,
});
const stepIO = (): Omit<StepIO, "db" | "manager" | "attempt"> => ({
  git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  write: (p, t) => {
    guardDead(["write", p]);
    if (failOn(["write", p])) throw new Error(`注入：写 ${p} 失败`);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, t);
  },
  remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
});

const specPath = (id: string) => join(dir, "ledger", "docs", "tasks", `${id}.md`);
function spec(id: string, text = "# 规格\n\n## 目标\n", ageMs = 120_000): void {
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(specPath(id), text);
  const t = new Date(Date.now() - ageMs);
  utimesSync(specPath(id), t, t);
}

function env(over: Partial<StartTickEnv> = {}): StartTickEnv {
  return {
    db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger: schedLedger, plain, startEnv, stepIO,
    readSpec: (id) => (existsSync(specPath(id)) ? { mtimeMs: statSync(specPath(id)).mtimeMs, text: readFileSync(specPath(id), "utf8") } : null),
    quota: async () => quota, notifyPm: async (_p, text) => void notes.push(text), memo, now: Date.now,
    attempt: () => Math.random().toString(16).slice(2, 10), ...over,
  };
}

const claims = () => listEvents(db, { target: FID }).filter((e) => e.data.op === "autostart_claim");
const settles = () => listEvents(db, { target: FID }).filter((e) => e.data.op === "autostart_settle").map((e) => e.data.outcome);
const bound = (key = "a") => (db.query("SELECT taskId FROM dag_bindings WHERE featureId = ? AND nodeKey = ?").get(FID, key) as { taskId: string } | null)?.taskId ?? null;
const WT = () => join(dir, "wt", "i28-a");

beforeEach(() => {
  now = 1_000;
  calls = [];
  notes = [];
  creates = 0;
  dead = false;
  memo = new Set();
  failOn = () => false;
  quota = { status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [{ id: "7d", kind: "weekly", usedPct: 20, resetsAtMs: 9e12, resetPassed: false }] };
  branches = new Set(["main"]);
  worktrees = new Map();
  dir = mkdtempSync(join(tmpdir(), "i28-a1-run-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  agents = { [PM]: { channelId: "ch-pm", projectId: P } };
  createFeature(db, { actor: PM, now: now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
  spec("i28-a");
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("完整开卡", () => {
  test("依赖满足 + 规格定稿：建卡、worktree、执行者、auto、绑节点一次做完；claim 结 done；成功不通知", async () => {
    expect(await autostartTick(env())).toEqual([]);
    expect(getTask(db, "i28-a")).toMatchObject({ stage: "spec", agent: "agent-task-i28-a", pm: PM, branch: "feat/i28-a" });
    expect(getWorkflow(db, "i28-a")).toMatchObject({ mode: "auto", template: "code", templateVersion: TEMPLATE_VERSION.code, authorFamily: "claude" });
    expect(bound()).toBe("i28-a");
    expect(existsSync(WT())).toBe(true);
    expect(agents["agent-task-i28-a"]).toBeDefined();
    expect(readFileSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"), "utf8")).toContain(PM);
    expect(settles()).toEqual(["done"]);
    expect(notes).toEqual([]);
    calls = [];
    expect(await autostartTick(env())).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("卡首声明 ui：workflow 从落库那一刻就是 ui 最高版，不存在先写 code 的窗口", async () => {
    spec("i28-a", "# 规格\n模板：UI\n\n## 目标\n## 复用对象\n团队视图\n## 对照基准\n/tmp/base.png\n");
    await autostartTick(env());
    const wfEvents = listEvents(db, { target: "i28-a" }).filter((e) => e.data.op === "workflow");
    expect(wfEvents.map((e) => [e.data.template, e.data.templateVersion, e.data.mode])).toEqual([["ui", TEMPLATE_VERSION.ui, "auto"]]);
  });

  test("i28-UIQ1：ui 规格缺复用对象 / 对照基准：不开卡，通知 PM 一次写明缺的节；补上后照常开", async () => {
    spec("i28-a", "# 规格\n模板：ui\n\n## 目标\n## 复用对象\n团队视图\n");
    await autostartTick(env());
    await autostartTick(env());
    expect(getTask(db, "i28-a")).toBeNull();
    expect(listEvents(db, { target: FID }).find((e) => e.data.op === "autostart_settle")!.data.code).toBe("spec_lint");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("「## 对照基准」");
    spec("i28-a", "# 规格\n模板：ui\n\n## 目标\n## 复用对象\n团队视图\n## 对照基准\n/tmp/base.png\n");
    await autostartTick(env());
    expect(getTask(db, "i28-a")).not.toBeNull();
  });

  test("模板值不认识：不开卡，记失败并通知 PM 一次，同一份规格不再试", async () => {
    spec("i28-a", "# 规格\n模板：web\n\n## 目标\n");
    await autostartTick(env());
    expect(getTask(db, "i28-a")).toBeNull();
    expect(settles()).toEqual(["failed"]);
    expect(notes).toHaveLength(1);
    await autostartTick(env());
    expect(claims()).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  test("规格静置未满 60 秒 / 写了自动开卡：关：不开、不通知", async () => {
    spec("i28-a", "# 规格\n", 10_000);
    await autostartTick(env());
    spec("i28-b", "# 规格\n自动开卡：关\n");
    await autostartTick(env());
    expect(claims()).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("失败回滚：只撤本次建的，通知一条，同一 arm 不重试", () => {
  const step = (sub: string) => (a: string[]) => a[0] === "ledger" && a[2] === "step" && a[4] === sub && !a.includes("--mode=manual") && !a.includes("--to=cancelled");
  const cases: [string, (a: string[]) => boolean][] = [
    ["task-new", step("task-new")],
    ["worktree", (a) => a[0] === "git" && a[1] === "worktree" && a[2] === "add"],
    ["prompt", (a) => a[0] === "write" && a[1].endsWith("-exec-prompt.md")],
    ["agent", (a) => a[0] === "create"],
    ["task-set", step("task-set")],
    ["workflow", step("workflow-set")],
    ["bind", step("dag-bind")],
  ];
  for (const [name, hit] of cases) {
    test(`在 ${name} 失败`, async () => {
      failOn = hit;
      await autostartTick(env());
      const t = getTask(db, "i28-a");
      if (t) expect(t.stage).toBe("cancelled");
      expect(existsSync(WT())).toBe(false);
      expect(branches.has("feat/i28-a")).toBe(false);
      expect(agents["agent-task-i28-a"]).toBeUndefined();
      expect(getWorkflow(db, "i28-a")?.mode ?? "manual").toBe("manual");
      expect(bound()).toBeNull();
      expect(settles()).toEqual(["failed"]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(name);
      failOn = () => false;
      calls = [];
      await autostartTick(env());
      expect(claims()).toHaveLength(1);
      expect(notes).toHaveLength(1);
      expect(calls).toEqual([]);
    });
  }

  test("等额度期间 PM 改了规格卡（关掉 / 换模板）：不 claim、不开、不通知；下一轮按新规格重判", async () => {
    await autostartTick(env({ quota: async () => { spec("i28-a", "# 规格\n自动开卡：关\n模板：invalid\n", 0); return quota; } }));
    expect(claims()).toHaveLength(0);
    expect(creates).toBe(0);
    expect(notes).toEqual([]);
    spec("i28-a", "# 规格\n自动开卡：关\n");
    await autostartTick(env());
    expect(claims()).toHaveLength(0);
  });

  test("claim 之后、runStart 之前规格卡改了：这次结为 failed（spec_changed），什么都没建，通知一次", async () => {
    let edited = false;
    const se = () => ({ ...startEnv(), projectDirs: async () => {
      if (!edited) { edited = true; spec("i28-a", "# 规格\n模板：ui\n", 0); }
      return [repo];
    } });
    await autostartTick(env({ startEnv: se }));
    expect(edited).toBe(true);
    expect(settles()).toEqual(["failed"]);
    expect(listEvents(db, { target: FID }).find((e) => e.data.op === "autostart_settle")!.data.code).toBe("spec_changed");
    expect(getTask(db, "i28-a")).toBeNull();
    expect(creates).toBe(0);
    expect(notes).toHaveLength(1);
  });

  test("改了规格卡就重新武装；卡号被回滚的卡占着时提示用 start_node 带 taskId", async () => {
    failOn = (a) => a[0] === "create";
    await autostartTick(env());
    expect(notes[0]).toContain("start_node 带 taskId");
    failOn = () => false;
    spec("i28-a", "# 规格（改过）\n");
    await autostartTick(env());
    expect(claims()).toHaveLength(2);
    expect(notes).toHaveLength(2);
    expect(settles()).toEqual(["failed", "failed"]);
  });
});

describe("不双开", () => {
  test("两套依赖并发跑同一台账同一节点：一个活 claim、一张卡、一次 create", async () => {
    const [a, b] = await Promise.all([autostartTick(env()), autostartTick(env({ memo: new Set() }))]);
    expect([...a, ...b]).toEqual([]);
    expect(claims()).toHaveLength(1);
    expect(creates).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    expect(bound()).toBe("i28-a");
  });

  test("同进程另一轮在第一轮 create 卡住时进来：不对账在跑的 claim，也不再开；第一轮放行后照常开完", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let paused!: () => void;
    const reached = new Promise<void>((r) => { paused = r; });
    const first = autostartTick(env({ plain: async (args) => { if (args[0] === "create") { paused(); await gate; } return plain(args); } }));
    await reached;
    expect(await autostartTick(env({ memo: new Set() }))).toEqual([]);
    expect(settles()).toEqual([]);
    expect(claims()).toHaveLength(1);
    release();
    expect(await first).toEqual([]);
    expect(settles()).toEqual(["done"]);
    expect(bound()).toBe("i28-a");
    expect(getTask(db, "i28-a")!.stage).not.toBe("cancelled");
    expect(creates).toBe(1);
    expect(notes).toEqual([]);
  });

  test("claim 写下后进程被杀（卡建了、没绑）：下一轮结为 unknown、通知一次，不重开", async () => {
    failOn = (a) => a[0] === "create";
    let killed = false;
    const e = env({ plain: async (args) => { if (args[0] === "create" && !killed) { killed = dead = true; guardDead(args); } return plain(args); } });
    await expect(autostartTick(e)).rejects.toBeInstanceOf(SchedulerStopped);
    expect(claims()).toHaveLength(1);
    expect(settles()).toEqual([]);
    dead = false;
    failOn = () => false;
    await autostartTick(env());
    expect(settles()).toEqual(["unknown"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("开卡中途断了");
    expect(creates).toBe(0);
    await autostartTick(env());
    expect(claims()).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  test("绑完节点、结清之前被杀：下一轮对账结为 done，不通知", async () => {
    const e = env({ ledger: async (...args) => { if (args[2] === "settle") { dead = true; guardDead(args); } return schedLedger(...args); } });
    await expect(autostartTick(e)).rejects.toBeInstanceOf(SchedulerStopped);
    dead = false;
    await autostartTick(env());
    expect(settles()).toEqual(["done"]);
    expect(notes).toEqual([]);
  });

  test("和 PM 的 start_node 同卡号并发：只留一张非 cancelled 的卡，赢家的 worktree / agent / 卡都在", async () => {
    agents[PM] = { channelId: "ch-pm", projectId: P };
    const deps: DagToolDeps = {
      db: () => db,
      manager: async (args, channelId) => {
        if (args[0] !== "ledger") return plain(args);
        const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
        return who.ok ? runLedger(args.slice(1), ledgerDeps(who.actor)) : { ok: false, code: "forbidden" };
      },
      callerProject: () => P, startEnv, stepIO,
    };
    const pm = { agent: PM, sessionId: "s", family: "claude-code" as const, channelId: "ch-pm" };
    const [, viaPm] = await Promise.all([autostartTick(env()), dagToolHandlers(deps).start_node(pm, { featureId: "i28", key: "a" })]);
    const live = (db.query("SELECT id, stage, agent FROM tasks WHERE stage != 'cancelled'").all() as { id: string; agent: string }[]);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("i28-a");
    expect(bound()).toBe("i28-a");
    expect(existsSync(WT())).toBe(true);
    expect(agents["agent-task-i28-a"]).toBeDefined();
    expect(creates).toBe(1);
    expect(getTask(db, "i28-a")!.pm).toBe(PM);
    // 输的一方安静收手：调度这边输了不通知 PM；PM 那边输了拿到失败结果
    if ((viaPm as { ok: boolean }).ok) expect(notes).toEqual([]);
    else expect(settles()).toEqual(["done"]);
  });
});

describe("额度、容量与零影响", () => {
  test("Claude 周额度到线：不开卡，同一窗口只通知一次；线可在开关里改", async () => {
    quota = { ...quota, windows: [{ id: "7d", kind: "weekly", usedPct: 80, resetsAtMs: 9e12, resetPassed: false }] };
    await autostartTick(env());
    await autostartTick(env());
    expect(claims()).toEqual([]);
    expect(notes).toHaveLength(1);
    await runLedger(["autostart-set", "on", "--line", "85", "--reason", "owner 改 85", "--project", P], ledgerDeps(PM));
    await autostartTick(env());
    expect(getTask(db, "i28-a")).not.toBeNull();
  });

  test("额度读不到不拦", async () => {
    await autostartTick(env({ quota: async () => { throw new Error("没有快照"); } }));
    expect(getTask(db, "i28-a")).not.toBeNull();
  });

  test("autoDispatch 关着、或没有候选：一个外部调用都没有", async () => {
    await autostartTick(env({ svc: { autoDispatch: false, projects: [P], maxWorkers: () => 3 } }));
    expect(calls).toEqual([]);
    rmSync(specPath("i28-a"));
    // PMWAKE（PM 批 01:2x）：就绪节点缺规格、spec-wait 缺省 observe → 恰好 1 次调度身份的 spec-wait 台账写，0 通知、0 claim / create / 其他外部动作
    await autostartTick(env());
    expect(calls).toEqual([["ledger", "scheduler-autostart", "spec-wait", FID, "a", "--version", "1", "--mode", "observe", "--pm", PM,
      "--text", "[待写规格] 协作底座 的节点 a（节点 a）依赖已满足，可以开工，缺规格卡 i28-a.md；放好后调度器自动开卡。"]]);
    expect(listEvents(db, { target: FID }).filter((e) => e.data.op === "spec_wait").map((e) => [e.actor, e.data.mode])).toEqual([["scheduler", "observe"]]);
    expect(claims()).toEqual([]);
    expect(creates).toBe(0);
    expect(notes).toEqual([]);
  });

  test("容量满：排队，不 claim、不通知", async () => {
    await autostartTick(env({ svc: { autoDispatch: true, projects: [P], maxWorkers: () => 0 } }));
    expect(claims()).toEqual([]);
    expect(notes).toEqual([]);
  });
});
