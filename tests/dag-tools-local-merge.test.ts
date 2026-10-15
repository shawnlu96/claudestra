/**
 * ONB-1 验收 2：localMerge 项目 start_node 从本机 main 起、不 fetch；执行者说明里没有 push / PR。非本地项目照旧 origin/main + fetch，
 * 说明逐字不变（全文另由 tests/dag-tools-prompt.test.ts 钉）。真 git 临时仓库（没有 origin）+ 进程内台账，不碰生产目录。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { renderExecPrompt, type PromptVars } from "../src/lib/dag-tools-prompt.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "dn";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let dir: string, repo: string, db: Database, now: number, gitCalls: string[][];
let agents: Record<string, { channelId: string; projectId?: string }>;

async function git(cwd: string, args: string[]) {
  gitCalls.push(args);
  const r = await runBounded(["git", ...args], { cwd, env: ENV, timeoutMs: 30_000 });
  return { ok: r.code === 0 && !r.timedOut, out: (r.code === 0 ? r.stdout : r.stderr).trim() };
}

async function manager(args: string[], channelId: string): Promise<any> {
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

const deps = (local: boolean): DagToolDeps => ({
  db: () => db, manager, callerProject: (a) => agents[a]?.projectId ?? null,
  startEnv: () => ({
    ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents), exists: existsSync,
    branchExists: async (r, b) => (await git(r, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).ok, autoReady: () => null, template: () => null,
    ...(local ? { localMerge: () => true } : {}),
  }),
  stepIO: () => ({
    git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
    remove: (p) => rmSync(p, { force: true }), symlink: () => {}, agentExists: (a) => !!agents[a],
  }),
});
const call = (d: DagToolDeps, tool: string, args: unknown) => dagToolHandlers(d)[tool](PM, args) as Promise<Record<string, any>>;
const plan = () => call(deps(false), "plan_feature", { slug: "n7", title: "接入", ownerWords: "原话", nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/a.ts"] }] });
const prompt = () => readFileSync(join(dir, "ledger", "reviews", "n7-a-exec-prompt.md"), "utf8");

beforeEach(async () => {
  now = 1_000;
  gitCalls = [];
  dir = mkdtempSync(join(tmpdir(), "onb1-start-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  for (const a of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "base"]]) expect((await git(repo, a)).ok).toBe(true);
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P } };
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(join(dir, "ledger", "docs", "tasks", "n7-a.md"), "# 规格\n");
  expect((await plan()).ok).toBe(true);
  gitCalls = [];
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("start_node：localMerge 项目", () => {
  test("base 是本机 main，不 fetch；分支从 main 起；说明里不 push、不开 PR", async () => {
    expect(await call(deps(true), "start_node", { featureId: "n7", key: "a" })).toMatchObject({ ok: true, taskId: "n7-a" });
    expect(gitCalls.some((a) => a[0] === "fetch")).toBe(false);
    const add = gitCalls.find((a) => a[0] === "worktree" && a[1] === "add")!;
    expect(add.at(-1)).toBe("main");
    const main = (await git(repo, ["rev-parse", "main"])).out;
    expect((await git(repo, ["rev-parse", "refs/heads/feat/n7-a"])).out).toBe(main);
    expect(getTask(db, "n7-a")!.branch).toBe("feat/n7-a");
    const text = prompt();
    expect(text).toContain("（base main）");
    expect(text).toContain("不 push、不开 PR");
    for (const s of ["push 分支和开 PR 可以", "开好 PR", "--pr", "没开 PR 会被拒"]) expect(text).not.toContain(s);
  });

  test("显式 base 仍以参数为准", async () => {
    expect(await call(deps(true), "start_node", { featureId: "n7", key: "a", base: "main" })).toMatchObject({ ok: true });
    expect(gitCalls.some((a) => a[0] === "fetch")).toBe(false);
  });
});

describe("start_node：非本地项目不变", () => {
  test("base 缺省 origin/main，先 fetch origin（这个仓库没有 origin，所以在 worktree 一步失败并回滚）", async () => {
    expect(await call(deps(false), "start_node", { featureId: "n7", key: "a" })).toMatchObject({ ok: false, failedStep: "worktree" });
    expect(gitCalls.find((a) => a[0] === "fetch")).toEqual(["fetch", "-q", "origin"]);
  });

  test("renderExecPrompt：localMerge false / 缺省逐字相同；localMerge 不用整机自定义模板（复现 local-custom-prompt）", () => {
    const V: PromptVars = { task: "T1", title: "t", pm: "agent-pm", branch: "feat/t1", base: "main", worktree: "/wt", spec: "/s.md", ledgerDir: "/l" };
    expect(renderExecPrompt({ ...V, localMerge: false })).toBe(renderExecPrompt(V));
    const custom = "自定义 push 分支和开 PR 可以，推完记得开 PR。\n";
    expect(renderExecPrompt(V, custom).startsWith("自定义 push")).toBe(true); // 非本地项目照用自定义模板
    const out = renderExecPrompt({ ...V, localMerge: true }, custom);
    expect(out).toBe(renderExecPrompt({ ...V, localMerge: true }));
    expect(out).not.toContain("自定义");
    for (const s of ["push 分支和开 PR 可以", "开好 PR", "--pr"]) expect(out).not.toContain(s);
    expect(out).toContain("做完在分支 feat/t1 上 commit，**不 push、不开 PR**");
  });
});
