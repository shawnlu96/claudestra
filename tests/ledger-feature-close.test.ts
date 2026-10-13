/**
 * team-project-FCLOSE1：子 DAG 全完成仍 active 的 feature 列候选（只读）+ feature-close 一条命令关单。
 * 台账是临时目录里的文件库（规格卡在库旁 ledger/docs/tasks/，整页验收要读）；卡阶段用 UPDATE 直接改，模拟「快照之后卡变了」。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFeature } from "../src/lib/ledger-feature.js";
import type { Stage } from "../src/lib/ledger-stages.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const UI_SPEC = "# 规格\n模板：ui\n## 复用对象\n团队视图\n## 对照基准\n/tmp/base.png 现有团队视图\n";
let dir: string, dbPath: string, db: Database;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P],
    loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => 5_000,
  }) as Promise<Record<string, any>>;
}

const J = (x: unknown) => JSON.stringify(x);
const fid = (slug: string) => `ab12-${slug}`;
const rev = (slug: string) => String(getFeature(db, fid(slug))!.rev);
const spec = (taskId: string, text: string) => writeFileSync(join(dir, "ledger", "docs", "tasks", `${taskId}.md`), text);
const setStage = (id: string, stage: string) => db.prepare("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
const featureEvents = (slug: string) => listEvents(db, { project: P }).filter((e) => e.target === fid(slug) && e.kind === "feature");

function card(id: string, stage: Stage) {
  const agent = stage === "spec" || stage === "verified" || stage === "cancelled" ? {} : { assigneeKind: "agent" as const, assignee: "agent-x" };
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id, title: `卡 ${id}`, kind: "code", stage, ...agent });
}

async function feature(slug: string, nodes?: unknown[]) {
  expect((await run(PM, "feature-new", slug, "--title", `功能 ${slug}`)).ok).toBe(true);
  if (nodes) expect((await run(PM, "dag-init", slug, "--rev", rev(slug), "--nodes", J(nodes)))).toMatchObject({ ok: true });
}

async function candidates() {
  const r = await run(PM, "feature-close-candidates", "--project", P);
  expect(r.ok).toBe(true);
  return r.candidates as { id: string; title: string; rev: number; counts: Record<string, number>; refusal: string | null; close: string }[];
}
const ids = async () => (await candidates()).map((c) => c.id);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fclose1-"));
  dbPath = join(dir, "ledger.sqlite");
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  db = openLedger(dbPath);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

describe("[验收线 1] 完成判定按卡现读", () => {
  test("快照 verified、卡现在 fix → 不是；快照 build、卡现在 verified → 是", async () => {
    card("t-stale", "verified"); card("t-fresh", "build");
    await feature("stale", [{ key: "a", taskId: "t-stale", oneLine: "a" }]);
    await feature("fresh", [{ key: "a", taskId: "t-fresh", oneLine: "a" }]);
    setStage("t-stale", "fix"); setStage("t-fresh", "verified");
    expect(await ids()).toEqual([fid("fresh")]);
  });

  test("卡 cancelled + 没开工的远期节点 → 是；节点全是远期 → 不是", async () => {
    card("t-c", "cancelled");
    await feature("later", [{ key: "a", taskId: "t-c", oneLine: "a" }, { key: "b", oneLine: "（远期）以后再说" }]);
    await feature("allfar", [{ key: "a", oneLine: "（远期）甲" }, { key: "b", oneLine: "(远期) 乙" }]);
    const list = await candidates();
    expect(list.map((c) => c.id)).toEqual([fid("later")]);
    expect(list[0]).toMatchObject({ counts: { total: 2, completed: 1, deferred: 1 }, refusal: null });
  });

  test("没绑卡的 PAGEOK 没验收 → 不是；done / paused → 不是；没 DAG、卡全 verified → 是", async () => {
    card("t-ui", "verified"); spec("t-ui", UI_SPEC);
    await feature("page", [{ key: "a", taskId: "t-ui", oneLine: "a" }]);
    card("t-p", "verified"); card("t-d", "verified");
    await feature("paused", [{ key: "a", taskId: "t-p", oneLine: "a" }]);
    expect((await run(PM, "feature-set", "paused", "--rev", rev("paused"), "--status", "paused")).ok).toBe(true);
    await feature("done", [{ key: "a", taskId: "t-d", oneLine: "a" }]);
    expect((await run(PM, "feature-set", "done", "--rev", rev("done"), "--status", "done")).ok).toBe(true);
    card("t-f1", "verified"); card("t-f2", "verified");
    await feature("flat");
    db.prepare("UPDATE tasks SET featureId = ? WHERE id IN ('t-f1', 't-f2')").run(fid("flat"));
    const list = await candidates();
    expect(list.map((c) => c.id)).toEqual([fid("flat")]);
    expect(list[0]).toMatchObject({ title: "功能 flat", counts: { total: 2, completed: 2, deferred: 0 }, refusal: null });
  });

  test("按 id 排序，rev 与 close 命令取当前值", async () => {
    for (const s of ["zeta", "alpha"]) { card(`t-${s}`, "verified"); await feature(s, [{ key: "a", taskId: `t-${s}`, oneLine: "a" }]); }
    const list = await candidates();
    expect(list.map((c) => c.id)).toEqual([fid("alpha"), fid("zeta")]);
    expect(list[0]).toMatchObject({ rev: 2, close: `ledger feature-close ${fid("alpha")} --rev 2` });
  });
});

describe("[验收线 2] feature-close", () => {
  test("rev 对且 complete → done、rev 加一、写一条 feature 事件（op set）", async () => {
    card("t-a", "verified");
    await feature("ok", [{ key: "a", taskId: "t-a", oneLine: "a" }]);
    const before = featureEvents("ok").length;
    const r = await run(PM, "feature-close", "ok", "--rev", "2");
    expect(r).toMatchObject({ ok: true, feature: { status: "done", rev: 3 } });
    const after = featureEvents("ok");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.data).toMatchObject({ op: "set", patch: { status: "done" }, rev: 3 });
    expect(await ids()).toEqual([]);
  });

  test("rev 不对 → setFeature 的 conflict 原文", async () => {
    card("t-a", "verified");
    await feature("ok", [{ key: "a", taskId: "t-a", oneLine: "a" }]);
    const r = await run(PM, "feature-close", fid("ok"), "--rev", "1");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("已被改过：当前 rev 2，你带的是 1");
    expect(getFeature(db, fid("ok"))).toMatchObject({ status: "active", rev: 2 });
  });

  test("不 complete → conflict 带 counts，台账不变；列出后卡退回 fix 再关 → conflict", async () => {
    card("t-a", "verified"); card("t-b", "build");
    await feature("half", [{ key: "a", taskId: "t-a", oneLine: "a" }, { key: "b", taskId: "t-b", oneLine: "b" }]);
    const n = listEvents(db, { project: P }).length;
    const r = await run(PM, "feature-close", "half", "--rev", rev("half"));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("total 2、completed 1、deferred 0");
    expect(listEvents(db, { project: P }).length).toBe(n);
    expect(getFeature(db, fid("half"))).toMatchObject({ status: "active", rev: 2 });

    setStage("t-b", "verified");
    const [c] = await candidates();
    expect(c.id).toBe(fid("half"));
    setStage("t-a", "fix");
    const again = await run(PM, ...c.close.split(" ").slice(1));
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(getFeature(db, fid("half"))).toMatchObject({ status: "active", rev: 2 });
  });

  test("没 --rev → invalid；没有的 feature → not_found", async () => {
    card("t-a", "verified");
    await feature("ok", [{ key: "a", taskId: "t-a", oneLine: "a" }]);
    expect(await run(PM, "feature-close", "ok")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "feature-close", "nope", "--rev", "1")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("[验收线 3] 各道闸照旧", () => {
  test("整页验收不过：refusal 写原因，feature-close 被 setFeature 拒，台账不变", async () => {
    card("t-late", "verified");
    await feature("late", [{ key: "a", taskId: "t-late", oneLine: "a" }]);
    spec("t-late", UI_SPEC); // 建 DAG 之后才落盘的 ui 规格：没有 PAGEOK 节点，整页验收闸要拒
    const [c] = await candidates();
    expect(c.id).toBe(fid("late"));
    expect(c.refusal).toContain("整页验收节点 PAGEOK 还没 verified");
    const n = listEvents(db, { project: P }).length;
    const r = await run(PM, ...c.close.split(" ").slice(1));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("整页验收节点 PAGEOK 还没 verified");
    expect(listEvents(db, { project: P }).length).toBe(n);
    expect(getFeature(db, fid("late"))).toMatchObject({ status: "active", rev: 2 });
  });

  test("不是 manager 的身份：两条命令都被拒", async () => {
    card("t-a", "verified");
    await feature("ok", [{ key: "a", taskId: "t-a", oneLine: "a" }]);
    expect(await run("agent-x", "feature-close-candidates", "--project", P)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-x", "feature-close", "ok", "--rev", "2")).toMatchObject({ ok: false, code: "forbidden" });
    expect(getFeature(db, fid("ok"))).toMatchObject({ status: "active", rev: 2 });
  });
});

describe("[验收线 4] 读写划分与输出", () => {
  test("candidates 走只读连接，feature-close 按写算", () => {
    expect(READER_ONLY_SUBS.has("feature-close-candidates")).toBe(true);
    expect(isWriteInvocation("ledger", ["feature-close-candidates", "--project", P])).toBe(false);
    expect(isWriteInvocation("ledger", ["feature-close", "x", "--rev", "2"])).toBe(true);
  });

  test("输出里的 close 命令照抄就能跑", async () => {
    card("t-a", "verified");
    await feature("ok", [{ key: "a", taskId: "t-a", oneLine: "a" }]);
    const [c] = await candidates();
    expect(c.close.startsWith("ledger ")).toBe(true);
    expect(await run(PM, ...c.close.split(" ").slice(1))).toMatchObject({ ok: true, feature: { id: fid("ok"), status: "done" } });
  });
});
