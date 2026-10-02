import { expect, test } from "bun:test";
import { parseAgents, agentsFlag } from "../src/lib/scheduler-agent-pool-config.js";
import { finishFirst } from "../src/lib/scheduler-agent-pool.js";
import { placeFor, type PlacementFacts, type PeerFacts } from "../src/lib/scheduler-placement.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";

const peer = (name: string, slots = { claude: 1, codex: 1 }, busy = { claude: 0, codex: 0 }): PeerFacts => ({
  peer: name, roles: [], priority: "off", open: 99,
  v2: { why: null, roles: [], repos: ["o/r"], slots, familyTotals: { claude: 5, codex: 5 }, familyBusy: busy },
});
const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: { mode: "balance", roles: [], poolTimeoutMin: 15, localPriority: "off", localFamilies: ["claude"],
    writeFamilies: ["codex"], reviewFirst: ["busy"], agents: { claude: 0, codex: 5 } },
  peers: [], local: { room: true, running: 0, pool: { totals: { claude: 0, codex: 5 }, running: { claude: 0, codex: 0 } } },
  repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});

test("zero local Claude means peer Claude or wait; never the local Codex family", () => {
  expect(placeFor(facts({ peers: [peer("mate")] }), "review", "claude")).toMatchObject({ kind: "peer", peer: "mate", family: "claude" });
  expect(placeFor(facts(), "review", "claude")).toEqual({ kind: "wait", reason: "等 claude 空位" });
});

test("roles/tiers/preferences do not restrict either write or review; family precedes machine load", () => {
  const f = facts({ peers: [peer("codex", { claude: 0, codex: 5 }), peer("claude", { claude: 1, codex: 0 }, { claude: 4, codex: 0 })] });
  for (const role of ["write", "review"] as const) expect(placeFor(f, role, "claude")).toMatchObject({ kind: "peer", peer: "claude", family: "claude" });
});

test("fewest running in selected family wins; ties peer first; lastPeer no longer wins ties", () => {
  const f = facts({ peers: [peer("busy", { claude: 0, codex: 1 }, { claude: 0, codex: 4 })] });
  expect(placeFor(f, "review", "codex")).toMatchObject({ kind: "local", family: "codex" });
  f.peers = [peer("a", { claude: 0, codex: 1 }), peer("b", { claude: 0, codex: 1 })]; f.lastPeer = "b";
  expect(placeFor(f, "review", "codex")).toMatchObject({ kind: "peer", peer: "a" });
});

test("all roles share a cap, off stays local only, and hard constraints still apply", () => {
  const f = facts(); f.local.pool!.running.codex = 5;
  for (const role of ["review", "write", "fix"] as const) expect(placeFor(f, role, "codex").kind).toBe("wait");
  f.peers = [peer("a")]; f.remote!.mode = "off";
  expect(placeFor(f, "review", "codex").kind).toBe("wait");
  f.remote!.mode = "balance"; f.peers[0]!.v2!.why = "授权到期";
  expect(placeFor(f, "review", "codex").kind).toBe("wait");
  f.peers[0]!.v2!.why = null; f.peers[0]!.v2!.repos = ["other/repo"];
  expect(placeFor(f, "review", "codex").kind).toBe("wait");
  f.peers = [peer("a")]; f.locksFree = false;
  expect(placeFor(f, "write", "codex")).toMatchObject({ kind: "wait", reason: "文件锁被别的卡占着" });
});

test("fix keeps family and write lease; writing falls back to Codex when Claude is full", () => {
  const f = facts({ peers: [peer("a", { claude: 0, codex: 1 })], writeLeasePeer: "a" });
  expect(placeFor(f, "fix", "claude")).toMatchObject({ kind: "wait", reason: expect.stringContaining("等 claude 空位") });
  expect(placeFor(f, "write", "claude")).toMatchObject({ kind: "peer", family: "codex" });
});

test("finish priority is stable across rotation, before new builds and specs", () => {
  expect(finishFirst(["build", "review", "spec", "fix", "merge"], (s) => s)).toEqual(["review", "fix", "merge", "build", "spec"]);
});

test("explicit agents replace maxActiveWorkers; omission retains old project policy", () => {
  const raw = { enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: "/repo", agents: { claude: 0, codex: 5 } } } };
  const p = parseSchedulerConfig(raw).projects.p!;
  expect(p.maxActiveWorkers).toBe(5); expect(p.remote!.agents).toEqual({ claude: 0, codex: 5 });
  delete (raw.projects.p as { agents?: unknown }).agents;
  expect(parseSchedulerConfig(raw).projects.p!.maxActiveWorkers).toBe(1);
  expect(parseSchedulerConfig(raw).projects.p!.remote!.agents).toBeUndefined();
  expect(agentsFlag("codex=5,claude=0")).toEqual({ agents: { claude: 0, codex: 5 } });
  for (const value of [{ claude: -1, codex: 5 }, { codex: 5 }, [], { claude: 1.5, codex: 0 }]) expect(() => parseAgents(value)).toThrow();
});
