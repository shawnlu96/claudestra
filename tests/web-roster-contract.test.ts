import { expect, test } from "bun:test";
import type { Roster as BridgeRoster } from "../src/lib/team-roster";
import type { RosterWire } from "@/features/collab/team/roster-types";
import { rosterFixture } from "@/features/collab/team/roster-fixture";
import { parseRosterWire } from "@/features/collab/team/roster-model";

// Both declarations must remain assignable; casts would defeat the compile-time contract.
const toBrowser = (v: BridgeRoster): RosterWire => v;
const toBridge = (v: RosterWire): BridgeRoster => v;
test("ROSTER1 real wire survives parsing without losing machines or worker/card/output facts", () => {
  const bridge = toBridge(rosterFixture());
  const parsed = parseRosterWire(toBrowser(bridge));
  expect(parsed?.machines.length).toBe(bridge.machines.length);
  expect(parsed?.dropped).toBe(0);
  expect(parsed?.machines[0]?.workers[0]?.taskId).toBe("i28-A6");
  expect(parsed?.machines[0]?.output.at(-1)?.reviewed).toBe(1);
});
