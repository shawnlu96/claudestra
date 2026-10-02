import { reviewPlacement } from "../src/lib/scheduler-placement-plan.js";
import type { PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { expect, test } from "bun:test";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { placeFor, type PlacementFacts, type PeerFacts } from "../src/lib/scheduler-placement.js";
import { placeFor as familyPlaceFor } from "../src/lib/scheduler-family-pick.js";

const policy = (families: unknown = ["codex"], runtime = "codex") => parseSchedulerConfig({ enabled: true, projects: {
  a: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", localAuthorRuntime: runtime,
    remote: { mode: "balance", roles: ["write", "review"], repo: "o/r", localPriority: "balance",
      ...(families === undefined ? {} : { localFamilies: families }) } },
} }).projects.a.remote!;
const peer = (claude = 0, codex = 0): PeerFacts => ({ peer: "p", open: 0, roles: ["write", "review"],
  v2: { why: null, slots: { claude, codex }, roles: ["write", "review"], repos: ["o/r"] } });
const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({ remote: policy(), peers: [peer()], repo: "o/r",
  local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true, ...over });

test("Codex local writer is eligible with full peers; its cross-family review waits with the refusal", () => {
  for (const pick of [placeFor, familyPlaceFor]) {
    expect(pick(facts(), "write", "claude").kind).toBe("local");
    expect(pick(facts(), "review", "claude")).toEqual({ kind: "wait", reason: "本机不接 claude，又没有能接的 peer：等" });
    expect(pick(facts({ local: { running: 3, room: false } }), "review", "claude").kind).toBe("wait");
    expect(pick(facts({ peers: [peer(1)] }), "review", "claude")).toMatchObject({ kind: "peer", peer: "p", family: "claude" });
  }
});

test("writer admission follows configured local runtime, not the card or peer family; default writer is Claude", () => {
  expect(placeFor(facts({ remote: policy(["codex"], "claude") }), "write", "codex")).toMatchObject({ kind: "wait" });
  expect(placeFor(facts({ remote: { ...policy(), localAuthorRuntime: undefined } }), "fix", "codex")).toMatchObject({ kind: "wait" });
  expect(placeFor(facts({ remote: policy(["claude"], "codex"), peers: [peer(1)] }), "write", "claude")).toMatchObject({ kind: "peer" });
});

test("omitted families preserve placement fixtures byte-for-byte, including priorities, pins, leases, and reviewFirst", () => {
  const unrestricted = policy(["codex", "claude"]);
  const legacy = { ...unrestricted };
  delete legacy.localFamilies;
  delete legacy.localAuthorRuntime;
  const fixtures: Partial<PlacementFacts>[] = [
    {}, { peers: [] }, { peers: [peer(2, 2)] }, { local: { running: 9, room: false } },
    { pin: "peer:p" }, { tried: ["p"] }, { writeLeasePeer: "p" }, { locksFree: false },
    { lastPeer: "p", peers: [peer(2, 2)] },
  ];
  for (const priority of ["first", "balance", "low", "off"] as const) {
    for (const mode of ["off", "balance"] as const) {
      for (const over of fixtures) for (const role of ["write", "fix", "review"] as const) for (const family of ["codex", "claude"] as const) {
        const f = facts({ ...over, remote: { ...legacy, mode, localPriority: priority, reviewFirst: ["p"] } });
        expect(placeFor(f, role, family)).toEqual(placeFor({ ...f, remote: { ...f.remote!, localFamilies: ["codex", "claude"],
          localAuthorRuntime: "codex" } }, role, family));
      }
    }
  }
});


test("planner consumes the parsed family policy instead of creating a local Claude reviewer", () => {
  const f = facts();
  const snapshot = {
    task: { id: "T1", headSHA: "a".repeat(40), extra: {} }, workflow: { template: "code", authorFamily: "codex" },
    reviewer: null, author: null, heldResources: [], fileGlobs: [], workerCount: 0, maxWorkers: 2,
    freeWorkerSlot: "slot:a:0", intents: [],
    pool: { remote: f.remote, repo: "o/r", localReviewers: 0, localWriters: 0, lastPeer: null,
      writeLeasePeer: null, peers: f.peers.map((p) => ({ ...p, maxOpen: 2 })) },
  } as unknown as PlannerSnapshot;
  expect(reviewPlacement(snapshot, 0)).toEqual({ wait: "本机不接 claude，又没有能接的 peer：等" });
  snapshot.pool!.peers = [{ ...peer(1), maxOpen: 2 }];
  expect(reviewPlacement(snapshot, 0)).toMatchObject({ peer: "p" });
});
