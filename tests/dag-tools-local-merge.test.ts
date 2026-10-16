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
import { startIo } from "../src/lib/scheduler-autostart-deps.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ensureLocalAuthor } from "../src/lib/scheduler-local-author.js";
import { localAuthorPlan } from "../src/lib/scheduler-local-author-plan.js";
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

describe("本地默认说明的文字（PM 要求逐字钉住）", () => {
  test("与非本地说明只差这三行、末尾多一行检查没过的说法，其余逐字相同", () => {
    const V: PromptVars = { task: "T1", title: "标题", pm: "agent-pm", branch: "feat/t1", base: "main", worktree: "/wt/t1", spec: "/l/docs/tasks/T1.md", ledgerDir: "/l" };
    const pr = renderExecPrompt(V).split("\n"), all = renderExecPrompt({ ...V, localMerge: true }).split("\n");
    // ONB-2：本地项目没有 run 链接和合并闸，没过的检查写进证据，由 PM 合并时核对（不能出现「CI 等待」「附 run 链接」）
    const red = "- 检查没过又不归本卡的，在证据报告里列明失败的检查和复现方法，由 PM 本地合并时核对。";
    expect(all.at(-2)).toBe(red);
    expect(all.join("\n")).not.toMatch(/CI 等待|run 链接/);
    const local = all.filter((l) => l !== red);
    expect(local.length).toBe(pr.length);
    const changed = local.map((l, i) => [pr[i], l]).filter(([a, b]) => a !== b);
    expect(changed.map(([, b]) => b)).toEqual([
      "- 不合并、不部署、不打 tag、不发 release；只 commit 到本卡分支，不 push、不开 PR。只在当前 worktree 改文件，不碰主树。",
      "- 「开工 / 修复」单：做完在分支 feat/t1 上 commit，**不 push、不开 PR**（本项目没有 PR 流程），再用 deliver 工具（或 `ledger deliver T1 --from build|fix --head <完整 sha>`）交付，"
        + "就结束这一轮。head 是本机分支 feat/t1 的完整 sha，deliver 按它核对。调度器会自己派审、转修复，合并由 PM 在本机完成。",
   
      "- 交付前必须完成的检查（本项目的必过检查）不放后台（run_in_background），前台跑完再交付。放了后台的，交付前先确认它仍在且已结束（看进程和输出里的退出行）；"
        + "确认不了就重跑——会话一重启后台任务就被杀，完成信号不会再来。",
    ]);
    expect(changed.map(([a]) => a)).toEqual([
      "- 不合并、不部署、不打 tag、不发 release；push 分支和开 PR 可以。只在当前 worktree 改文件，不碰主树。",
      "- 「开工 / 修复」单：做完 push，**开好 PR（base main，已开过的不用重开）**，再用 deliver 工具（或 `ledger deliver T1 --from build|fix --head <完整 sha> --pr <完整 PR 链接>`）交付，"
        + "就结束这一轮。PR 链接由 deliver 自动登记，没开 PR 会被拒。调度器会自己派审、转修复、排合并。",
   
      "- 交付前必须完成的检查（全量 check、CI 等待、monitor）不放后台（run_in_background），前台跑完再交付。放了后台的，交付前先确认它仍在且已结束（看进程和输出里的退出行）；"
        + "确认不了就重跑——会话一重启后台任务就被杀，完成信号不会再来。",
    ]);
  });
});

describe("调度器自己的开卡 / 补建路径（复现 local-start-paths）", () => {
  const cfg = (local: boolean) => ({ enabled: true, autoDispatch: true, projects: { [P]: { maxActiveWorkers: 2, requiredChecks: ["cargo test"], repoDir: repo,
    ...(local ? { localMerge: true } : {}) } } });
  const files = (local: boolean) => {
    const configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
    writeFileSync(configPath, JSON.stringify(cfg(local)));
    writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: P, dirs: [repo] }] }));
    return { configPath, projectsPath };
  };

  /** 补一条作者建会话意图，跑一次 ensureLocalAuthor；git 记调用、create 失败收住 */
  async function ensureOnce(task: ReturnType<typeof getTask> & {}, opts: { configPath: string; projectsPath: string }) {
    const seq = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
    db.query("DELETE FROM scheduler_intents WHERE id = 'i-author'").run();
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('i-author', 'n7-a', ?, 'write', 'ensure_session', 1, ?, ?, ?, NULL, 3, 'submitted', 'author', 1, 1)`).run(P, seq + 1, task.rev, task.specRev);
    rmSync(join(dir, "wt2"), { recursive: true, force: true });
    const calls: string[][] = [];
    const r = await ensureLocalAuthor({ db, worktreeRoot: join(dir, "wt2"), active: () => {}, registryRow: () => undefined,
      git: async (args) => {
        calls.push(args);
        if (args.includes("rev-parse")) {
          if (args.at(-1)?.startsWith("refs/heads/")) return { code: 1, out: "" };
          if (args.at(-1) === "--absolute-git-dir") return { code: 0, out: join(dir, "wt2-git") };
          return { code: 0, out: "1".repeat(40) };
        }
        if (args.includes("add")) mkdirSync(args.at(-2)!, { recursive: true });
        return { code: 0, out: "" };
      },
      create: async () => ({ ok: false, error: "测试到此为止" }), ledger: async () => ({ ok: true }) }, task, opts);
    return { r, calls };
  }

  test("autostart 的 startEnv 按 scheduler.json 注入 localMerge", () => {
    const env = (local: boolean) => startIo({ db, ledger: async () => ({ ok: true }), active: () => {}, lease: undefined } as never,
      parseSchedulerConfig(cfg(local))).startEnv();
    expect(env(true).localMerge?.(P)).toBe(true);
    expect(env(false).localMerge?.(P)).toBe(false);
    expect(env(true).localMerge?.("__proto__")).toBe(false);
  });

  test("补建执行者：起点本机 main、说明本地口径、checkout 不 fetch origin", async () => {
    expect(await call(deps(true), "start_node", { featureId: "n7", key: "a" })).toMatchObject({ ok: true });
    const opts = files(true);
    db.query("UPDATE tasks SET agent = NULL WHERE id = 'n7-a'").run();
    const task = getTask(db, "n7-a")!;
    const plan = await localAuthorPlan(db, task, join(dir, "wt2"), opts);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan).toMatchObject({ base: "main", localMerge: true });
    expect(plan.promptText).toContain("不 push、不开 PR");
    expect(plan.promptText).not.toContain("开好 PR");
    const plain = await localAuthorPlan(db, task, join(dir, "wt2"), files(false));
    expect(typeof plain !== "string" && plain.base).toBe("origin/main");
    expect(typeof plain !== "string" && "localMerge" in plain).toBe(false);

    files(true);
    const { r, calls } = await ensureOnce(task, opts);
    expect(r.kind).not.toBe("ok");
    expect(calls.some((a) => a.includes("fetch"))).toBe(false);
    expect(calls.find((a) => a.includes("rev-parse") && a.at(-1)?.endsWith("^{commit}"))?.at(-1)).toBe("main^{commit}");
    expect(calls.some((a) => a.includes("worktree") && a.includes("add"))).toBe(true);
    const plainRun = await ensureOnce(task, files(false)); // 非本地项目：照旧先 fetch origin、从 origin/main 起
    expect(plainRun.calls.some((a) => a.includes("fetch") && a.includes("origin"))).toBe(true);
    expect(plainRun.calls.find((a) => a.includes("rev-parse") && a.at(-1)?.endsWith("^{commit}"))?.at(-1)).toBe("origin/main^{commit}");
  });
});
