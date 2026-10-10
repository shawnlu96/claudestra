/**
 * START1：start_node 的执行者身份与 local 固定。假 manager 用真实的 normalizeName（manager/core.ts）定 registry 键、回执带 agent，
 * 这样「卡号里带 agent- 片段被 manager 改名、台账绑错」（AGL1）这类边界才测得出来。台账是临时库里的进程内 runLedger，git 是假的。
 * bridge 管道与预检撞名在 tests/dag-tools-bridge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartPlan } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import type { Feature } from "../src/lib/ledger-feature.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { specPlaceBlock } from "../src/lib/scheduler-spec-resume-write.js";
import { normalizeName } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
let dir: string, db: Database, now: number, kills: string[];
/** create 登记 agent 后顺带做的事（模拟执行者已在 worktree 里开工） */
let onCreate: (args: string[]) => void;
let agents: Record<string, { channelId: string; projectId: string; task?: string }>;
/** create 的行为：normal = 真实 manager；lost = 建好但结果丢了；thrown = 建好但取结果时抛异常；reuse = 回执给出别的（已有的）名字 */
let createMode: "normal" | "lost" | "thrown" | "reuse" | "nameless" | "phantom";

async function manager(args: string[]): Promise<any> {
  if (args[0] === "create") {
    const name = normalizeName(args[1]);
    if (createMode === "reuse") return { ok: true, agent: "agent-history" };
    if (createMode === "phantom") return { ok: true };
    agents[name] = { channelId: `ch-${name}`, projectId: P, task: args[args.indexOf("--task") + 1] };
    onCreate(args);
    if (createMode === "thrown") throw new Error("读 manager 输出时断了");
    return createMode === "lost" ? { ok: false, error: "超时，结果丢了" } : createMode === "nameless" ? { ok: true } : { ok: true, agent: name };
  }
  if (args[0] === "kill") { kills.push(args[1]); delete agents[args[1]]; return { ok: true }; }
  if (args[1] === "dag-bind") return { ok: true };
  return runLedger(args.slice(1), {
    db, actor: "agent-pm", projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {},
    now: () => now++, autoDispatch: () => true, autoProjects: () => [P],
  });
}

const io = (): StepIO => ({
  db: () => db, manager, attempt: "t1",
  git: async (_cwd, args) => ({ ok: true, out: args[0] === "rev-parse" && args[3].endsWith("^{commit}") ? "base0" : "" }),
  exists: existsSync, read: () => null, write: () => {}, remove: () => {}, symlink: () => {}, agentExists: (a) => !!agents[a],
});

/** 与 dag-tools-start.ts 同一派生：agentName = task-<小写卡号>，agent = agent-<agentName> */
const plan = (id: string, more: Partial<StartPlan> = {}): StartPlan => ({
  feature: { id: "ab12-f" } as Feature, key: "n", taskId: id, title: "节点", project: P, item: null, pm: "agent-pm",
  base: "main", branch: `feat/${id.toLowerCase()}`, repo: join(dir, "repo"), worktree: join(dir, "wt", id.toLowerCase()),
  agentName: `task-${id.toLowerCase()}`, agent: `agent-task-${id.toLowerCase()}`, fileGlobs: ["src/lib/n.ts"], specRel: `docs/tasks/${id}.md`,
  specPath: join(dir, "spec.md"), specText: null, promptPath: join(dir, "prompt.md"), promptText: "说明", purpose: "执行者", ...more,
});

