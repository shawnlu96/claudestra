import { expect, test } from "bun:test";
import { readReborrowBinding, reborrowMarker } from "../src/lib/lend-reborrow-marker.js";
const binding = { orderId: "lend:REBOR:s1:r0:a1", gen: 2, reclaimSeq: 31 };
test("one fixed acceptance marker preserves the old journal binding", () => {
  expect(readReborrowBinding(["ordinary acceptance", reborrowMarker(binding)])).toEqual(binding);
  expect(readReborrowBinding(["ordinary acceptance"])).toBeNull();
});
test.each([
  ["[lend-reborrow]"], ["[lend-reborrow:v2 old=x]"], [reborrowMarker(binding), reborrowMarker(binding)],
  [reborrowMarker(binding).replace(" gen=2", "")], [reborrowMarker(binding).replace("gen=2", "gen=-1")],
  [reborrowMarker(binding).replace("reclaim=31", "reclaim=9007199254740992")], [reborrowMarker(binding).toUpperCase()],
  [`prefix ${reborrowMarker(binding)}`], [reborrowMarker(binding).slice(1)], [reborrowMarker(binding).slice(0, -1)],
].map((lines) => ({ lines })))("malformed reserved marker must not become an ordinary order: %j", ({ lines }) => {
  expect(() => readReborrowBinding(lines)).toThrow();
});
