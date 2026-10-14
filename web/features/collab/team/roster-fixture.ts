/** Synthetic roster only: deterministic codes and machine keys, never a copy of production people or configuration. */
import type { RosterMachine, RosterWire, RosterWorker } from "./roster-types";
const cards = () => ({ merge: [] as string[], live: [] as string[], blocked: [] as string[] });
export function rosterFixture(now = Date.now(), project = "roster-fixture"): RosterWire {
  const worker = (taskId: string, family: "claude" | "codex", state: RosterWorker["state"], role: RosterWorker["role"]): RosterWorker => ({
    id: `worker-${taskId}`, name: `worker-${taskId}`, family, role, taskId, step: role === "reviewer" ? "review" : "write", round: 1,
    since: now - 180_000, phase: "working", excerpt: null, beatAt: now - (state === "silent" ? 90_000 : 5_000), state,
  });
  const machine = (machineKey: string, instanceId: string, online: boolean): RosterMachine => ({
    machineKey, instanceId, online, checkedAt: now - 5_000, latencyMs: machineKey === "local" ? null : 28, helloAt: machineKey === "local" ? null : now - 5_000,
    proto: machineKey === "local" ? "local" : "push", why: null, grant: null, paused: null,
    slots: { claude: { total: 3, busy: 1, reportedBusy: machineKey === "local" ? null : 2, placeable: 1, held: false },
      codex: { total: 2, busy: 0, reportedBusy: null, placeable: 0, held: true } },
    quota: { claude: { usedPct: 42, resetAt: now + 86_400_000, stopPct: 90, observedAt: now }, codex: null },
    workers: [], cards: cards(), output: Array.from({ length: 7 }, (_, i) => ({
      day: new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10), delivered: i % 3 + 1, reviewed: i % 2 + 1,
    })),
  });
  const local = machine("local", "instance-local", true);
  local.workers = [worker("i28-A6", "claude", "running", "author"), worker("i28-A4", "claude", "silent", "reviewer"), worker("i28-A5", "codex", "running", "author")];
  local.slots.claude!.busy = 2; local.slots.codex!.busy = 1;
  local.cards.merge = ["i28-A3", "i28-B3"]; local.cards.blocked = ["i28-C3"];
  const peer = machine("peer-work", "instance-peer", true);
  const offline = machine("peer-offline", "instance-offline", false);
  offline.slots = { claude: null, codex: null }; offline.quota = { claude: null, codex: null }; offline.latencyMs = null;
  return { now, project, self: { instanceId: "instance-local" }, machines: [local, peer, offline], unattributed: cards() };
}
export function rosterSnapshotFixture(project: string, teamId: string, instanceId = "instance-local") {
  return { v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center", teamId, personId: "person-a", instanceId },
    teamRole: { available: true, value: "owner" }, team: { available: true, value: { name: "Fixture team", rev: 1 } },
    teamDirectory: { available: true, members: [
      { personId: "person-a", code: "Alpha", teamRole: "owner" }, { personId: "person-b", code: "Beta", teamRole: "member" },
      { personId: "person-c", code: "Gamma", teamRole: "member" },
    ] }, teamInstances: { available: true, instances: [{ instanceId: "instance-peer", personId: "person-b" }] },
    capabilities: { invite: { available: true }, leave: { available: true } },
    projects: [{ centerId: "center", teamId, projectId: project, name: "Fixture project", rev: 1, status: "active",
      projectRole: { available: true, value: "owner" }, localProjectIds: [project] }],
    localProjects: [{ id: project, name: "Fixture project", dirs: [], personal: false, eligible: false }], peers: [],
  };
}