beforeEach(() => {
  now = 1_000;
  kills = [];
  createMode = "normal";
  onCreate = () => {};
  agents = { "agent-pm": { channelId: "ch-pm", projectId: P }, "agent-history": { channelId: "ch-h", projectId: P } };
  dir = mkdtempSync(join(tmpdir(), "start1-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("执行者身份：只绑 manager 实际建出的规范名", () => {
  test("卡号含 agent- 片段（AGL1）：registry 键、台账 agent、回执三者一致", async () => {
    const id = "agent-list-recovery-AGL1";
    expect(await runStart(io(), plan(id))).toMatchObject({ ok: true, agent: "agent-task-agent-list-recovery-agl1" });
    expect(Object.keys(agents)).toContain("agent-task-agent-list-recovery-agl1");
    expect(Object.keys(agents)).not.toContain("agent-task-list-recovery-agl1");
    expect(getTask(db, id)?.agent).toBe("agent-task-agent-list-recovery-agl1");
  });

  test("普通卡号：传给 create 的仍是短名，结果不变", async () => {
    expect(await runStart(io(), plan("f-n"))).toMatchObject({ ok: true, agent: "agent-task-f-n" });
    expect(getTask(db, "f-n")?.agent).toBe("agent-task-f-n");
  });

  test("回执给出别的名字（同名历史会话）：不绑、不 kill，留 unknown，卡不取消、列为残留", async () => {
    createMode = "reuse";
    const r = await runStart(io(), plan("f-n"));
    expect(r).toMatchObject({ ok: false, failedStep: "agent", rolledBack: [] });
    expect(!r.ok && r.leftovers[0]).toContain("agent-history 归属不明（unknown）");
    expect(!r.ok && r.leftovers.at(-1)).toStartWith("task-new：没撤");
    expect(agents["agent-history"]).toBeDefined();
    expect(kills).toEqual([]);
    expect(getTask(db, "f-n")).toMatchObject({ stage: "spec", agent: null });
  });

  test("成功回执缺 agent 名：registry 核实到才绑；核实不了留 unknown，不拿计划名充数", async () => {
    createMode = "nameless";
    expect(await runStart(io(), plan("f-m"))).toMatchObject({ ok: true, agent: "agent-task-f-m" });
    expect(getTask(db, "f-m")?.agent).toBe("agent-task-f-m");
    createMode = "phantom";
    const r = await runStart(io(), plan("f-missing"));
    expect(r).toMatchObject({ ok: false, failedStep: "agent", error: expect.stringContaining("registry 里也查不到 agent-task-f-missing") });
    expect(!r.ok && r.leftovers[0]).toContain("agent-task-f-missing 归属不明（unknown）");
    expect(getTask(db, "f-missing")?.agent).toBeNull();
    expect(agents["agent-task-f-missing"]).toBeUndefined();
    expect(kills).toEqual([]);
  });

  test("create 部分完成、结果丢了：归属不明不 kill；后面的步骤失败才 kill 本次核实建的那个", async () => {
    createMode = "lost";
    const r = await runStart(io(), plan("agent-x-AGL1"));
    expect(!r.ok && r.leftovers[0]).toContain("agent-task-agent-x-agl1 归属不明（unknown）");
    expect(kills).toEqual([]);
    createMode = "normal";
    const failing: StepIO = { ...io(), manager: async (a) => (a[1] === "workflow-set" && a.some((x) => x.endsWith("auto")) ? { ok: false, error: "拒" } : manager(a)) };
    expect(await runStart(failing, plan("agent-y-AGL1"))).toMatchObject({ ok: false, failedStep: "workflow", leftovers: [] });
    expect(kills).toEqual(["agent-task-agent-y-agl1"]);
  });
});

describe("local 固定跨重启不漂移", () => {
  const reopen = () => { closeLedger(join(dir, "ledger.sqlite")); db = openLedger(join(dir, "ledger.sqlite")); };
  const block = (id: string) => specPlaceBlock(db, getTask(db, id)!, getWorkflow(db, id));

  test("显式 local：卡上写 placement=local，重开台账后 spec 恢复仍不接手", async () => {
    expect(await runStart(io(), plan("f-l", { localOnly: true }))).toMatchObject({ ok: true });
    reopen();
    expect(getTask(db, "f-l")?.extra.placement).toBe("local");
    expect(block("f-l")).toBe("start_node 已固定放置");
  });

  test("auto 落本机不写 local 固定；peer 固定照旧写 peer", async () => {
    expect(await runStart(io(), plan("f-a"))).toMatchObject({ ok: true });
    expect(getTask(db, "f-a")?.extra.placement).toBeUndefined();
    const peer = plan("f-p", { peer: { name: "sekai", repo: "o/r", reason: "测试" } });
    expect(await runStart(io(), peer)).toMatchObject({ ok: true, placement: "peer:sekai" });
    expect(getTask(db, "f-p")?.extra.placement).toBe("peer:sekai");
    expect(Object.keys(agents)).not.toContain("agent-task-f-p");
  });
});

describe("unknown 执行者的工作目录：真实 git", () => {
  const sh = (cwd: string, args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
    return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const realIo = (): StepIO => ({
    ...io(), git: async (cwd, args) => sh(cwd, args),
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null), write: (p, t) => writeFileSync(p, t), remove: (p) => rmSync(p, { force: true }),
  });

  test.each([["回执超时", "lost"], ["create 的 Promise 抛异常", "thrown"]] as const)("create 已登记、执行者已在 worktree 写了文件、%s：不 kill，worktree / 分支 / 说明 / 卡都留着，未提交的工作不丢", async (_, mode) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) expect(sh(repo, a).ok).toBe(true);
    createMode = mode;
    onCreate = (args) => writeFileSync(join(args[2], "inflight.txt"), "未提交的工作");
    const p = plan("f-w");
    const r = await runStart(realIo(), p);
    expect(r).toMatchObject({ ok: false, failedStep: "agent", rolledBack: [] });
    expect(!r.ok && r.leftovers.map((l) => l.split("：")[0])).toEqual(["agent", "prompt", "worktree", "spec", "task-new"]);
    expect(agents["agent-task-f-w"]).toBeDefined();
    expect(kills).toEqual([]);
    expect(readFileSync(join(p.worktree, "inflight.txt"), "utf8")).toBe("未提交的工作");
    expect(sh(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`]).ok).toBe(true);
    expect(readFileSync(p.promptPath, "utf8")).toBe("说明");
    expect(getTask(db, "f-w")?.stage).not.toBe("cancelled");
  });

  test("对照：create 明确失败、registry 里没有：照旧全部回滚", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) expect(sh(repo, a).ok).toBe(true);
    const p = plan("f-x");
    const r = await runStart({ ...realIo(), manager: async (a) => (a[0] === "create" ? { ok: false, error: "拒" } : manager(a)) }, p);
    expect(r).toMatchObject({ ok: false, failedStep: "agent", leftovers: [] });
    expect(existsSync(p.worktree)).toBe(false);
    expect(sh(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`]).ok).toBe(false);
    expect(existsSync(p.promptPath)).toBe(false);
    expect(getTask(db, "f-x")?.stage).toBe("cancelled");
  });
});
