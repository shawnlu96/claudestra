import { expect, test } from "bun:test";
import { sharedLedgerEligibleProjects, sharedLedgerOfferBinding, sharedLedgerOfferProjectId, sharedLedgerProjectChoices } from "../src/lib/shared-ledger-local-project.js";

const projects = [
  { id: "old", name: "Older", lastActivityAt: 1 }, { id: "shared", name: "Same ID", lastActivityAt: 0 },
  { id: "new", name: "Newest", lastActivityAt: 20 }, { id: "recent", name: "Recent", lastActivityAt: 10 },
];
test("same-id match leads the three choices even when it is inactive", () => {
  expect(sharedLedgerProjectChoices(projects, "shared", "join", "join")).toEqual([
    { button: "join", localProjectId: "shared", name: "Same ID" },
    { button: "join_1", localProjectId: "new", name: "Newest" }, { button: "join_2", localProjectId: "recent", name: "Recent" },
  ]);
});
test("no same id: at most three projects ordered by conversation activity; unknown invite also requires a choice", () => {
  for (const shared of ["missing", undefined]) {
    expect(sharedLedgerProjectChoices(projects, shared, "join").map(c => c.localProjectId)).toEqual(["new", "recent", "old"]);
  }
});
test("unsafe project ids are not offered and activity ties have stable ordering", () => {
  const list = [{ id: "b", name: "B", lastActivityAt: 0 }, { id: "a", name: "A", lastActivityAt: 0 },
    { id: "../../escape", name: "Bad", lastActivityAt: 100 }];
  expect(sharedLedgerProjectChoices(list, undefined, "join").map(c => c.localProjectId)).toEqual(["a", "b"]);
});

test("shared project hint requires exactly one binding at the offered center", () => {
  const a = { centerId: "a", teamId: "team", projectId: "shared", localProjectId: "local" };
  expect(sharedLedgerOfferProjectId("a", [a])).toBe("shared");
  expect(sharedLedgerOfferProjectId("b", [a])).toBeUndefined();
  expect(sharedLedgerOfferProjectId("a", [a, { ...a, projectId: "other" }])).toBeUndefined();
  expect(sharedLedgerOfferProjectId("a", [a, { ...a, localProjectId: "duplicate" }])).toBeUndefined();
});


test("conflicting bound projects are excluded before the three-choice cap", () => {
  const list = ["busy", "a", "b", "c"].map((id, i) => ({ id, name: id, lastActivityAt: 100 - i }));
  const binding = { centerId: "center", teamId: "team", projectId: "shared", localProjectId: "busy" };
  const target = { centerId: "center", teamId: "team", projectId: "other" };
  expect(sharedLedgerProjectChoices(sharedLedgerEligibleProjects(list, [binding], target), undefined, "join")
    .map(c => c.localProjectId)).toEqual(["a", "b", "c"]);
  expect(sharedLedgerEligibleProjects(list, [binding], binding).map(p => p.id)).toContain("busy");
  expect(sharedLedgerEligibleProjects(list, [binding]).map(p => p.id)).not.toContain("busy");
  expect(sharedLedgerEligibleProjects(list, [binding], { ...binding, teamId: "other" }).map(p => p.id)).not.toContain("busy");
});

test("explicit shared project: only an exact center/team/project binding supplies the hint, never another project at that center", () => {
  const a = { centerId: "c", teamId: "team", projectId: "shared", localProjectId: "local" };
  const other = { ...a, projectId: "other", localProjectId: "elsewhere" };
  expect(sharedLedgerOfferProjectId("c", [other], { teamId: "team", projectId: "shared" })).toBeUndefined();
  expect(sharedLedgerOfferProjectId("c", [other], { projectId: "shared" })).toBeUndefined();
  expect(sharedLedgerOfferBinding("c", [a, other], { teamId: "team", projectId: "shared" })).toEqual(a);
  expect(sharedLedgerOfferProjectId("c", [a], { teamId: "team2", projectId: "shared" })).toBeUndefined();
  expect(sharedLedgerOfferProjectId("d", [a], { teamId: "team", projectId: "shared" })).toBeUndefined();
  // No team given and the same project id is bound under two teams: ambiguous, so unknown.
  expect(sharedLedgerOfferProjectId("c", [a, { ...a, teamId: "team2", localProjectId: "l2" }], { projectId: "shared" })).toBeUndefined();
  // Explicit project whose invitation team is unknown: even a unique same-center same-project binding is not borrowed.
  const teamOther = { ...a, teamId: "team-other" };
  expect(sharedLedgerOfferBinding("c", [teamOther], { projectId: "shared" })).toBeUndefined();
  expect(sharedLedgerOfferBinding("c", [a], { projectId: "shared" })).toBeUndefined();
  expect(sharedLedgerEligibleProjects([{ id: "local", name: "L", lastActivityAt: 0 }], [teamOther], undefined).map(p => p.id)).toEqual([]);
  // Legacy offer with no project metadata keeps the authorized single-binding inference.
  expect(sharedLedgerOfferBinding("c", [teamOther])).toEqual(teamOther);
  // Same-center other project never becomes a same-id choice.
  const list = [{ id: "other", name: "Other", lastActivityAt: 0 }, { id: "x", name: "X", lastActivityAt: 5 }];
  const hint = sharedLedgerOfferProjectId("c", [other], { teamId: "team", projectId: "shared" });
  expect(sharedLedgerProjectChoices(list, hint, "join", "join").map(c => c.button)).toEqual(["join_0", "join_1"]);
});
