/**
 * i28-SECPOOL2：私仓卡进统一池（docs/architecture/private-pool.md）。off（含缺键）= 私仓节点照旧 stop private、文案不变；
 * observe = 派单同 off，原因多一句按私仓进池的去处；on = 按 fileGlobs 的 repo: 前缀在项目 dirs 里找 clone 开卡，卡上写 extra.repo。
 * 临时台账 + 测试状态目录里的 projects.json / private-pool.json；两个本地 git 目录只配了 origin，不联网。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { privatePoolMode, setPrivatePoolMode, type PrivatePoolMode } from "../src/lib/card-repo.js";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { PROJECTS_PATH } from "../src/lib/projects.js";
import { currentViews, isStop, nodeCandidate, SPEC_SETTLE_MS, type GateStop } from "../src/lib/scheduler-autostart.js";
import type { StartPlacement } from "../src/lib/scheduler-placement-start.js";
import { securityPoolMode } from "../src/lib/security-pool.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";
import { PRIVATE_POOL_CMDS } from "../src/manager/private-pool-cmds.js";

const P = "claude-orchestrator", FID = "ab12-i28", PRIV = "floka-ai/cloud";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const PRIV_GLOBS = [`repo:${PRIV}/src/app/*.ts`, `repo:${PRIV}/docs/x.md`];

let dir: string, pub: string, priv: string, db: Database, now: number, branches: Set<string>, projectsBefore: string | null;
let agents: Record<string, { channelId: string; projectId?: string }>;
const cleanup: (() => unknown)[] = [];

function gitRepo(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", path]);
  Bun.spawnSync(["git", "-C", path, "remote", "add", "origin", origin]);
  return path;
}
const writeProjects = (dirs: string[]) =>
  writeFileSync(PROJECTS_PATH, JSON.stringify({ projects: [{ id: P, name: P, dirs, createdAt: "2026-10-10" }] }));
const mode = async (m: PrivatePoolMode) => { await setPrivatePoolMode(P, m); };

function plan(nodes: { key: string; fileGlobs: string[] }[]): void {
  createFeature(db, { actor: PM.agent, now: now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM.agent, now: now++ }, { id: FID, rev: 1, nodes: nodes.map((n) => ({ ...n, oneLine: `节点 ${n.key}`, deps: [] })) });
}
const ripe = { mtimeMs: 0, text: "# 规格\n模板：code\n\n## 目标\n" };
function gate(key = "a"): GateStop | "open" {
  const f = getFeature(db, FID)!;
  const r = nodeCandidate(db, f, key, featureLanes(db, f), currentViews(db, f), () => ({ ...ripe, mtimeMs: now - SPEC_SETTLE_MS - 1 }), now);
  return isStop(r) ? r : "open";
}

async function managerRun(args: string[], channelId: string): Promise<any> {
  if (args[0] === "ledger") {
    const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
    if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
    return runLedger(args.slice(1), { db, actor: who.actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never,
      saveRegistry: async () => {}, now: () => now++, autoDispatch: () => true, autoProjects: () => [P] });
  }
  if (args[0] === "create") agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
  else if (args[0] === "kill") delete agents[args[1]];
  return { ok: true };
}
async function fakeGit(args: string[]): Promise<{ ok: boolean; out: string }> {
  const [cmd, sub] = args;
  if (cmd === "worktree" && sub === "add") { mkdirSync(args.at(-2) as string, { recursive: true }); branches.add(args[args.indexOf("-b") + 1]); }
  else if (cmd === "rev-parse") {
    const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", ""));
    return { ok, out: ok ? "base0" : "" };
  }
  return { ok: true, out: "" };
}
/** placement 记下 start_node 交给放置的目录 */
let placedDirs: string[];
function deps(placement?: StartPlacement): DagToolDeps {
  return {
    db: () => db, manager: managerRun, callerProject: (a) => agents[a]?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [pub, priv], agentNames: () => Object.keys(agents),
      exists: existsSync, branchExists: async (_r, b) => branches.has(b), autoReady: () => null, template: () => null,
      placement: async (_db, q) => { placedDirs.push(q.repoDir); return placement ?? { where: "local", reason: "本机有空位" }; },
    }),
    stepIO: () => ({
      git: async (_cwd, args) => fakeGit(args), exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
      remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    }),
  };
}
const startNode = (d: DagToolDeps, more: Record<string, unknown> = {}) =>
  dagToolHandlers(d).start_node(PM, { featureId: "i28", key: "a", spec: "# 规格", ...more }) as Promise<Record<string, any>>;

