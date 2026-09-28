/** ledger 命令族（src/manager/ledger*.ts）：每个子命令正反例、CLI 层角色矩阵、task-new 联动 registry、rename 钩子、沙箱状态目录隔离 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { renameLedgerAgent, runLedger } from "../src/manager/ledger.js";
import { expandDocsDir } from "../src/manager/ledger-read-cmds.js";

const P = "claude-orchestrator";
const PM = "agent-claudestra";
const EXE = "agent-task-t8b";
let db: Database;
let reg: Registry;
let dir: string;

function agent(projectId = P) {
  return { status: "active", projectId } as Registry["agents"][string];
}

async function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: reg.agents[actor]?.projectId, projectIds: [P, "other"],
    loadRegistry: async () => reg, saveRegistry: async (r) => void (reg = r), now: () => 1_000,
  }) as Promise<Record<string, any>>;
}

beforeEach(async () => {
  db = openLedger(":memory:");
  dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  reg = { socket: "", agents: { [PM]: agent(), [EXE]: agent(), "agent-task-t4": agent() } };
  expect((await run("owner", "meta", "--project", P, "--pms", "claudestra")).ok).toBe(true);
  expect((await run(PM, "item-new", "i10", "--title", "台账")).ok).toBe(true);
});
afterEach(() => {
  closeLedger(":memory:");
  rmSync(dir, { recursive: true, force: true });
});

async function taskT8b() {
  return run(PM, "task-new", "T8b", "--title", "写入 CLI", "--kind", "code", "--item", "i10", "--agent", "task-t8b");
}

describe("入口与通用", () => {
  test("help / 空参数给用法；未知子命令、未知旗标报错", async () => {
    expect(await run("owner")).toMatchObject({ ok: true, usage: expect.stringContaining("ledger task-new") });
    expect(await run("owner", "nope")).toMatchObject({ ok: false, error: "未知子命令 nope" });
    expect(await run(PM, "note", "i10", "x", "--oops", "1")).toMatchObject({ ok: false, code: "invalid", error: "不认识的参数 --oops" });
  });
  test("whoami：owner / PM / 执行者 / 不在名单的 agent", async () => {
    expect(await run("owner")).toMatchObject({ ok: true });
    expect(await run("owner", "whoami")).toMatchObject({ actor: "owner", project: null, role: null });
    expect(await run(PM, "whoami")).toMatchObject({ actor: PM, project: P, role: "pm" });
    expect(await run("agent-task-t4", "whoami")).toMatchObject({ role: null });
  });
  test("项目：默认取 actor 所属项目；owner 不带 --project 报错；不在 projects.json 报 not_found", async () => {
    expect(await run("owner", "item-new", "i11", "--title", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("owner", "item-new", "i11", "--title", "x", "--project", "nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(await run("owner", "item-new", "i11", "--title", "x", "--project", "other")).toMatchObject({ ok: true, item: { project: "other" } });
  });
  test("--dedup 透传：同 key 重复提交返回 duplicate、不重复记", async () => {
    expect(await run(PM, "note", "i10", "进展", "--dedup", "k1")).toMatchObject({ ok: true, duplicate: false });
    expect(await run(PM, "note", "i10", "进展", "--dedup", "k1")).toMatchObject({ ok: true, duplicate: true });
    expect(listEvents(db, { target: "i10" }).filter((e) => e.kind === "note")).toHaveLength(1);
  });
});

describe("事项", () => {
  test("item-new：PM 能建，执行者不能；缺 title 报 invalid", async () => {
    expect(await run(EXE, "item-new", "i12", "--title", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, "item-new", "i12")).toMatchObject({ ok: false, code: "invalid", error: "缺 --title" });
    const r = await run(PM, "item-new", "i12", "--title", "x", "--status", "design", "--owner-words", "原话", "--extra", '{"links":[]}');
    expect(r.item).toMatchObject({ status: "design", ownerWords: "原话", extra: { links: [] } });
  });
  test("item-set：必须带 --rev；rev 不符报 conflict 并给当前 rev", async () => {
    expect(await run(PM, "item-set", "i10", "--next", "x")).toMatchObject({ ok: false, code: "invalid" });
    expect((await run(PM, "item-set", "i10", "--rev", "1", "--next", "派 T8c")).item).toMatchObject({ rev: 2, next: "派 T8c" });
    expect(await run(PM, "item-set", "i10", "--rev", "1", "--next", "x")).toMatchObject({ ok: false, code: "conflict", current: { rev: 2 } });
  });
});

describe("任务与 registry 联动", () => {
  test("task-new：PM 建任务，执行者挂到 PM 下、任务名写进 registry", async () => {
    const r = await taskT8b();
    expect(r).toMatchObject({ ok: true, task: { agent: EXE, stage: "spec", itemId: "i10" }, registryLinked: true });
    expect(reg.agents[EXE]).toMatchObject({ parent: PM, task: "写入 CLI" });
  });
  test("task-new：master 建 → parent 挂 master；owner 建不设 parent；执行者还没进 registry 只记台账", async () => {
    await run("master", "task-new", "T4x", "--title", "t", "--kind", "code", "--project", P, "--agent", "task-t4");
    expect(reg.agents["agent-task-t4"]).toMatchObject({ parent: "master", task: "t" });
    const r = await run("owner", "task-new", "T9x", "--title", "t", "--kind", "ops", "--project", P, "--agent", "task-nobody");
    expect(r).toMatchObject({ ok: true, registryLinked: false });
  });
  test("task-new：标题超过 40 字截断并标 taskTruncated；执行者不能建任务；kind 非法报 invalid", async () => {
    const long = "很长的任务标题".repeat(8);
    const r = await run(PM, "task-new", "T1", "--title", long, "--kind", "code", "--agent", "task-t8b");
    expect(r.taskTruncated).toBe(true);
    expect((reg.agents[EXE].task ?? "").length).toBe(40);
    expect(await run(EXE, "task-new", "T2", "--title", "x", "--kind", "code")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, "task-new", "T2", "--title", "x", "--kind", "bug")).toMatchObject({ ok: false, code: "invalid" });
  });
  test("task-set：执行者改自己任务的分支可以，改执行者不行；PM 改执行者时 registry 跟着挂", async () => {
    await taskT8b();
    expect((await run(EXE, "task-set", "T8b", "--rev", "1", "--branch", "task/t8b-ledger-cli")).task.rev).toBe(2);
    expect(await run(EXE, "task-set", "T8b", "--rev", "2", "--agent", "task-t4")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-task-t4", "task-set", "T8b", "--rev", "2", "--branch", "x")).toMatchObject({ ok: false, code: "forbidden" });
    const r = await run(PM, "task-set", "T8b", "--rev", "2", "--agent", "task-t4");
    expect(r).toMatchObject({ ok: true, task: { agent: "agent-task-t4" }, registryLinked: true });
    expect(reg.agents["agent-task-t4"]).toMatchObject({ parent: PM, task: "写入 CLI" });
  });
});

describe("阶段、进展、交付、审查", () => {
  beforeEach(taskT8b);
  test("stage：执行者 spec→restate；越权 forbidden；阶段名写错 invalid；from 不符 conflict 带当前阶段", async () => {
    expect(await run(EXE, "stage", "T8b", "--from", "spec", "--to", "restate")).toMatchObject({ ok: true, task: { stage: "restate" } });
    expect(await run(EXE, "stage", "T8b", "--from", "restate", "--to", "build")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, "stage", "T8b", "--from", "restate", "--to", "bulid")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "stage", "T8b", "--from", "spec", "--to", "restate")).toMatchObject({ ok: false, code: "conflict", current: { stage: "restate" } });
  });
  test("note：执行者写自己的任务可以，写事项 / 项目级不行；PM 写项目级；空正文、未知目标报错", async () => {
    expect(await run(EXE, "note", "T8b", "开工了")).toMatchObject({ ok: true, event: { target: "T8b", text: "开工了" } });
    expect(await run(EXE, "note", "i10", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(EXE, "note", "-", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, "note", "-", "项目级", "进展")).toMatchObject({ ok: true, event: { target: "", text: "项目级 进展" } });
    expect(await run(PM, "note", "T8b")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "note", "T404", "x")).toMatchObject({ ok: false, code: "not_found" });
  });
  test("deliver：执行者交付并推到 review；别人不行", async () => {
    await run(EXE, "stage", "T8b", "--from", "spec", "--to", "restate");
    await run(PM, "stage", "T8b", "--from", "restate", "--to", "build");
    expect(await run("agent-task-t4", "deliver", "T8b", "--head", "abc")).toMatchObject({ ok: false, code: "forbidden" });
    const r = await run(EXE, "deliver", "T8b", "--head", "abc", "--evidence", "docs/tasks/T8b.report.md", "--from", "build");
    expect(r).toMatchObject({ ok: true, task: { stage: "review", round: 1, headSHA: "abc" }, event: { kind: "deliver", data: { round: 1 } } });
  });
  test("review：只有 PM；缺 P 计数 invalid；--to 同事务推阶段", async () => {
    await run(EXE, "stage", "T8b", "--from", "spec", "--to", "restate");
    await run(PM, "stage", "T8b", "--from", "restate", "--to", "build");
    await run(EXE, "deliver", "T8b", "--from", "build");
    const args = ["review", "T8b", "--reviewer", "claude-reviewer", "--verdict", "changes", "--p0", "0", "--p1", "3", "--p2", "8"];
    expect(await run(EXE, ...args)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, "review", "T8b", "--reviewer", "r", "--verdict", "pass")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, ...args, "--to", "fix")).toMatchObject({ ok: true, task: { stage: "fix" }, event: { data: { p1: 3, p2: 8, round: 1 } } });
  });
});

describe("决定、部署、验证、回滚、冻结", () => {
  beforeEach(taskT8b);
  test("decision：owner 本人是原话，PM 写的标转录；执行者不能写", async () => {
    expect((await run("owner", "decision", "i10", "你开工吧", "--project", P)).event.data).toEqual({ transcribed: false });
    expect((await run(PM, "decision", "i10", "owner", "说", "开工")).event).toMatchObject({ text: "owner 说 开工", data: { transcribed: true } });
    expect(await run(EXE, "decision", "T8b", "x")).toMatchObject({ ok: false, code: "forbidden" });
  });
  test("deploy / verify / rollback：PM 写，字段进 data；缺必填、取值不对报 invalid", async () => {
    expect((await run(PM, "deploy", "T8b", "--version", "0d2e7a3", "--rollback-point", "12aa2a8")).event.data).toEqual({ version: "0d2e7a3", rollbackPoint: "12aa2a8" });
    expect(await run(PM, "deploy", "T8b")).toMatchObject({ ok: false, code: "invalid" });
    expect((await run(PM, "verify", "T8b", "--result", "pass")).event.data).toEqual({ result: "pass", evidence: null });
    expect(await run(PM, "verify", "T8b", "--result", "ok")).toMatchObject({ ok: false, code: "invalid" });
    expect((await run(PM, "rollback", "T8b", "--to", "12aa2a8")).event.data).toEqual({ to: "12aa2a8" });
    expect(await run(EXE, "rollback", "T8b")).toMatchObject({ ok: false, code: "forbidden" });
  });
  test("freeze / unfreeze：PM 冻结要写原因；重复冻结 conflict；执行者不能", async () => {
    expect(await run(PM, "freeze")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(EXE, "freeze", "--reason", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await run(PM, "freeze", "--reason", "线上验证失败")).meta.queueFrozen).toMatchObject({ frozen: true, reason: "线上验证失败" });
    expect(await run(PM, "freeze", "--reason", "again")).toMatchObject({ ok: false, code: "conflict" });
    expect((await run(PM, "unfreeze")).meta.queueFrozen.frozen).toBe(false);
  });
});

describe("meta / show / export", () => {
  test("meta：不带参数查看；只有 owner 能设；--pms 归一成 registry 键；--docs-dir 展开 ~、拒相对路径", async () => {
    expect((await run(PM, "meta")).meta.pms).toEqual([PM]);
    expect(await run(PM, "meta", "--pms", "x")).toMatchObject({ ok: false, code: "forbidden" });
    const r = await run("owner", "meta", "--project", P, "--pms", "claudestra, Task-T4", "--docs-dir", "~/ledger/docs");
    expect(r.meta).toMatchObject({ pms: [PM, "agent-task-t4"], docsDir: expandDocsDir("~/ledger/docs") });
    expect(r.meta.docsDir.startsWith("/")).toBe(true);
    expect(await run("owner", "meta", "--project", P, "--docs-dir", "docs")).toMatchObject({ ok: false, code: "invalid" });
  });
  test("show：项目总览带任务指标；任务详情带指标与最近事件；事项带挂着的任务；未知报 not_found", async () => {
    await taskT8b();
    await run(EXE, "stage", "T8b", "--from", "spec", "--to", "restate");
    const all = await run(PM, "show");
    expect(all).toMatchObject({ ok: true, project: P, items: [{ id: "i10" }], tasks: [{ id: "T8b", metrics: { startTs: 1000 } }] });
    const t = await run(EXE, "show", "T8b", "--events", "1");
    expect(t).toMatchObject({ task: { stage: "restate" }, metrics: { reworkCount: 0 } });
    expect(t.events).toHaveLength(1);
    expect((await run(PM, "show", "i10")).tasks.map((x: { id: string }) => x.id)).toEqual(["T8b"]);
    expect(await run(PM, "show", "i404")).toMatchObject({ ok: false, code: "not_found" });
  });
  test("export：--out 写单项目 JSON；--sqlite 走 VACUUM INTO；两个都给 / 都不给、目标已存在都拒绝", async () => {
    await taskT8b();
    const out = join(dir, "p.json");
    expect(await run(PM, "export", "--out", out)).toMatchObject({ ok: true, items: 1, tasks: 1 });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ project: P, tasks: [{ id: "T8b" }] });
    expect(await run(PM, "export", "--out", out)).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(PM, "export")).toMatchObject({ ok: false, code: "invalid" });
    const sq = join(dir, "copy.sqlite");
    expect(await run(PM, "export", "--sqlite", sq)).toMatchObject({ ok: true });
    const copy = openLedger(sq);
    expect(getTask(copy, "T8b")?.title).toBe("写入 CLI");
    closeLedger(sq);
  });
  test("import：非 owner 拒绝", async () => {
    expect(await run(PM, "import", "x.json", "--map", "m.json")).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("rename 钩子", () => {
  test("台账库存在：tasks.agent 与 PM 名单跟着改名；库不存在：什么都不做、不建库", async () => {
    const path = join(dir, "ledger.sqlite");
    const fdb = openLedger(path);
    createTask(fdb, { actor: "owner" }, { project: P, id: "T8b", title: "t", kind: "code", agent: "agent-task-t8a" });
    await renameLedgerAgent("agent-task-t8a", "agent-task-t8b", path);
    expect(getTask(fdb, "T8b")?.agent).toBe("agent-task-t8b");
    closeLedger(path);
    const none = join(dir, "none", "ledger.sqlite");
    await renameLedgerAgent("a", "b", none);
    expect(existsSync(none)).toBe(false);
  });
});

test("沙箱：CLAUDESTRA_STATE_DIR 指到哪，ledger.sqlite 就建在哪", async () => {
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "demo", name: "demo", dirs: ["/tmp"], createdAt: "2026-09-28" }] }));
  const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "run") };
  delete env.DISCORD_CHANNEL_ID;
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/manager.ts"), "ledger", "item-new", "i01", "--project", "demo", "--title", "沙箱"], { env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "";
  expect(JSON.parse(out)).toMatchObject({ ok: true, item: { project: "demo", id: "i01" } });
  expect(existsSync(join(state, "ledger.sqlite"))).toBe(true);
}, 30_000);
