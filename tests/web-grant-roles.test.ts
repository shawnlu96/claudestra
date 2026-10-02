import { describe, expect, test } from "bun:test";
import { formDefaults, grantBody, switchClaudeGrantPeer, type GrantView } from "../web/features/lend/lend-model";

const grant = (peer: string, roles: string[]): GrantView => ({
  peer, roles, repos: ["owner/repo"], families: { codex: 5, claude: 2 }, ordersPerDay: 200,
  until: null, grantedAt: null, paused: null, problem: null,
});
const review = grant("review-peer", ["review"]);
const write = grant("write-peer", ["review", "write"]);

describe("grant roles", () => {
  test("new grants default to review; enabling write adds both roles; toggling back omits roles", () => {
    const f = formDefaults(7, [{ name: "new-peer" }]);
    expect(!!f.write).toBe(false);
    expect(grantBody(f, 7)).not.toHaveProperty("roles");
    expect(grantBody({ ...f, write: true }, 7).roles).toEqual(["review", "write"]);
    expect(grantBody({ ...f, write: false }, 7)).not.toHaveProperty("roles");
  });

  test.each([review, write])("unchanged existing roles are omitted for $peer", (g) => {
    const f = formDefaults(7, [], g);
    expect(!!f.write).toBe(g.roles.includes("write"));
    expect(grantBody(f, 7, f)).not.toHaveProperty("roles");
    expect(grantBody({ ...f, claude: 3, repos: ["another/repo"] }, 7, f)).not.toHaveProperty("roles");
  });

  test("changing existing write sends review only; restoring write omits roles", () => {
    const initial = formDefaults(7, [], write);
    expect(grantBody({ ...initial, write: false }, 7, initial).roles).toEqual(["review"]);
    expect(grantBody({ ...initial, write: true }, 7, initial)).not.toHaveProperty("roles");
    const reviewOnly = formDefaults(7, [], review);
    expect(grantBody({ ...reviewOnly, write: true }, 7, reviewOnly).roles).toEqual(["review", "write"]);
  });

  test("closed write gate never sends roles, even if it closed after an edit", () => {
    for (const g of [review, write]) {
      const initial = formDefaults(7, [], g);
      for (const selected of [true, false]) {
        expect(grantBody({ ...initial, write: selected }, 7, initial, false)).not.toHaveProperty("roles");
      }
    }
    expect(grantBody({ ...formDefaults(7, []), write: true }, 7, undefined, false)).not.toHaveProperty("roles");
  });

  test("peer switching discards role edits and resets the comparison baseline alongside Claude slots", () => {
    const grants = [review, write];
    const initial = formDefaults(7, [], review);
    const first = switchClaudeGrantPeer(initial, write.peer, grants, 7);
    expect(first.form.write).toBe(true);
    expect(first.form.claude).toBe(2);
    expect(grantBody(first.form, 7, first.baseline)).not.toHaveProperty("roles");
    const second = switchClaudeGrantPeer({ ...first.form, write: false }, review.peer, grants, 7);
    expect(second.form.write).toBe(false);
    expect(grantBody({ ...second.form, write: true }, 7, second.baseline).roles).toEqual(["review", "write"]);
    const fresh = switchClaudeGrantPeer({ ...second.form, write: true }, "new-peer", grants, 7);
    expect(fresh.form.write).toBe(false);
    expect(fresh.form.claude).toBe(0);
    expect(fresh.baseline).toBeUndefined();
    expect(grantBody(fresh.form, 7, fresh.baseline)).not.toHaveProperty("roles");
  });

  test("roles compare by write membership, independent of server array order", () => {
    const initial = formDefaults(7, [], grant("peer", ["write", "review"]));
    expect(grantBody(initial, 7, initial)).not.toHaveProperty("roles");
    expect(grantBody({ ...initial, write: false }, 7, initial).roles).toEqual(["review"]);
  });
});