beforeEach(async () => {
  now = 10_000_000;
  branches = new Set(["main"]);
  placedDirs = [];
  dir = mkdtempSync(join(tmpdir(), "secpool2-"));
  pub = gitRepo(join(dir, "claudestra"), "https://github.com/shawnlu96/claudestra.git");
  priv = gitRepo(join(dir, "cloud"), "git@github.com:floka-ai/cloud.git");
  projectsBefore = existsSync(PROJECTS_PATH) ? readFileSync(PROJECTS_PATH, "utf8") : null;
  writeProjects([pub, priv]);
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P } };
  await mode("off");
});
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  await mode("off");
  if (projectsBefore === null) rmSync(PROJECTS_PATH, { force: true }); else writeFileSync(PROJECTS_PATH, projectsBefore);
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("开关（验收线 8）", () => {
  test("缺键 = off；写入后按项目读回；和 security-pool 各存各的", async () => {
    const path = join(dir, "private-pool.json");
    expect(privatePoolMode("p", path)).toBe("off");
    expect(await setPrivatePoolMode("p", "observe", path)).toEqual({ from: "off", mode: "observe" });
    expect(await setPrivatePoolMode("p", "on", path)).toEqual({ from: "observe", mode: "on" });
    expect(privatePoolMode("p", path)).toBe("on");
    expect(privatePoolMode("q", path)).toBe("off");
    expect(existsSync(`${path}.r2`)).toBe(true);
    await mode("on");
    expect(securityPoolMode(P)).toBe("off");
  });

  test("非法取值按 off、带项目名警告一次；文件损坏按 off；写者非法值报错", async () => {
    const path = join(dir, "private-pool.json"), err = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => err.mockRestore());
    writeFileSync(path, JSON.stringify({ rev: 0, projects: { proj7: "maybe" } }));
    expect(privatePoolMode("proj7", path)).toBe("off");
    expect(privatePoolMode("proj7", path)).toBe("off");
    const warns = err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("private-pool"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("proj7");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    expect(privatePoolMode("p", bad)).toBe("off");
    await expect(setPrivatePoolMode("p", "on", bad)).rejects.toThrow(/损坏/);
    await expect(setPrivatePoolMode("p", "yes", path)).rejects.toThrow(/on \/ observe \/ off/);
  });

  test("命令：不带取值只读；非法值直接报错；只有项目 PM / master / owner 能切", async () => {
    const run = PRIVATE_POOL_CMDS["private-pool"].run;
    let pm = true;
    const cli = (pos: string[]) => ({ p: { pos, flags: {} }, project: () => P,
      requireRealPm: () => { if (!pm) throw new Error("forbidden"); } }) as never;
    expect(await run(cli(["private-pool"]))).toEqual({ ok: true, project: P, mode: "off" });
    await expect(run(cli(["private-pool", "sure"]))).rejects.toThrow(/on \/ observe \/ off/);
    pm = false;
    await expect(run(cli(["private-pool", "on"]))).rejects.toThrow(/forbidden/);
    expect(privatePoolMode(P)).toBe("off");
    pm = true;
    expect(await run(cli(["private-pool", "on"]))).toEqual({ ok: true, project: P, from: "off", mode: "on" });
    expect(privatePoolMode(P)).toBe("on");
  });

  test("ledger 命令表里有 private-pool", async () => {
    const r = await runLedger(["private-pool", "--project", P], { db, actor: PM.agent, projectIds: [P], loadRegistry: async () => ({}) as never,
      saveRegistry: async () => {}, now: () => now++ }) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, project: P, mode: "off" });
  });
});

