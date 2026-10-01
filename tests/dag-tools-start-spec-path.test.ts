/**
 * i28-N8 start_node 在卡上记规格卡的绝对路径：task.spec 等于实际写入 / 已存在的规格卡文件，specPathFor(task, null) 能直接解析，
 * 不靠 meta.docsDir（多数项目没设）。本机放置与 peer 放置两条路都测；临时台账 + 假 git / manager，不碰生产 ~/.claude-orchestrator。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import type { StartPlacement } from "../src/lib/scheduler-placement-start.js";
import { specPathFor } from "../src/lib/task-spec.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };

let dir: string, repo: string, db: Database, now: number, branches: Set<string>;
let agents: Record<string, { channelId: string; projectId?: string }>;
let failOn: (args: string[]) => boolean;

async function managerRun(args: string[], channelId: string): Promise<any> {
  if (failOn(args)) return { ok: false, error: `注入失败：${args[0]} ${args[1]}` };
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

/** 只认 start_node 会跑的几条 git；worktree add 建目录，后面的步骤才看得到 */
async function fakeGit(args: string[]): Promise<{ ok: boolean; out: string }> {
  const [cmd, sub] = args;
  if (cmd === "worktree" && sub === "add") {
    mkdirSync(args.at(-2) as string, { recursive: true });
    branches.add(args[args.indexOf("-b") + 1]);
  } else if (cmd === "worktree" && sub === "remove") rmSync(args.at(-1) as string, { recursive: true, force: true });
  else if (cmd === "rev-parse") {
    const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", ""));
    return { ok, out: ok ? "base0" : "" };
  } else if (cmd === "branch") branches.delete(args[2]);
  return { ok: true, out: "" };
}

function deps(placement?: StartPlacement): DagToolDeps {
  return {
    db: () => db,
    manager: managerRun,
    callerProject: (a) => agents[a]?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
      exists: existsSync, branchExists: async (_r, b) => branches.has(b), autoReady: () => null, template: () => null,
      ...(placement ? { placement: async () => placement } : {}),
    }),
    stepIO: () => ({
      git: async (_cwd, args) => fakeGit(args),
      exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
      remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    }),
  };
}

const call = (d: DagToolDeps, tool: string, args: unknown) => dagToolHandlers(d)[tool](PM, args) as Promise<Record<string, any>>;
const plan = () => call(deps(), "plan_feature", { slug: "i28", title: "协作底座", ownerWords: "原话",
  nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
const start = (more: Record<string, unknown> = {}, d = deps()) => call(d, "start_node", { featureId: "i28", key: "a", ...more });
const specFile = () => join(dir, "ledger", "docs", "tasks", "i28-a.md");

/** 卡上的 spec 是绝对路径、就是那份规格卡；docsDir 为 null 也能解析，读到的正文就是写进去的那份 */
function expectAbsoluteSpec(body: string) {
  const t = getTask(db, "i28-a")!;
  expect(isAbsolute(t.spec as string)).toBe(true);
  expect(t.spec).toBe(specFile());
  expect(specPathFor(t, null)).toBe(specFile());
  expect(readFileSync(specPathFor(t, null) as string, "utf8")).toBe(body);
}

beforeEach(() => {
  now = 1_000;
  failOn = () => false;
  branches = new Set(["main"]);
  dir = mkdtempSync(join(tmpdir(), "i28-n8-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P } };
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("本机放置", () => {
  test("规格卡已在：task.spec 是它的绝对路径，执行者说明引用同一路径", async () => {
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
    writeFileSync(specFile(), "# 已有规格\n");
    expect((await plan()).ok).toBe(true);
    expect(await start()).toMatchObject({ ok: true, taskId: "i28-a" });
    expectAbsoluteSpec("# 已有规格\n");
    expect(readFileSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"), "utf8")).toContain(specFile());
  });

  test("spec 参数给正文：start_node 写出的那份文件就是 task.spec", async () => {
    expect((await plan()).ok).toBe(true);
    expect(await start({ spec: "# 新写规格" })).toMatchObject({ ok: true, taskId: "i28-a" });
    expectAbsoluteSpec("# 新写规格\n");
  });

  test("中途失败回滚：卡取消、本次写的规格卡删掉，specPathFor 不再指向不存在的文件", async () => {
    expect((await plan()).ok).toBe(true);
    failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set";
    expect(await start({ spec: "# 规格" })).toMatchObject({ ok: false, failedStep: "workflow" });
    const t = getTask(db, "i28-a")!;
    expect(t).toMatchObject({ stage: "cancelled", spec: specFile() });
    expect(existsSync(specFile())).toBe(false);
    expect(specPathFor(t, null)).toBeNull();
  });
});

describe("peer 放置", () => {
  const PEER: StartPlacement = { where: "peer", peer: "mate", repo: "o/r", reason: "在跑：mate 0 / 本机 2；选最少" };

  test("规格卡已在：peer 卡同样记绝对路径", async () => {
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
    writeFileSync(specFile(), "# peer 规格\n");
    expect((await plan()).ok).toBe(true);
    expect(await start({ placement: "peer:mate" }, deps(PEER))).toMatchObject({ ok: true, placement: "peer:mate" });
    expectAbsoluteSpec("# peer 规格\n");
  });

  test("spec 参数给正文：peer 卡记的是写出的那份文件", async () => {
    expect((await plan()).ok).toBe(true);
    expect(await start({ placement: "peer:mate", spec: "# peer 新写" }, deps(PEER))).toMatchObject({ ok: true, placement: "peer:mate" });
    expectAbsoluteSpec("# peer 新写\n");
  });
});
