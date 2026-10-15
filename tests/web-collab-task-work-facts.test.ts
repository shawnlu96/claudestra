/**
 * followup-reliability-UXCARD3 [验收线 5]：按卡号查「谁在干活」快照（work/task-work-facts.ts）。
 * 本机板各栏和老卡、团队板的本机行 / 团队行 / 老卡都查得到；出借三种判定各一例；主场本机卡只有团队行时返回 null；快照没到返回 undefined。
 */
import { expect, test } from "bun:test";
import { lendOf, taskWorkFacts, workFactsOf } from "@/features/collab/work/task-work-facts";
import type { TeamWorkBoard, TeamWorkRow, WorkBoard, WorkRow } from "@/features/collab/work/work-types";

const NOW = 1_800_000_000_000, MIN = 60_000;
const LOCAL = "a1b2c3d4e5f60718293a4b5c", PEER = "0f1e2d3c4b5a69788796a5b4";
const row = (id: string, p: Partial<WorkRow> = {}): WorkRow => ({ taskId: id, featureId: "f", nodeKey: id, title: id, who: `agent-${id.toLowerCase()}`,
  machine: "local", step: "write", round: 1, since: NOW - 20 * MIN, normalMinutes: 60, remainingMinutes: 40, overMinutes: 0, reason: null, code: null, estimate: "", ...p });
const local: WorkBoard = { now: NOW, asOfSeq: 1, machines: {}, completionHours: null, availableSlots: 1,
  working: [row("W1", { step: "fix", round: 3 }), row("M1", { step: "merge" }), row("P1", { who: "peer:alice · codex", machine: "alice" })],
  waiting: [row("Q1", { step: "review", reason: "合并排队：前面是 X", code: "merge_queue" }),
    row("H1", { step: "fix", reason: "退回人工（manual）：缺凭据", code: "manual", since: NOW - 90 * MIN })],
  todo: { ready: [], blocked: [] }, legacy: [{ taskId: "T13f", title: "老卡", stage: "review" }], legacyTotal: 1 };

test("[验收线 5] 本机板：在干活 / 在等合并（合并步骤、合并排队）/ 在等 / 老卡各查得到；没有这张卡为 null；快照没到为 undefined", () => {
  expect(taskWorkFacts(local, false, "W1")).toMatchObject({ column: "working", who: "agent-w1", lent: false, step: "fix", round: 3, since: NOW - 20 * MIN });
  expect(taskWorkFacts(local, false, "M1")).toMatchObject({ column: "merging", reason: "正在合并" });
  expect(taskWorkFacts(local, false, "Q1")).toMatchObject({ column: "merging", code: "merge_queue" });
  expect(taskWorkFacts(local, false, "H1")).toMatchObject({ column: "waiting", code: "manual", reason: "退回人工（manual）：缺凭据", since: NOW - 90 * MIN });
  expect(taskWorkFacts(local, false, "T13f")).toMatchObject({ column: "legacy", stage: "review", since: null, round: null, who: null });
  expect(taskWorkFacts(local, false, "NOPE")).toBeNull();
  expect(taskWorkFacts(null, false, "W1")).toBeUndefined();
  expect(workFactsOf({ kind: "local", board: local }, "p")("W1")?.column).toBe("working");
  expect(workFactsOf({ kind: "local", board: null }, "p")("W1")).toBeUndefined();
});

test("[验收线 5] 出借三种判定：peer: 开头（机器、家族）；本机行机器不是本机；执行者名带 @<机器>", () => {
  expect(taskWorkFacts(local, false, "P1")).toMatchObject({ lent: true, machine: "alice", family: "codex" });
  expect(lendOf("peer:bob", "local", true)).toEqual({ lent: true, machine: "bob", family: null });
  expect(lendOf("agent-dev", "bob-mac", true)).toEqual({ lent: true, machine: "bob-mac", family: null });
  expect(lendOf("dev@carol-mac", "local", true)).toEqual({ lent: true, machine: "carol-mac", family: null });
  expect(lendOf("agent-dev", "local", true).lent).toBe(false);
  expect(lendOf("agent-dev", "本机", true).lent).toBe(false);
  // 团队行的机器是成员机器（不是出借），不按机器判
  expect(lendOf("peer-dev", "alice-mac", false).lent).toBe(false);
});

const trow = (id: string, p: Partial<TeamWorkRow> = {}): TeamWorkRow => ({ taskId: id, featureId: "f", nodeKey: id, title: id, who: "peer-dev",
  instance: PEER, machine: "alice-mac", stage: "build", reason: null, team: null, ...p });
const team: TeamWorkBoard = { now: NOW, machines: {}, mirror: [], todo: { ready: [], blocked: [] },
  working: [row("L1", { machine: "本机" }), trow("A1"), trow("H2", { instance: LOCAL, machine: "本机" })],
  merging: [trow("A2", { stage: "merge", reason: "等合并" })], waiting: [],
  legacy: [{ taskId: "T13f", title: "老卡", stage: "review" }] };

test("[验收线 5] 团队板：本机行、团队行（步骤按阶段）、老卡都查得到；主场本机卡只有团队行时返回 null", () => {
  expect(taskWorkFacts(team, true, "L1", LOCAL)).toMatchObject({ column: "working", lent: false, step: "write", round: 1 });
  expect(taskWorkFacts(team, true, "A1", LOCAL)).toMatchObject({ column: "working", who: "peer-dev", lent: false, step: "write", round: null, since: null });
  expect(taskWorkFacts(team, true, "A2", LOCAL)).toMatchObject({ column: "merging", reason: "等合并", step: "merge" });
  expect(taskWorkFacts(team, true, "T13f", LOCAL)).toMatchObject({ column: "legacy", stage: "review" });
  expect(taskWorkFacts(team, true, "H2", LOCAL)).toBeNull();
  expect(taskWorkFacts(team, true, "H2", null)?.column).toBe("working");
});
