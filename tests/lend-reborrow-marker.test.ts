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

// Real historical remote-convergence id shape (MQ1: lend:dispatch-recovery-MQ1:cv:35704, PM reclaim 36155).
const cv = { orderId: "lend:dispatch-recovery-MQ1:cv:35704", gen: 1, reclaimSeq: 36155 };
test("existing cv order ids round-trip; ordinary orders stay ordinary", () => {
  expect(reborrowMarker(cv)).toBe("[lend-reborrow:v1 old=lend:dispatch-recovery-MQ1:cv:35704 gen=1 reclaim=36155]");
  expect(readReborrowBinding(["ordinary", reborrowMarker(cv)])).toEqual(cv);
  expect(readReborrowBinding([reborrowMarker({ ...cv, gen: 0 })])).toEqual({ ...cv, gen: 0 });
});
const cvLine = (orderId: string) => `[lend-reborrow:v1 old=${orderId} gen=1 reclaim=36155]`;
test.each([
  "lend:dispatch-recovery-MQ1:cv:0", "lend:dispatch-recovery-MQ1:cv:035704", "lend:dispatch-recovery-MQ1:CV:35704",
  "LEND:dispatch-recovery-MQ1:cv:35704", "lend:dispatch-recovery-MQ1:cv:", "lend:dispatch-recovery-MQ1:cv:x1",
  "lend:dispatch-recovery-MQ1:cv:9007199254740992", "lend:dispatch-recovery-MQ1:cv:35704:s1", "lend:a:b:cv:1",
  "lend::cv:1", "lend:dispatch-recovery-MQ1", "lend:dispatch-recovery-MQ1:anything", "lend:dispatch-recovery-MQ1:cv:357\n04",
  "lend:dispatch recovery:cv:1", `lend:${"x".repeat(65)}:cv:1`, "evil:T:cv:1",
  "lend:dispatch-recovery-MQ1:cv:35704]", "lend:dispatch-recovery-MQ1:s1:r0",
].map((id) => ({ id })))("fake / truncated / case-variant old id is refused: $id", ({ id }) => {
  expect(() => readReborrowBinding([cvLine(id)])).toThrow();
  expect(() => reborrowMarker({ ...cv, orderId: id })).toThrow();
});
test.each([
  [cvLine(cv.orderId), cvLine(cv.orderId)], [cvLine(cv.orderId).replace(" gen=1", "")], [cvLine(cv.orderId).replace(" reclaim=36155", "")],
  [cvLine(cv.orderId).replace("gen=1", "gen=9007199254740992")], [`${cvLine(cv.orderId)}\n`], [cvLine(cv.orderId).toUpperCase()],
].map((lines) => ({ lines })))("malformed cv marker never falls back to ordinary: %j", ({ lines }) => {
  expect(() => readReborrowBinding(lines)).toThrow();
});

// CVREBOR1: CONV-ended sources use a separate strict v2 shape; v1 keeps meaning "PM reclaim" only.
const conv = { orderId: "lend:CVREBOR1:s1:r4:a0", gen: 1, reclaimSeq: 4242, conv: { from: "codex" as const, to: "claude" as const } };
const v2 = "[lend-reborrow:v2 src=conv old=lend:CVREBOR1:s1:r4:a0 gen=1 end=4242 from=codex to=claude]";
test("CONV binding renders only the strict v2 marker and round-trips with both families", () => {
  expect(reborrowMarker(conv)).toBe(v2);
  expect(readReborrowBinding(["ordinary", v2])).toEqual(conv);
  expect(readReborrowBinding([reborrowMarker({ orderId: conv.orderId, gen: 1, reclaimSeq: 4242 })])).toEqual({ orderId: conv.orderId, gen: 1, reclaimSeq: 4242 });
});
test.each([
  [v2, v2], [v2, reborrowMarker(binding)], [v2.replace("v2", "v3")], [v2.replace("v2", "v1")], [v2.replace(" src=conv", "")],
  [v2.replace("src=conv", "src=pm")], [v2.replace("end=4242", "reclaim=4242")], [v2.replace("end=4242", "end=04242")],
  [v2.replace("end=4242", "end=0")], [v2.replace("gen=1", "gen=01")], [v2.replace("to=claude", "to=codex")],
  [v2.replace("to=claude", "to=gemini")], [v2.replace(" from=codex", "")], [v2.replace("]", " extra=1]")],
  [v2.replace("end=4242", "end=9007199254740992")], [v2.toUpperCase()], [`${v2} `], [v2.replace("old=lend:CVREBOR1:s1:r4:a0", "old=lend:CVREBOR1:x")],
].map((lines) => ({ lines })))("malformed / duplicated / wrong-version CONV marker never becomes an ordinary order: %j", ({ lines }) => {
  expect(() => readReborrowBinding(lines)).toThrow();
});
test("rendering refuses a CONV binding that would not round-trip", () => {
  expect(() => reborrowMarker({ ...conv, conv: { from: "codex", to: "codex" } })).toThrow();
  expect(() => reborrowMarker({ ...conv, reclaimSeq: 0 })).toThrow();
});
