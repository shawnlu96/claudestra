import { describe, expect, test } from "bun:test";
import { parseRemotePolicy, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { allowLegacyReview, peerFamily, placeFor, type PeerFacts, type PlacementFacts } from "../src/lib/scheduler-family-pick.js";

const policy: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15, localPriority: "off" };
const peer = (name: string, claude: number, codex: number, priority: PeerFacts["priority"] = "balance"): PeerFacts => ({
  peer: name, priority, open: 0, roles: ["write", "review"],
  v2: { why: null, roles: ["write", "review"], repos: ["o/r"], slots: { claude, codex } },
});
const facts = (peers: PeerFacts[], remote = policy): PlacementFacts => ({
  peers, remote, repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
});

describe("writeFamilies configuration", () => {
  test("omission keeps the old shape and defaults writing to Codex", () => {
    const parsed = parseRemotePolicy(policy);
    expect(parsed).not.toHaveProperty("writeFamilies");
    expect(placeFor(facts([peer("both", 2, 2)], parsed), "write", "claude")).toMatchObject({ family: "codex" });
    expect(placeFor(facts([peer("claude-only", 2, 0)], parsed), "write", "claude")).toMatchObject({ kind: "wait" });
  });
  test("ordered preferences survive parsing without aliasing input", () => {
    const writeFamilies = ["claude", "codex"];
    const parsed = parseRemotePolicy({ ...policy, writeFamilies });
    writeFamilies.reverse();
    expect(parsed.writeFamilies).toEqual(["claude", "codex"]);
  });
  test.each([[], ["claude", "claude"], ["gemini"], "claude", null, [1], ["codex", "claude", "codex"]].map((raw) => [raw]))("invalid %j", (raw) => {
    expect(() => parseRemotePolicy({ ...policy, writeFamilies: raw })).toThrow("writeFamilies");
  });
});

describe("available family under the existing placement rules", () => {
  const preferClaude: RemotePolicy = { ...policy, writeFamilies: ["claude", "codex"] };
  test("legacy lenders offer only Codex review; Claude review requires hello capacity", () => {
    expect(allowLegacyReview("codex")).toBe(true);
    expect(allowLegacyReview("claude")).toBe(false);
  });
  test.each([[2, 2, "claude"], [0, 2, "codex"], [2, 0, "claude"]] as const)("Claude %d / Codex %d → %s", (claude, codex, family) => {
    const p = peer("writer", claude, codex);
    const f = facts([p], preferClaude), original = JSON.stringify(f);
    expect(placeFor(f, "write", "codex")).toMatchObject({ kind: "peer", peer: "writer", family });
    expect(peerFamily(p, "write", "codex", preferClaude.writeFamilies)).toBe(family);
    expect(JSON.stringify(f)).toBe(original);
  });
  test("same-tier family preference precedes borrow order and load ranking", () => {
    const p = [peer("codex-first", 0, 1), peer("claude-second", 1, 0)];
    expect(placeFor(facts(p, preferClaude), "write", "codex"))
      .toMatchObject({ kind: "peer", peer: "claude-second", family: "claude" });
    p[1].open = 2;
    expect(placeFor(facts(p, preferClaude), "write", "codex"))
      .toMatchObject({ kind: "peer", peer: "claude-second", family: "claude" });
  });
  test("tier wins before family preference; full first tier falls back to balance", () => {
    const p = [peer("first", 0, 1, "first"), peer("balance", 1, 1)];
    expect(placeFor(facts(p, preferClaude), "write", "claude")).toMatchObject({ peer: "first", family: "codex" });
    p[0] = peer("first", 0, 0, "first");
    expect(placeFor(facts(p, preferClaude), "write", "claude")).toMatchObject({ peer: "balance", family: "claude" });
  });
  test("only configured families qualify, even on a pin", () => {
    const f = facts([peer("writer", 0, 3)], { ...policy, writeFamilies: ["claude"] });
    expect(placeFor({ ...f, pin: "peer:writer" }, "write", "claude")).toMatchObject({ kind: "wait" });
  });
  test("load ranking, grants and locks still apply", () => {
    const loaded = { ...peer("loaded", 1, 1), open: 2 };
    const f = facts([loaded, peer("idle", 1, 1)], preferClaude);
    expect(placeFor(f, "write", "claude")).toMatchObject({ peer: "idle" });
    expect(placeFor({ ...f, locksFree: false }, "write", "claude")).toMatchObject({ kind: "wait" });
    expect(placeFor({ ...f, repo: "ungranted/repo" }, "write", "claude")).toMatchObject({ kind: "wait" });
  });
  test.each(["claude", "codex"] as const)("%s fix stays with lease owner and original family", (author) => {
    const f = { ...facts([peer("lease", 1, 1, "low"), peer("other", 9, 9, "first")], preferClaude), writeLeasePeer: "lease" };
    expect(placeFor(f, "fix", author)).toMatchObject({ peer: "lease", family: author });
    f.peers[0].v2!.slots = { claude: author === "claude" ? 0 : 1, codex: author === "codex" ? 0 : 1 };
    expect(placeFor(f, "fix", author)).toMatchObject({ kind: "wait" });
    expect(peerFamily(f.peers[0], "fix", author, preferClaude.writeFamilies)).toBeNull();
  });
  test("review requires precisely the requested cross-family slot", () => {
    const f = facts([peer("codex", 0, 2), peer("claude", 1, 0)], { ...preferClaude, reviewFirst: ["codex"] });
    expect(placeFor(f, "review", "claude")).toMatchObject({ peer: "claude", family: "claude" });
    expect(placeFor(f, "review", "codex")).toMatchObject({ peer: "codex", family: "codex" });
    expect(placeFor(facts([peer("full", 0, 0)]), "review", "claude")).toMatchObject({ kind: "wait" });
  });
});