describe("自动开卡的门（验收线 1 / 2 / 3 / 7）", () => {
  test("off：私仓节点照旧 stop private，文案逐字不变；公共仓节点照常是候选", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }, { key: "b", fileGlobs: ["src/lib/b.ts"] }]);
    expect(gate("a")).toEqual({ gate: "private", why: "私仓节点由 PM 用私仓开卡流程手动开" });
    expect(gate("b")).toBe("open");
  });

  test("observe：派单同 off，原因多一句会用哪个仓库和目录", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }]);
    await mode("observe");
    expect(gate()).toEqual({ gate: "private", why: `私仓节点由 PM 用私仓开卡流程手动开；按私仓进池会用 ${PRIV}（${priv}）开卡` });
  });

  test("on：项目 dirs 里有 clone 就放行", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }]);
    await mode("on");
    expect(gate()).toBe("open");
  });

  test("on：没有 clone / 混了仓库 / 带前缀和不带混用 → stop 并给原因", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }, { key: "b", fileGlobs: [`repo:${PRIV}/a.ts`, "repo:other/x/b.ts"] },
      { key: "c", fileGlobs: [`repo:${PRIV}/c.ts`, "src/c.ts"] }]);
    await mode("on");
    writeProjects([pub]);
    expect(gate("a")).toEqual({ gate: "private", why: `项目 dirs 里没有 ${PRIV} 的 clone` });
    expect((gate("b") as GateStop).why).toContain("混了 2 个仓库");
    expect((gate("c") as GateStop).why).toContain("混在一起");
    await mode("observe");
    expect((gate("a") as GateStop).why).toBe(`私仓节点由 PM 用私仓开卡流程手动开；按私仓进池会停：项目 dirs 里没有 ${PRIV} 的 clone`);
  });
});

describe("start_node / 自动开卡建卡（验收线 2 / 3）", () => {
  test("on + 本机：预检用私仓目录，卡上写 extra.repo，fileGlobs 原样保留前缀", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }]);
    await mode("on");
    expect(await startNode(deps())).toMatchObject({ ok: true, taskId: "i28-a" });
    expect(placedDirs).toEqual([priv]);
    expect(getTask(db, "i28-a")!.extra).toMatchObject({ repo: PRIV, fileGlobs: [...PRIV_GLOBS].sort() });
  });

  test("on + peer：放置拿到私仓目录，extra.repo 是 peer 放置的仓库", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }]);
    await mode("on");
    const peer: StartPlacement = { where: "peer", peer: "mate", repo: PRIV, reason: "选最少" };
    expect(await startNode(deps(peer), { placement: "peer:mate" })).toMatchObject({ ok: true, placement: "peer:mate" });
    expect(placedDirs).toEqual([priv]);
    expect(getTask(db, "i28-a")!.extra).toMatchObject({ repo: PRIV, placement: "peer:mate" });
  });

  test("on：项目 dirs 里没有 clone → 拒，不落到公共仓", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }]);
    await mode("on");
    const d = deps();
    const env = d.startEnv;
    d.startEnv = () => ({ ...env(), projectDirs: async () => [pub] });
    expect(await startNode(d)).toMatchObject({ ok: false, error: expect.stringContaining(`项目 dirs 里没有 ${PRIV} 的 clone`) });
    expect(getTask(db, "i28-a")).toBeNull();
    expect(placedDirs).toEqual([]);
  });

  test("off：start_node 和改动前一样取第一个 git 目录，不写 extra.repo；公共仓节点 on 也不变", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }, { key: "b", fileGlobs: ["src/lib/b.ts"] }]);
    expect(await startNode(deps())).toMatchObject({ ok: true });
    expect(placedDirs).toEqual([pub]);
    expect(getTask(db, "i28-a")!.extra.repo).toBeUndefined();
    await mode("on");
    expect(await startNode(deps(), { key: "b" })).toMatchObject({ ok: true });
    expect(placedDirs).toEqual([pub, pub]);
    expect(getTask(db, "i28-b")!.extra.repo).toBeUndefined();
  });

  test("自动开卡 step task-new：私仓节点放本机也写 extra.repo，公共仓节点不写", async () => {
    plan([{ key: "a", fileGlobs: PRIV_GLOBS }, { key: "b", fileGlobs: ["src/lib/b.ts"] }]);
    const sch = (...args: string[]) => runLedger(args, { db, actor: "scheduler", projectIds: [P], loadRegistry: async () => ({}) as never,
      saveRegistry: async () => {}, now: () => now++, autoDispatch: () => true, autoProjects: () => [P] }) as Promise<Record<string, any>>;
    for (const [key, arm] of [["a", "0123456789abcdef"], ["b", "fedcba9876543210"]]) {
      const c = await sch("scheduler-autostart", "claim", FID, key, "--arm", arm, "--template", "code", "--max-workers", "3");
      expect(c).toMatchObject({ ok: true });
      expect(await sch("scheduler-autostart", "step", String(c.claim.seq), "task-new", `i28-${key}`, "--title=x", "--kind=code", `--dedup=d:${key}`))
        .toMatchObject({ ok: true });
    }
    expect(getTask(db, "i28-a")!.extra).toMatchObject({ repo: PRIV });
    expect(getTask(db, "i28-b")!.extra.repo).toBeUndefined();
  });
});
