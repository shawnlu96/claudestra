/**
 * 跨实例委托的台账接口：lib/peer-ledger.ts（可见范围、事件白名单、请求解析、操作判定）、ledger-stages.ts 的 peer 角色、
 * manager/ledger-peer.ts（`ledger peer-write` 的执行与 actor）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { canTransition, delegatePeerOf, roleOf, type LedgerTask } from "../src/lib/ledger-stages.js";
import { derivedSteps } from "../src/lib/ledger-steps.js";
import { appendEvent, createTask, deliver, moveStage, setMeta, setTask } from "../src/lib/ledger-write.js";
import { parsePeerOp, peerLinks, peerOpDenied, peerTaskDetail, peerTasks } from "../src/lib/peer-ledger.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const OWNER = { actor: "owner", now: 1_000 };
let db: Database;

function write(actor: string, task: string, body: Record<string, unknown>, peer = "Shawn") {
  return runLedger(["peer-write", "--", peer, task, JSON.stringify(body)], {
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 2_000,
  }) as Promise<Record<string, any>>;
}
const toStage = (id: string, stage: string) => db.run(`UPDATE tasks SET stage = '${stage}' WHERE id = '${id}'`);

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, {
    project: P, id: "T46", title: "委托", kind: "code", branch: "feat/secret-branch",
    extra: { delegate: "claudestra-debug@Shawn", reviewer: "alex@Sekai", internal: "SECRET_EXTRA" },
  });
  createTask(db, OWNER, { project: P, id: "T36", title: "审查", kind: "code", extra: { reviewer: "claudestra-debug@Shawn" } });
  createTask(db, OWNER, { project: P, id: "T1", title: "本机的", kind: "code", agent: "agent-x" });
  appendEvent(db, OWNER, { project: P, target: "T46", kind: "decision", text: "owner 原话" });
  appendEvent(db, { actor: "agent-pm", now: 1_100 }, { project: P, target: "T46", kind: "note", text: "budget 5k, host 10.1.2.3" });
});
afterEach(() => closeLedger(":memory:"));

describe("peer 角色与可见范围", () => {
  test("@ 后面的 peer 名精确匹配（大小写不同就不是它）；roleOf 只给执行方 peer 角色", () => {
    const t = getTask(db, "T46")!;
    expect(delegatePeerOf(t, "delegate")).toBe("Shawn");
    expect(peerLinks(t, "Shawn")).toEqual(["delegate"]);
    expect(peerLinks(t, "shawn")).toEqual([]);
    expect(peerLinks(t, "SHAWN")).toEqual([]);
    expect(peerLinks(t, "Sekai")).toEqual(["reviewer"]);
    expect(roleOf("peer:Shawn", t, ["agent-pm"])).toBe("peer");
    expect(roleOf("peer:shawn", t, [])).toBeNull();
    expect(roleOf("peer:Sekai", t, [])).toBeNull();
    expect(roleOf("peer:Shawn", getTask(db, "T1")!, [])).toBeNull();
    expect(peerTasks(db, "SHAWN")).toEqual([]);
  });

  test("peer 能推：写复述、交付、进出 blocked；放行复述、合并及以后、取消不行", () => {
    const at = (stage: string, stageBefore: string | null = null) => ({ kind: "code" as const, stage: stage as any, stageBefore: stageBefore as any });
    for (const [s, to] of [["spec", "restate"], ["build", "review"], ["fix", "review"], ["build", "blocked"]]) {
      expect(canTransition(at(s), to as any, "peer").ok).toBe(true);
    }
    expect(canTransition(at("blocked", "build"), "build", "peer").ok).toBe(true);
    for (const [s, to] of [["restate", "build"], ["review", "merge"], ["merge", "live"], ["build", "cancelled"], ["review", "spec"], ["merge", "blocked"]]) {
      expect(canTransition(at(s), to as any, "peer")).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  test("列表只有委托给它的卡；别的卡、别的 peer 看不到", () => {
    expect(peerTasks(db, "Shawn").map((t) => [t.id, t.links])).toEqual(expect.arrayContaining([["T46", ["delegate"]], ["T36", ["reviewer"]]]));
    expect(peerTasks(db, "Shawn")).toHaveLength(2);
    expect(peerTaskDetail(db, "Shawn", "T1")).toBeNull();
    expect(peerTaskDetail(db, "Other", "T46")).toBeNull();
  });

  test("时间线白名单：建卡的 extra / 分支、PM 的 note、owner 原话都不出去；阶段只给 from/to，PR / head / 审查结论给", async () => {
    moveStage(db, { actor: "agent-pm", now: 1_200 }, { taskId: "T46", from: "spec", to: "restate", text: "PM 的内部说明" });
    moveStage(db, { actor: "agent-pm", now: 1_300 }, { taskId: "T46", from: "restate", to: "build" });
    setTask(db, { actor: "agent-pm", now: 1_400 }, { id: "T46", rev: getTask(db, "T46")!.rev, patch: { pr: "#200", spec: "tasks/T46.md" } });
    deliver(db, { actor: "agent-pm", now: 1_500 }, { taskId: "T46", headSHA: "abcdef1", evidence: "/secret/evidence.md", moveFrom: "build" });
    expect((await write("owner", "T46", { op: "note", text: "我这边的进度" })).ok).toBe(true);
    const d = peerTaskDetail(db, "Shawn", "T46")!;
    const dump = JSON.stringify(d);
    for (const secret of ["SECRET_EXTRA", "feat/secret-branch", "10.1.2.3", "owner 原话", "PM 的内部说明", "tasks/T46.md", "/secret/evidence.md", "agent-pm"]) {
      expect(dump).not.toContain(secret);
    }
    expect(d.events.filter((e) => e.kind === "stage").map((e) => e.data)).toEqual([{ from: "spec", to: "restate" }, { from: "restate", to: "build" }, { from: "build", to: "review" }]);
    expect(d.events.find((e) => e.kind === "task")?.data).toEqual({ pr: "#200" });
    expect(d.events.find((e) => e.kind === "deliver")?.data).toEqual({ headSHA: "abcdef1" });
    expect(d.events.find((e) => e.mine)).toMatchObject({ kind: "note", text: "我这边的进度" });
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
  test("老卡（按 extra 推的步骤）：审查方只能记审查和 note；执行方只在 build / fix 挂 PR", () => {
    const card = (stage: string) => ({ id: "T1", stage, stageBefore: null, round: 0, agent: null, assignee: null, assigneeKind: null, createdAt: 1, updatedAt: 1,
      extra: { delegate: "agent-d@A", reviewer: "agent-r@B" } }) as unknown as LedgerTask;
    const deny = (op: Parameters<typeof peerOpDenied>[0], stage: string, peer: string) => peerOpDenied(op, card(stage), derivedSteps(card(stage)), peer);
    expect(deny({ op: "review", verdict: "pass", p0: 0, p1: 0, p2: 0 }, "review", "A")).not.toBeNull();
    expect(deny({ op: "review", verdict: "pass", p0: 0, p1: 0, p2: 0 }, "review", "B")).toBeNull();
    expect(deny({ op: "stage", from: "build", to: "review" }, "build", "B")).not.toBeNull();
    expect(deny({ op: "note", text: "x" }, "build", "B")).toBeNull();
    for (const s of ["build", "fix"]) expect(deny({ op: "pr", rev: 1, pr: "#2" }, s, "A")).toBeNull();
    for (const s of ["spec", "restate", "review", "merge", "blocked"]) expect(deny({ op: "pr", rev: 1, pr: "#2" }, s, "A")).not.toBeNull();
  });
});

describe("ledger peer-write", () => {
  test("只认 owner 身份调用（bridge）", async () => {
    expect(await write("agent-x", "T46", { op: "note", text: "x" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("写复述后停在 restate，放行要等 PM；之后挂 PR → 交审，actor 记 peer:<名>；review 阶段不能再换 PR", async () => {
    expect((await write("owner", "T46", { op: "stage", from: "spec", to: "restate", text: "复述" })).ok).toBe(true);
    expect((await write("owner", "T46", { op: "stage", from: "restate", to: "build" })).code).toBe("forbidden");
    moveStage(db, { actor: "agent-pm", now: 1_500 }, { taskId: "T46", from: "restate", to: "build" });
    const rev = getTask(db, "T46")!.rev;
    const pr = await write("owner", "T46", { op: "pr", rev, pr: "https://github.com/shawnlu96/claudestra/pull/200", head: "df77a244" });
    expect(pr).toMatchObject({ ok: true, task: { pr: "https://github.com/shawnlu96/claudestra/pull/200", headSHA: "df77a244" } });
    expect(pr.event.mine).toBe(true); // 回给 peer 的事件过白名单（不带 actor）；库里的 actor 记 peer:<名>
    expect(listEvents(db, { project: P, target: "T46" }).at(-1)!.actor).toBe("peer:Shawn");
    expect((await write("owner", "T46", { op: "pr", rev, pr: "#3" })).code).toBe("conflict");
    expect((await write("owner", "T46", { op: "pr", rev: rev + 1, pr: "not-a-pr" })).code).toBe("invalid");
    expect((await write("owner", "T46", { op: "stage", from: "build", to: "review" })).ok).toBe(true);
    expect((await write("owner", "T46", { op: "pr", rev: rev + 2, head: "0123456" })).code).toBe("forbidden");
    expect((await write("owner", "T46", { op: "stage", from: "review", to: "merge" })).code).toBe("forbidden");
  });

  test("大小写不同的 peer 名写不进去", async () => {
    expect((await write("owner", "T46", { op: "note", text: "x" }, "SHAWN")).code).toBe("not_found");
  });

  test("任务 id 像旗标也只当位置参数", async () => {
    expect((await write("owner", "--help", { op: "note", text: "x" })).code).toBe("not_found");
  });

  test("审查方记审查结论（任务在 review），不带阶段跳转；不是给它的卡 not_found", async () => {
    expect((await write("owner", "T36", { op: "review", verdict: "pass", p0: 0, p1: 0, p2: 1 })).code).toBe("invalid"); // 还在 spec
    toStage("T36", "review");
    const r = await write("owner", "T36", { op: "review", verdict: "changes", p0: 0, p1: 2, p2: 1, text: "见 PR", dedup: "r1" });
    expect(r).toMatchObject({ ok: true, task: { stage: "review" } });
    expect(r.event.data).toMatchObject({ reviewer: "peer:Shawn", verdict: "changes" });
    expect((await write("owner", "T36", { op: "review", verdict: "changes", p0: 0, p1: 2, p2: 1, dedup: "r1" })).duplicate).toBe(true);
    expect((await write("owner", "T1", { op: "note", text: "x" })).code).toBe("not_found");
  });
});
