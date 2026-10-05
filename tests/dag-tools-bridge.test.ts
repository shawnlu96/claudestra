/**
 * i28-L5 四个 MCP 工具走完整管道：bridge handler（bridge/dag-tools.ts）→ 以调用方频道跑 `manager ledger …`（这里用进程内 runLedger 代替子进程，
 * actor 同样按频道认）→ 台账。git / manager create / kill 换成记账的假实现，文件落在临时目录。
 * 覆盖验收线的每条 P1：非 PM 调写类工具、缺 fileGlobs、start_node 中途失败留半截、重叠算并行、不带原因删进行中节点；以及正常路径。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { isOrderTool } from "../src/lib/order-tools.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const X: VerifiedCall = { agent: "agent-x", sessionId: "s-x", family: "claude-code", channelId: "ch-x" };
const MASTER: VerifiedCall = { agent: "master", sessionId: null, family: "claude-code", channelId: "ch-ctl" };

let dir: string, repo: string, db: Database, now: number;
let agents: Record<string, { channelId: string; projectId?: string }>;
let branches: Set<string>;
/** 假 git 登记的 worktree：路径 → 锁标记 */
let worktrees: Map<string, string | null>;
let calls: string[][];
/** 返回 true 的 manager / git 调用被注入成失败 */
let failOn: (args: string[]) => boolean;
/** 返回 true 的 manager 调用照常执行（已提交），但结果丢了、返回失败（超时强杀 / stdout 解析失败） */
let lose: (args: string[]) => boolean;
/** git 调用前的钩子：返回结果就顶替真实行为（模拟预检之后才冒出来的资源、git 的拒绝） */
let gitHook: (args: string[]) => { ok: boolean; out: string } | void;
/** 写这个路径时先写进去、再抛 IO 错（写到一半） */
let throwAfterWrite: (path: string) => boolean;
let autoDispatch: boolean;

const ledgerRun = async (args: string[], channelId: string) => {
  const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
  if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
  return runLedger(args.slice(1), {
    db, actor: who.actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {},
    now: () => now++, autoDispatch: () => autoDispatch, autoProjects: () => [P],
  });
};

async function managerRun(args: string[], channelId: string): Promise<any> {
  if (args[0] === "ledger") return ledgerRun(args, channelId);
  if (args[0] === "create") {
    agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
    return { ok: true, agent: `agent-${args[1]}` };
  }
  if (args[0] === "kill") {
    delete agents[args[1]];
    return { ok: true };
  }
  return { ok: false, error: "未知命令" };
}

function deps(): DagToolDeps {
  return {
    db: () => db,
    manager: async (args, channelId) => {
      calls.push(args);
      if (failOn(args)) return { ok: false, error: `注入失败：${args[0]} ${args[1]}` };
      const r = await managerRun(args, channelId);
      return lose(args) ? { ok: false, error: `注入：${args[0]} ${args[1]} 已提交，结果丢了` } : r;
    },
    callerProject: (a) => agents[a]?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
      exists: existsSync, branchExists: async (_r, b) => branches.has(b), autoReady: () => (autoDispatch ? null : "调度服务没开"), template: () => null,
    }),
    stepIO: () => ({
      git: async (_cwd, args) => {
        calls.push(["git", ...args]);
        if (failOn(["git", ...args])) return { ok: false, out: "注入失败" };
        const hooked = gitHook(args);
        if (hooked) return hooked;
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
      },
      exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => {
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, t);
        if (throwAfterWrite(p)) throw new Error(`注入：写 ${p} 后 IO 错`);
      },
      remove: (p) => rmSync(p, { force: true }),
      symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    }),
  };
}

const tools = () => dagToolHandlers(deps());
const call = (who: VerifiedCall, tool: string, args: unknown) => tools()[tool](who, args) as Promise<Record<string, any>>;
const node = (key: string, fileGlobs: unknown, more: Record<string, unknown> = {}) => ({ key, oneLine: `节点 ${key}`, fileGlobs, ...more });
const plan = (who = PM, nodes: unknown[] = [node("a", ["src/lib/a*.ts"]), node("b", ["src/bridge/b.ts"])]) =>
  call(who, "plan_feature", { slug: "i28", title: "协作底座", ownerWords: "原话", nodes });
