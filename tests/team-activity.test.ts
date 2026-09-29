import { expect, test } from "bun:test";
import { ledgerInteractions, messageInteractions } from "../src/lib/team-activity";
import type { LedgerEvent } from "../src/lib/ledger-stages";
import { teamNodes, visibleInteractions, type Interaction } from "../web/features/collab/team-graph-model";

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
  expect(ledgerInteractions(events, names, now)).toEqual([]);
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
  expect(visibleInteractions([], nodes, now)).toEqual([]);
  const edge: Interaction = { id: "ledger:1", at: now, from: "local:pm", to: "local:writer", kind: "assign", task: "T55" };
  expect(visibleInteractions([edge, edge], nodes, now)).toHaveLength(1);
  expect(visibleInteractions([edge], nodes, now + 600_000)).toEqual([]);
  expect(visibleInteractions([{ ...edge, to: "local:missing" }], nodes, now)).toEqual([]);
});
