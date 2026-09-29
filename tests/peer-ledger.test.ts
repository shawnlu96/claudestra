/**
 * 跨实例委托的台账接口：lib/peer-ledger.ts（可见范围、请求解析、操作判定）、ledger-stages.ts 的 peer 角色、
 * manager/ledger-peer.ts（`ledger peer-write` 的执行与 actor）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { canTransition, delegatePeerOf, roleOf } from "../src/lib/ledger-stages.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { parsePeerOp, peerLinks, peerOpDenied, peerTaskDetail, peerTasks } from "../src/lib/peer-ledger.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
let db: Database;

function write(actor: string, task: string, body: Record<string, unknown>) {
  return runLedger(["peer-write", "Shawn", task, JSON.stringify(body)], {
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 2_000,
  }) as Promise<Record<string, any>>;
}

beforeEach(() => {
  db = openLedger(":memory:");
  const ctx = { actor: "owner", now: 1_000 };
  setMeta(db, ctx, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, ctx, { project: P, id: "T46", title: "委托", kind: "code", extra: { delegate: "claudestra-debug@shawn", reviewer: "alex@Sekai" } });
  createTask(db, ctx, { project: P, id: "T36", title: "审查", kind: "code", extra: { reviewer: "claudestra-debug@Shawn" } });
  createTask(db, ctx, { project: P, id: "T1", title: "本机的", kind: "code", agent: "agent-x" });
  appendEvent(db, ctx, { project: P, target: "T46", kind: "decision", text: "owner 原话" });
  appendEvent(db, ctx, { project: P, target: "T46", kind: "note", text: "开工" });
});
afterEach(() => closeLedger(":memory:"));

describe("peer 角色与可见范围", () => {
  test("@ 后面的 peer 名（不分大小写）决定关系；roleOf 只给执行方 peer 角色", () => {
    const t = getTask(db, "T46")!;
    expect(delegatePeerOf(t, "delegate")).toBe("shawn");
    expect(peerLinks(t, "Shawn")).toEqual(["delegate"]);
    expect(peerLinks(t, "sekai")).toEqual(["reviewer"]);
    expect(roleOf("peer:Shawn", t, ["agent-pm"])).toBe("peer");
    expect(roleOf("peer:Sekai", t, [])).toBeNull();
    expect(roleOf("peer:Shawn", getTask(db, "T1")!, [])).toBeNull();
  });

  test("peer 能推：接活、交付、进出 blocked；合并及以后、取消不行", () => {
    const at = (stage: string, stageBefore: string | null = null) => ({ kind: "code" as const, stage: stage as any, stageBefore: stageBefore as any });
    for (const [s, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["fix", "review"], ["build", "blocked"]]) {
      expect(canTransition(at(s), to as any, "peer").ok).toBe(true);
    }
    expect(canTransition(at("blocked", "build"), "build", "peer").ok).toBe(true);
    for (const [s, to] of [["review", "merge"], ["merge", "live"], ["build", "cancelled"], ["review", "spec"], ["merge", "blocked"]]) {
      expect(canTransition(at(s), to as any, "peer")).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  test("列表只有委托给它的卡；详情藏掉 owner 原话，别人的卡 404", () => {
    expect(peerTasks(db, "Shawn").map((t) => [t.id, t.links])).toEqual(expect.arrayContaining([["T46", ["delegate"]], ["T36", ["reviewer"]]]));
    expect(peerTasks(db, "Shawn")).toHaveLength(2);
    const d = peerTaskDetail(db, "Shawn", "T46")!;
    expect(d.events.map((e) => e.kind)).not.toContain("decision");
    expect(d.events.some((e) => e.text === "开工")).toBe(true);
    expect(peerTaskDetail(db, "Shawn", "T1")).toBeNull();
    expect(peerTaskDetail(db, "Other", "T46")).toBeNull();
  });
});

describe("请求解析与操作判定", () => {
  test("parsePeerOp", () => {
    expect(parsePeerOp({ op: "note", text: "x" })).toEqual({ op: "note", text: "x" });
    expect(typeof parsePeerOp({ op: "note" })).toBe("string");
    expect(typeof parsePeerOp({ op: "pr", pr: "#1" })).toBe("string"); // 缺 rev
    expect(typeof parsePeerOp({ op: "stage", from: "build", to: "nope" })).toBe("string");
    expect(typeof parsePeerOp({ op: "review", verdict: "ok", p0: 0, p1: 0, p2: 0 })).toBe("string");
    expect(typeof parsePeerOp({ op: "delete" })).toBe("string");
  });
  test("审查方只能记审查和 note；执行方合并后不能改 PR", () => {
    const build = { stage: "build" as const, stageBefore: null };
    expect(peerOpDenied({ op: "review", verdict: "pass", p0: 0, p1: 0, p2: 0 }, build, ["delegate"])).not.toBeNull();
    expect(peerOpDenied({ op: "stage", from: "build", to: "review" }, build, ["reviewer"])).not.toBeNull();
    expect(peerOpDenied({ op: "note", text: "x" }, build, ["reviewer"])).toBeNull();
    expect(peerOpDenied({ op: "pr", rev: 1, pr: "#2" }, { stage: "merge", stageBefore: null }, ["delegate"])).not.toBeNull();
    expect(peerOpDenied({ op: "pr", rev: 1, pr: "#2" }, { stage: "blocked", stageBefore: "build" }, ["delegate"])).toBeNull();
  });
});

describe("ledger peer-write", () => {
  test("只认 owner 身份调用（bridge）；agent 冒充不了", async () => {
    expect(await write("agent-x", "T46", { op: "note", text: "x" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("接活 → 挂 PR → 交审，事件 actor 记 peer:<名>；合并不行", async () => {
    expect((await write("owner", "T46", { op: "stage", from: "spec", to: "restate", text: "复述" })).ok).toBe(true);
    expect((await write("owner", "T46", { op: "stage", from: "restate", to: "build" })).ok).toBe(true);
    const rev = getTask(db, "T46")!.rev;
    const pr = await write("owner", "T46", { op: "pr", rev, pr: "https://github.com/shawnlu96/claudestra/pull/200", head: "df77a244" });
    expect(pr).toMatchObject({ ok: true, task: { pr: "https://github.com/shawnlu96/claudestra/pull/200", headSHA: "df77a244" } });
    expect(pr.event.actor).toBe("peer:Shawn");
    expect((await write("owner", "T46", { op: "pr", rev, pr: "#3" })).code).toBe("conflict");
    expect((await write("owner", "T46", { op: "pr", rev: rev + 1, pr: "not-a-pr" })).code).toBe("invalid");
    expect((await write("owner", "T46", { op: "stage", from: "build", to: "review" })).ok).toBe(true);
    expect((await write("owner", "T46", { op: "stage", from: "review", to: "merge" })).code).toBe("forbidden");
  });

  test("审查方记审查结论（任务在 review），不带阶段跳转；不是给它的卡 not_found", async () => {
    expect((await write("owner", "T36", { op: "review", verdict: "pass", p0: 0, p1: 0, p2: 1 })).code).toBe("invalid"); // 还在 spec
    db.run("UPDATE tasks SET stage = 'review' WHERE id = 'T36'");
    const r = await write("owner", "T36", { op: "review", verdict: "changes", p0: 0, p1: 2, p2: 1, text: "见 PR", dedup: "r1" });
    expect(r).toMatchObject({ ok: true, task: { stage: "review" } });
    expect(r.event.data).toMatchObject({ reviewer: "peer:Shawn", verdict: "changes" });
    expect((await write("owner", "T36", { op: "review", verdict: "changes", p0: 0, p1: 2, p2: 1, dedup: "r1" })).duplicate).toBe(true);
    expect((await write("owner", "T1", { op: "note", text: "x" })).code).toBe("not_found");
  });
});