const spec = (id: string) => {
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(join(dir, "ledger", "docs", "tasks", `${id}.md`), "# 规格\n");
};
const start = (key: string, who = PM, more: Record<string, unknown> = {}) => call(who, "start_node", { featureId: "i28", key, ...more });
const writes = () => calls.filter((c) => c[0] !== "ledger" || !["dag-show", "feature-show"].includes(c[1]));

beforeEach(() => {
  now = 1_000;
  calls = [];
  failOn = () => false;
  lose = () => false;
  gitHook = () => {};
  throwAfterWrite = () => false;
  autoDispatch = true;
  branches = new Set(["main"]);
  worktrees = new Map();
  dir = mkdtempSync(join(tmpdir(), "i28-l5-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P }, [X.agent]: { channelId: "ch-x", projectId: P } };
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("工具注册", () => {
  test("四个工具都在 channel-server 的派单工具表里", () => {
    for (const t of ["plan_feature", "rewrite_dag", "start_node", "show_dag"]) expect(isOrderTool(t)).toBe(true);
  });
});

describe("P1：权限", () => {
  test("非 PM 调写类工具一律 forbidden，什么都没写；show_dag 只读可以看", async () => {
    expect(await plan(X)).toMatchObject({ ok: false, code: "forbidden" });
    expect(getFeature(db, "ab12-i28")).toBeNull();
    expect((await plan()).ok).toBe(true);
    spec("i28-a");
    calls = [];
    expect(await start("a", X)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await call(X, "rewrite_dag", { featureId: "i28", reasonKind: "new_issue", reason: "x", remove: ["b"] })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await call(X, "plan_feature", { featureId: "i28", nodes: [node("a", ["x.ts"])], reasonKind: "new_issue", reason: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(writes()).toEqual([]);
    expect(await call(X, "show_dag", { featureId: "i28" })).toMatchObject({ ok: true, current: 1 });
  });

  test("master 可以调", async () => {
    expect(await call(MASTER, "plan_feature", { slug: "m1", title: "大总管建的", project: P, nodes: [node("a", ["a.ts"])] })).toMatchObject({ ok: true });
  });
});

describe("P1：fileGlobs 必填", () => {
  test("缺 / 空 fileGlobs 的节点被拒，feature 也不建", async () => {
    expect(await plan(PM, [node("a", undefined)])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("fileGlobs") });
    expect(await plan(PM, [node("a", [])])).toMatchObject({ ok: false, code: "invalid" });
    expect(await plan(PM, [node("a", ["../etc/passwd"])])).toMatchObject({ ok: false, code: "invalid" });
    expect(getFeature(db, "ab12-i28")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("正常路径：规划 → 两条车道 → 两次开工", () => {
  test("两节点不重叠：两条车道，两次 start_node 建出两张 auto 卡", async () => {
    const r = await plan();
    expect(r).toMatchObject({ ok: true, feature: "ab12-i28", lanes: { startNow: ["a", "b"], lanes: [["a"], ["b"]] } });
    spec("i28-b");
    const a = await start("a", PM, { spec: "# i28-a 规格\n范围……" });
    expect(a).toMatchObject({ ok: true, taskId: "i28-a", agent: "agent-task-i28-a", branch: "feat/i28-a" });
    expect((await start("b")).ok).toBe(true);
    for (const [id, key, globs] of [["i28-a", "a", ["src/lib/a*.ts"]], ["i28-b", "b", ["src/bridge/b.ts"]]] as const) {
      const t = getTask(db, id)!;
      expect(t).toMatchObject({ stage: "spec", agent: `agent-task-${id}`, pm: PM.agent, branch: `feat/${id}`, featureId: "ab12-i28", spec: join(dir, "ledger", "docs", "tasks", `${id}.md`) });
      expect(t.extra.fileGlobs).toEqual([...globs]);
      expect(getWorkflow(db, id)).toMatchObject({ mode: "auto", template: "code", templateVersion: 3, authorFamily: "claude" });
      const prompt = readFileSync(join(dir, "ledger", "reviews", `${id}-exec-prompt.md`), "utf8");
      expect(prompt).toContain("本卡是自动卡");
      expect(prompt).toContain(`不要给 ${PM.agent} 发任何进度`);
      expect(lstatSync(join(dir, "wt", id, "node_modules")).isFile()).toBe(true);
      const show = await call(PM, "show_dag", { featureId: "i28" });
      expect(show.version.nodes.find((n: any) => n.key === key)).toMatchObject({ taskId: id, status: "spec", agent: `agent-task-${id}`, fileGlobs: [...globs] });
    }
    expect(readFileSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"), "utf8")).toContain("i28-a 规格");
    const create = calls.find((c) => c[0] === "create" && c[1] === "task-i28-a")!;
    expect(create).toEqual(expect.arrayContaining(["--task", "i28-a", "--project", P, join(dir, "wt", "i28-a")]));
    expect(await start("a")).toMatchObject({ ok: true, duplicate: true, taskId: "i28-a" });
    expect(calls.filter((c) => c[0] === "create")).toHaveLength(2);
  });
});

describe("P1：start_node 中途失败不留半截", () => {
  const cases: [string, (a: string[]) => boolean][] = [
    ["worktree", (a) => a[0] === "git" && a[1] === "worktree" && a[2] === "add"],
    ["agent", (a) => a[0] === "create"],
    ["task-set", (a) => a[0] === "ledger" && a[1] === "task-set"],
    ["workflow", (a) => a[0] === "ledger" && a[1] === "workflow-set"],
    ["bind", (a) => a[0] === "ledger" && a[1] === "dag-bind"],
  ];
  for (const [step, when] of cases) {
    test(`${step} 失败：卡取消、worktree / 分支 / agent / 说明全撤、节点没绑`, async () => {
      await plan();
      spec("i28-a");
      failOn = when;
      const r = await start("a");
      expect(r).toMatchObject({ ok: false, code: "start_failed", failedStep: step, leftovers: [] });
      expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
      expect(getWorkflow(db, "i28-a")?.mode ?? "manual").not.toBe("auto");
      expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
      expect(branches.has("feat/i28-a")).toBe(false);
      expect(agents["agent-task-i28-a"]).toBeUndefined();
      expect(existsSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"))).toBe(false);
      const show = await call(PM, "show_dag", { featureId: "i28" });
      expect(show.version.nodes.find((n: any) => n.key === "a").taskId).toBeNull();
      failOn = () => false;
      expect(await start("a", PM, { taskId: "i28-a2", spec: "重试" })).toMatchObject({ ok: true, taskId: "i28-a2" });
    });
  }

  test("task-new 失败：什么都没留下；规格卡是这次写的也删掉", async () => {
    await plan();
    failOn = (a) => a[0] === "ledger" && a[1] === "task-new";
    expect(await start("a", PM, { spec: "正文" })).toMatchObject({ ok: false, failedStep: "task-new" });
    expect(getTask(db, "i28-a")).toBeNull();
    expect(calls.some((c) => c[0] === "git" || c[0] === "create")).toBe(false);
  });

  test("预检不过就一步不做：依赖没满足、没有规格卡、调度服务没开 auto、分支已存在", async () => {
    await plan(PM, [node("a", ["a.ts"]), node("b", ["b.ts"], { deps: ["a"] })]);
    calls = [];
    expect(await start("b")).toMatchObject({ ok: false, code: "deps_unmet" });
    expect(await start("a")).toMatchObject({ ok: false, code: "no_spec" });
    spec("i28-a");
    autoDispatch = false;
    expect(await start("a")).toMatchObject({ ok: false, code: "auto_off" });
    autoDispatch = true;
    branches.add("feat/i28-a");
    expect(await start("a")).toMatchObject({ ok: false, code: "conflict" });
    expect(writes()).toEqual([]);
  });
});

describe("P1：rewrite_dag 删进行中的节点必须带原因", () => {
  test("remove 进行中节点被拒；cancel 带原因直接生效，带 scopeChange 才待 owner 批；拆计划节点直接生效，车道跟着变", async () => {
    await plan();
    spec("i28-a");
    expect((await start("a")).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'i28-a'").run();
    const base = { featureId: "i28", reasonKind: "requirement_change", reason: "owner：不做了" };
    expect(await call(PM, "rewrite_dag", { ...base, remove: ["a"] })).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("cancel") });
    expect(await call(PM, "rewrite_dag", { featureId: "i28", remove: ["b"] })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    const split = await call(PM, "rewrite_dag", { ...base, remove: ["b"], add: [node("b1", ["src/lib/a-x.ts"]), node("b2", ["docs/b2.md"])] });
    expect(split).toMatchObject({ ok: true, applied: true, lanes: { startNow: ["b2"], waiting: [{ key: "b1", why: "files", on: ["a"] }] } });
    const scoped = await call(PM, "rewrite_dag", { ...base, cancel: { a: "owner 说不做了" }, scopeChange: true });
    expect(scoped).toMatchObject({ ok: true, applied: false, askId: expect.any(String) });
    expect(getFeature(db, "ab12-i28")?.currentVersion).toBe(2);
    const diff = await call(PM, "show_dag", { featureId: "i28", diff: ["2", "pending"] });
    expect(diff.diff.cancelled).toEqual([{ key: "a", taskId: "i28-a", reason: "owner 说不做了" }]);
    db.prepare("UPDATE asks SET expiresAt = 0").run(); // 让待批的提案过期作废，下一次重写才能落地
    const cancel = await call(PM, "rewrite_dag", { ...base, cancel: { a: "owner 说不做了" } });
    expect(cancel).toMatchObject({ ok: true, applied: true, askId: null });
    expect(getFeature(db, "ab12-i28")?.currentVersion).toBe(3);
  });

  test("plan_feature 覆盖已有 DAG 要带原因；漏掉进行中的节点被拒", async () => {
    await plan();
    spec("i28-a");
    await start("a");
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'i28-a'").run();
    expect(await call(PM, "plan_feature", { featureId: "i28", nodes: [node("b", ["b.ts"])] })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    const again = { featureId: "i28", reasonKind: "new_issue", reason: "审查发现要加一步" };
    expect(await call(PM, "plan_feature", { ...again, nodes: [node("b", ["src/bridge/b.ts"])] })).toMatchObject({ ok: false, error: expect.stringContaining("a") });
    const r = await call(PM, "plan_feature", { ...again, nodes: [node("a", ["src/lib/a*.ts"]), node("b", ["src/bridge/b.ts"]), node("c", ["c.ts"], { deps: ["a"] })] });
    expect(r).toMatchObject({ ok: true, applied: true, lanes: { waiting: [{ key: "c", why: "deps", on: ["a"] }] } });
    expect(getTask(db, "i28-a")?.featureId).toBe("ab12-i28");
  });
});

describe("r1：提交了但结果丢了，按本次 dedup 查库接着走", () => {
  for (const sub of ["task-new", "task-set", "workflow-set", "dag-bind"]) {
    test(`${sub} 已提交、结果丢了：开工照常完成，只有一张卡，节点绑的是活卡`, async () => {
      await plan();
      spec("i28-a");
      lose = (a) => a[0] === "ledger" && a[1] === sub;
      const r = await start("a");
      expect(r).toMatchObject({ ok: true, taskId: "i28-a", reconciled: [sub === "workflow-set" ? "workflow" : sub === "dag-bind" ? "bind" : sub] });
      expect(getTask(db, "i28-a")).toMatchObject({ stage: "spec", agent: "agent-task-i28-a" });
      expect(getWorkflow(db, "i28-a")?.mode).toBe("auto");
      expect(calls.filter((c) => c[1] === "task-new")).toHaveLength(1);
      const show = await call(PM, "show_dag", { featureId: "i28" });
      expect(show.version.nodes.find((n: any) => n.key === "a")).toMatchObject({ taskId: "i28-a", status: "spec" });
    });
  }

  test("没提交的失败照旧回滚；create 已建好但结果丢了：归属不明留 unknown 不 kill，卡取消", async () => {
    await plan();
    spec("i28-a");
    lose = (a) => a[0] === "create";
    const r = await start("a");
    expect(r).toMatchObject({ ok: false, failedStep: "agent" });
    expect(r.leftovers).toEqual([expect.stringContaining("agent-task-i28-a 归属不明（unknown）")]);
    expect(agents["agent-task-i28-a"]).toBeDefined();
    expect(calls.some((c) => c[0] === "kill")).toBe(false);
    expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("同名卡是别人建的（本次 task-new 没落库）：回滚不碰它", async () => {
    await plan();
    spec("i28-a");
    const d = deps();
    const manager = d.manager;
    // 预检之后别人抢先建了同名卡，本次 task-new 被拒
    d.manager = async (a, ch, t) => {
      if (a[1] !== "task-new") return manager(a, ch, t);
      expect((await ledgerRun(["ledger", "task-new", "i28-a", "--title=别人的", "--kind=code", `--pm=${PM.agent}`, `--project=${P}`], "ch-pm")).ok).toBe(true);
      return { ok: false, code: "conflict", error: "卡号已存在" };
    };
    expect(await dagToolHandlers(d).start_node(PM, { featureId: "i28", key: "a" })).toMatchObject({ ok: false, failedStep: "task-new" });
    expect(getTask(db, "i28-a")).toMatchObject({ title: "别人的", stage: "spec" });
  });
});

describe("r1：只撤本次建的资源", () => {
  test("不同节点给只差大小写的卡号并发开工：后到的被拒，不删先到那次的 worktree", async () => {
    await plan();
    const d = deps();
    const env = d.startEnv;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    d.startEnv = () => ({ ...env(), branchExists: async () => (++arrivals === 2 && release(), await barrier, false) });
    const h = dagToolHandlers(d);
    const rs = await Promise.all([
      h.start_node(PM, { featureId: "i28", key: "a", spec: "a", taskId: "Case-A", branch: "feat/one" }),
      h.start_node(PM, { featureId: "i28", key: "b", spec: "b", taskId: "case-a", branch: "feat/two" }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ code: "busy" });
    expect(existsSync(join(dir, "wt", "case-a"))).toBe(true);
    // 先到那次做完后，只差大小写的卡号在预检就被拒
    expect(await start("b", PM, { spec: "b", taskId: rs[0].ok ? "case-a" : "Case-A", branch: "feat/three" })).toMatchObject({ ok: false, code: "conflict" });
  });

  const appear: [string, string, () => void, () => void][] = [
    ["worktree 目录", "worktree", () => mkdirSync(join(dir, "wt", "i28-a", "keep"), { recursive: true }), () => expect(existsSync(join(dir, "wt", "i28-a", "keep"))).toBe(true)],
    ["分支", "worktree", () => branches.add("feat/i28-a"), () => expect(branches.has("feat/i28-a")).toBe(true)],
    ["agent", "agent", () => (agents["agent-task-i28-a"] = { channelId: "ch-other", projectId: P }), () => expect(agents["agent-task-i28-a"]?.channelId).toBe("ch-other")],
  ];
  for (const [what, step, make, kept] of appear) {
    test(`${what}在预检之后才出现：${step} 步报错，回滚不碰它`, async () => {
      await plan();
      spec("i28-a");
      gitHook = (a) => void (a[0] === "fetch" && make());
      expect(await start("a")).toMatchObject({ ok: false, failedStep: step, leftovers: [] });
      kept();
      expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
    });
  }

  test("worktree add 建了一半就失败：本次建的目录与分支照样撤", async () => {
    await plan();
    spec("i28-a");
    gitHook = (a) => {
      if (a[0] !== "worktree" || a[1] !== "add") return;
      mkdirSync(a.at(-2) as string, { recursive: true });
      branches.add(a[a.indexOf("-b") + 1]);
      worktrees.set(a.at(-2) as string, a[a.indexOf("--reason") + 1]);
      return { ok: false, out: "注入：checkout 中途失败" };
    };
    expect(await start("a")).toMatchObject({ ok: false, failedStep: "worktree", leftovers: [] });
    expect(readdirSync(join(dir, "wt"))).toEqual([]);
    expect(branches.has("feat/i28-a")).toBe(false);
  });
});

describe("r2：真 git——worktree 带本次的锁标记建，回滚只认这个标记", () => {
  const git = (a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? r.stdout.toString() : r.stderr.toString()).trim() };
  };
  const realGit = (hook: (a: string[]) => void = () => {}) => {
    const d = deps();
    const orig = d.stepIO;
    d.stepIO = () => ({ ...orig(), git: async (_c, a) => (calls.push(["git", ...a]), hook(a), git(a)) });
    return dagToolHandlers(d);
  };
  const wt = () => join(dir, "wt", "i28-a");
  beforeEach(async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    expect(git(["init", "-q", "-b", "main"]).ok).toBe(true);
    expect(git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]).ok).toBe(true);
    await plan();
    spec("i28-a");
  });

  test("正常路径：worktree 落在正式路径、登记在 git 里，锁已解开", async () => {
    expect(await realGit().start_node(PM, { featureId: "i28", key: "a", base: "main" })).toMatchObject({ ok: true, worktree: wt() });
    expect(git(["worktree", "list", "--porcelain"]).out).toContain(`worktree ${realpathSync(wt())}\nHEAD`);
    expect(git(["worktree", "list", "--porcelain"]).out).not.toContain("locked");
    expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/feat/i28-a"]).ok).toBe(true);
  });

  test("审查员探针：exists 检查之后、add 之前别人在正式路径建了 worktree 并写了未提交文件——原样保留，本次建的分支撤掉", async () => {
    let injected = false;
    const h = realGit((a) => {
      if (injected || a[0] !== "rev-parse" || a[3] !== "refs/heads/feat/i28-a") return;
      injected = true;
      expect(git(["worktree", "add", "-q", "-b", "feat/external", wt(), "main"]).ok).toBe(true);
      writeFileSync(join(wt(), "external-unsaved.txt"), "别人的活");
    });
    expect(await h.start_node(PM, { featureId: "i28", key: "a", base: "main" })).toMatchObject({ ok: false, failedStep: "worktree", leftovers: [] });
    expect(readFileSync(join(wt(), "external-unsaved.txt"), "utf8")).toBe("别人的活");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).ok && Bun.spawnSync(["git", "-C", wt(), "branch", "--show-current"]).stdout.toString().trim()).toBe("feat/external");
    expect(readdirSync(join(dir, "wt"))).toEqual(["i28-a"]);
    expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/feat/i28-a"]).ok).toBe(false);
    expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
  });

  test("后面的步骤失败：本次的 worktree 与分支都撤掉", async () => {
    failOn = (a) => a[0] === "create";
    expect(await realGit().start_node(PM, { featureId: "i28", key: "a", base: "main" })).toMatchObject({ ok: false, failedStep: "agent", leftovers: [] });
    expect(readdirSync(join(dir, "wt"))).toEqual([]);
    expect(git(["worktree", "list", "--porcelain"]).out).not.toContain(join("wt", "i28-a"));
    expect(git(["rev-parse", "--verify", "--quiet", "refs/heads/feat/i28-a"]).ok).toBe(false);
  });
});

describe("r1：文件写到一半", () => {
  test("规格卡写进去后抛错：文件删掉，卡取消，不漏报", async () => {
    await plan();
    throwAfterWrite = (p) => p.endsWith("i28-a.md");
    expect(await start("a", PM, { spec: "正文" })).toMatchObject({ ok: false, failedStep: "spec", leftovers: [] });
    expect(existsSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"))).toBe(false);
    expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
  });

  test("执行者说明覆盖旧文件后抛错：恢复原内容", async () => {
    await plan();
    spec("i28-a");
    const prompt = join(dir, "ledger", "reviews", "i28-a-exec-prompt.md");
    mkdirSync(join(prompt, ".."), { recursive: true });
    writeFileSync(prompt, "旧说明");
    let once = true;
    throwAfterWrite = (p) => p === prompt && once && !(once = false);
    expect(await start("a")).toMatchObject({ ok: false, failedStep: "prompt", leftovers: [] });
    expect(readFileSync(prompt, "utf8")).toBe("旧说明");
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("规格卡在预检之后被别人写了：spec 步报错，不覆盖也不删", async () => {
    await plan();
    const specPath = join(dir, "ledger", "docs", "tasks", "i28-a.md");
    lose = (a) => (a[1] === "task-new" && (mkdirSync(join(specPath, ".."), { recursive: true }), writeFileSync(specPath, "PM 写的")), false);
    expect(await start("a", PM, { spec: "工具给的" })).toMatchObject({ ok: false, failedStep: "spec", leftovers: [] });
    expect(readFileSync(specPath, "utf8")).toBe("PM 写的");
  });
});
