import { expect, test } from "bun:test";
import { ledgerInteractions, messageInteractions, teamRingTruncated } from "../src/lib/team-activity";
import { createTeamAnimationMemory, teamEdgeLane } from "../web/features/collab/team-animation";
import type { LedgerEvent } from "../src/lib/ledger-stages";
import { nodePositions, teamNodes, visibleInteractions, type Interaction } from "../web/features/collab/team-graph-model";

const names = new Set(["pm", "writer", "reviewer"]);
const now = 1_000_000;
const event = (patch: Partial<LedgerEvent>): LedgerEvent => ({ seq: 1, ts: now, project: "P", actor: "agent-pm", target: "T55",
  kind: "step", data: { op: "assign", executor: "agent-writer" }, text: "", dedupKey: null, ...patch });

test("only explicit recorded recipients get ledger edges", () => {
  const out = ledgerInteractions([event({}), event({ seq: 2, kind: "deliver", actor: "agent-writer", data: {} }),
    event({ seq: 3, kind: "review", actor: "agent-reviewer", data: {} })], names, now);
  expect(out[0]).toMatchObject({ from: "local:pm", to: "local:writer", task: "T55", kind: "assign" });
  expect(out.slice(1).every((e) => e.to === null)).toBe(true);
  expect(out.some((e) => e.to === "local:T55")).toBe(false);
});

test("old, future, approximate and instance-only actor records do not become agent edges", () => {
  const events = [event({ ts: now - 600_000 }), event({ ts: now + 1 }), event({ data: { approxTime: true } }), event({ actor: "peer:Shawn" })];
  expect(ledgerInteractions(events, names, now)).toMatchObject([{ from: "instance:Shawn", to: "local:writer" }]);
});

test("delivery ring uses structured local or owner identity, not API display names", () => {
  const msg = { seq: 1, ts: new Date(now).toISOString(), agent: "agent-writer", chatId: "local:x", type: "chat_message",
    data: { direction: "in", srcKind: "local", fromId: "agent", from: "agent-pm" } };
  expect(messageInteractions([msg], names, new Set(["writer"]), now)[0]).toMatchObject({ from: "local:pm", to: "local:writer" });
  expect(messageInteractions([{ ...msg, data: { ...msg.data, srcKind: "api" } }], names, new Set(["writer"]), now)).toEqual([]);
  expect(messageInteractions([msg], names, new Set(["other"]), now)).toEqual([]);
});

test("graph never synthesizes interactions; stable event IDs deduplicate and time window expires", () => {
  const nodes = teamNodes([{ name: "agent-pm" }, { name: "agent-writer" }], [], ["agent-pm"]);
  expect(nodes.find((n) => n.name === "pm")?.role).toBe("PM");
  expect(teamNodes([{ name: "__master__" }], [], [])[1]).toMatchObject({ id: "local:master", name: "master", role: "master" });
  expect(visibleInteractions([], nodes, now)).toEqual([]);
  const edge: Interaction = { id: "ledger:1", at: now, from: "local:pm", to: "local:writer", kind: "assign", task: "T55" };
  expect(visibleInteractions([edge, edge], nodes, now)).toHaveLength(1);
  expect(visibleInteractions([edge], nodes, now + 600_000)).toEqual([]);
  expect(visibleInteractions([{ ...edge, to: "local:missing" }], nodes, now)).toHaveLength(1);
});

test("dispatch categories never identify agents; review assignments provide real recipients", () => {
  const known = new Set([...names, "regular"]);
  const out = ledgerInteractions([
    event({ kind: "dispatch", data: { reviewer: "regular" } }),
    event({ seq: 2, data: { op: "assign", step: "review", executor: "agent-reviewer" } }),
    event({ seq: 3, actor: "peer:Shawn", data: { op: "assign", executor: "agent-hidden@Other" } }),
  ], known, now);
  expect(out[0]).toMatchObject({ kind: "dispatch", to: null });
  expect(out[1]).toMatchObject({ kind: "dispatch", to: "local:reviewer" });
  expect(out[2]).toMatchObject({ from: "instance:Shawn", to: "peer:Other/hidden" });
  expect(visibleInteractions(out, [], now)).toHaveLength(3);
});

test("same id across snapshot, null, snapshot and remount claims animation only once", () => {
  const claim = createTeamAnimationMemory(2, 2);
  const snapshots = [["e1"], null, ["e1", "e2"], ["e1"]];
  const flashes = snapshots.flatMap((ids) => (ids ?? []).filter((id) => claim("machine/project", id, now, now)));
  expect(flashes).toEqual(["e1", "e2"]);
  expect(claim("machine/project", "e3", now, now)).toBe(false);
  expect(claim("other/project", "e1", now, now)).toBe(true);
  expect(claim("third/project", "e1", now, now)).toBe(false);
  expect(["e2", "new", "e1"].map(teamEdgeLane).at(-1)).toBe(teamEdgeLane("e1"));
});

test("a full ring with a recent oldest event reports possible eviction even if entries are tools", () => {
  const events = Array.from({ length: 500 }, (_, seq) => ({ seq, ts: new Date(now - seq).toISOString(),
    agent: "agent-writer", chatId: "", type: "tool_start", data: {} }));
  expect(teamRingTruncated(events, new Set(["writer"]), now, 500)).toBe(true);
  expect(teamRingTruncated(events.slice(1), new Set(["writer"]), now, 500)).toBe(false);
  expect(teamRingTruncated(events, new Set(["other"]), now, 500)).toBe(false);
  expect(teamRingTruncated(events, new Set(["writer"]), now + 600_000, 500)).toBe(false);
});

test("embedded grid fits an 800px host without a 1038px minimum", () => {
  const nodes = teamNodes(Array.from({ length: 6 }, (_, i) => ({ name: `agent-${i}` })), [], []);
  for (const width of [390, 800, 1038]) {
    const positions = nodePositions(nodes, width);
    expect([...positions.values()].every((p) => p.x >= 0 && p.x + p.width <= width)).toBe(true);
  }
});
