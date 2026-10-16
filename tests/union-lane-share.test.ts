/** merge-arch-UNIONLANE1 · 有序并集登记文件（registry-order.ts ORDERED_UNION_FILES）不占车道、不拿也不等文件锁；unionLaneShare off 时逐字照旧 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLanes, type LaneNode } from "../src/lib/dag-tools-lanes.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import type { TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { isOrderedUnionFile } from "../src/lib/registry-order.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { blockingLock, drainUnionLaneShareObserved, resetUnionLaneShareObserved, sharedOut, unionLaneShareOn, unionLaneSharePending } from "../src/lib/union-lane-share.js";

afterEach(() => resetUnionLaneShareObserved());

const KEYS = "src/lib/recovery-keys.ts";
const n = (key: string, fileGlobs: string[], over: Partial<LaneNode> = {}): LaneNode =>
  ({ key, deps: [], fileGlobs, taskId: null, phase: "idle", depsMet: true, satisfied: false, ...over });

describe("车道：只在有序并集文件上重叠不算重叠", () => {
  test("[验收线 1] 两个节点只在 recovery-keys.ts 上重叠：on 都能开工，off 第二个等 files", () => {
    const nodes = [n("a", ["src/lib/a.ts", KEYS]), n("b", ["src/lib/b.ts", KEYS])];
    const on = computeLanes(nodes, [], true);
    expect(on.startNow).toEqual(["a", "b"]);
    expect(on.waiting).toEqual([]);
    expect(on.lanes).toEqual([["a"], ["b"]]);
    const off = computeLanes(nodes, [], false);
    expect(off.startNow).toEqual(["a"]);
    expect(off.waiting).toEqual([{ key: "b", why: "files", on: ["a"] }]);
    expect(computeLanes(nodes)).toEqual(off);
  });

  test("[验收线 1] 在做的卡 / 图外忙卡只因 recovery-keys.ts 重叠也不挡（on）；只写了这一个文件的节点不算 no_globs", () => {
    const nodes = [n("x", [KEYS], { taskId: "T1", phase: "active", held: [KEYS] }), n("y", [KEYS]), n("z", ["src/b.ts", KEYS])];
    const busy = [{ taskId: "T9", fileGlobs: [KEYS, "src/c.ts"] }];
    expect(computeLanes(nodes, busy, true)).toMatchObject({ startNow: ["y", "z"], waiting: [] });
    expect(computeLanes(nodes, busy, false).waiting).toEqual([{ key: "y", why: "files", on: ["x", "T9"] }, { key: "z", why: "files", on: ["x", "T9"] }]);
  });

  test("[验收线 2] 除了 recovery-keys.ts 还有普通文件重叠：on 和 off 都等，等的是那张", () => {
    const nodes = [n("a", ["src/lib/a.ts", KEYS]), n("b", ["src/lib/a.ts", KEYS])];
    for (const share of [true, false]) {
      const r = computeLanes(nodes, [], share);
      expect(r.startNow).toEqual(["a"]);
      expect(r.waiting).toEqual([{ key: "b", why: "files", on: ["a"] }]);
      expect(r.lanes).toEqual([["a", "b"]]);
    }
  });
});

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "B", family: "claude", source: "local" };
const task: LedgerTask = {
  id: "B", project: "p", itemId: null, title: "B", kind: "code", stage: "spec", stageBefore: null, round: 0,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/B", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
};
const workflow: TaskWorkflow = { taskId: "B", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const snapshot = (fileGlobs: string[], held: string[], share?: boolean): PlannerSnapshot => ({
  task, workflow, events: [{ seq: 1, kind: "task", data: { op: "new" }, ts: 1, actor: author.agent, project: "p", target: "B", text: "", dedupKey: null }],
  intents: [], blockedBy: [], queueFrozen: false, fileGlobs, heldResources: held.map((resource) => ({ taskId: "A", resource })),
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, ...(share === undefined ? {} : { unionLaneShare: share }),
});

describe("文件锁：不为有序并集文件拿锁，也不被别人对它的锁挡住", () => {
  test("[验收线 3] A 拿着 recovery-keys.ts：on 时 B 照常派单且不拿它的锁；off 时 resource_busy", () => {
    const on = planScheduler(snapshot(["src/lib/b.ts", KEYS], [KEYS, "src/lib/a.ts"], true));
    expect(on).toMatchObject({ kind: "intent", action: "dispatch" });
    if (on.kind === "intent") expect(on.resources.filter((r) => !r.startsWith("task:"))).toEqual(["slot:p:0", "src/lib/b.ts"]);
    const off = planScheduler(snapshot(["src/lib/b.ts", KEYS], [KEYS, "src/lib/a.ts"], false));
    expect(off).toMatchObject({ kind: "wait", code: "resource_busy" });
    expect(off.kind === "wait" && off.reason).toContain(KEYS);
    const offRun = planScheduler(snapshot(["src/lib/b.ts", KEYS], [], false));
    if (offRun.kind === "intent") expect(offRun.resources).toContain(KEYS);
    else throw new Error(`off 时应派单：${JSON.stringify(offRun)}`);
  });

  test("[验收线 3] B 与 A 还有别的文件重叠：on 也照旧 resource_busy", () => {
    const r = planScheduler(snapshot(["src/lib/a.ts", KEYS], [KEYS, "src/lib/a.ts"], true));
    expect(r).toMatchObject({ kind: "wait", code: "resource_busy" });
    expect(r.kind === "wait" && r.reason).toContain("src/lib/a.ts");
  });

  test("快照没给开关时按恢复策略读：没配就是默认 on", () => {
    expect(defaultRecoveryMode("unionLaneShare")).toBe("on");
    const dir = mkdtempSync(join(tmpdir(), "unionlane-"));
    const path = join(dir, "recovery-policy.json");
    expect(unionLaneShareOn("p", join(dir, "missing.json"))).toBe(true);
    writeFileSync(path, JSON.stringify({ projects: { p: { keys: { unionLaneShare: "off" } } } }));
    expect(unionLaneShareOn("p", path)).toBe(false);
    expect(unionLaneShareOn("q", path)).toBe(true);
    writeFileSync(path, JSON.stringify({ projects: { p: { keys: { unionLaneShare: "observe" } } } }));
    expect(unionLaneShareOn("p", path)).toBe(false);
  });
});

describe("observe：照旧等锁，只记一条「本会不等」样本", () => {
  const same = (r: string, h: { resource: string }) => r === h.resource;
  const card = { id: "B", project: "p" };
  test("只被并集文件锁挡：observe 照旧挡并排一条样本（去重），on 不挡，off 不记", async () => {
    const held = [{ taskId: "A", resource: KEYS }];
    expect(blockingLock(card, held, ["src/b.ts", KEYS], same, "on")).toBeNull();
    expect(blockingLock(card, held, ["src/b.ts", KEYS], same, "off")).toEqual({ resource: KEYS, held: held[0]! });
    expect(unionLaneSharePending()).toEqual([]);
    for (let i = 0; i < 2; i++) expect(blockingLock(card, held, ["src/b.ts", KEYS], same, "observe")).toEqual({ resource: KEYS, held: held[0]! });
    expect(unionLaneSharePending()).toMatchObject([{ project: "p", mechanism: "unionLaneShare", target: "B", data: { heldBy: "A", resource: KEYS } }]);
    const got: unknown[] = [];
    expect(await drainUnionLaneShareObserved((a) => { got.push(a); })).toBe(1);
    expect(got.length).toBe(1);
    expect(unionLaneSharePending()).toEqual([]);
  });
  test("还有普通文件锁挡着：observe 不记样本", () => {
    const held = [{ taskId: "A", resource: KEYS }, { taskId: "A", resource: "src/b.ts" }];
    expect(blockingLock(card, held, ["src/b.ts", KEYS], same, "observe")?.resource).toBe("src/b.ts");
    expect(unionLaneSharePending()).toEqual([]);
  });
});

describe("isOrderedUnionFile", () => {
  test("[验收线 4] 只认 ORDERED_UNION_FILES 的路径，按 resourceKey 规范化；原型键不命中", () => {
    expect(isOrderedUnionFile(KEYS)).toBe(true);
    expect(isOrderedUnionFile("SRC/Lib/Recovery-Keys.TS")).toBe(true);
    for (const r of ["./src/lib/recovery-keys.ts", "src/lib/../lib/recovery-keys.ts", " src/lib/recovery-keys.ts", "src/lib/recovery-*.ts",
      "src/lib/*", "src/lib/recovery-keys.ts/x", "src/lib/registry-order.ts", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect([r, isOrderedUnionFile(r)]).toEqual([r, false]);
    }
    expect(sharedOut(["src/a.ts", "SRC/LIB/RECOVERY-KEYS.TS", "src/lib/*.ts"], true)).toEqual(["src/a.ts", "src/lib/*.ts"]);
    const same = ["src/a.ts", KEYS];
    expect(sharedOut(same, false)).toBe(same);
  });
});
