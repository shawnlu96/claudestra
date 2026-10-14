/** team-roster-ROSTER3：名册纯模型（解析 / 归人 / 位子格 / 额度 / 就绪没派 / 指标）。 */
import { expect, test } from "bun:test";
import {
  DISPATCH_WAIT, parseRosterWire, quotaState, readyQueue, rosterMetrics, rosterOf, slotCells, type RosterInput,
} from "@/features/collab/team/roster-model";
import type { Roster, RosterMachine, RosterWorker } from "@/features/collab/team/roster-types";
import type { WorkBoard, WorkRow } from "@/features/collab/work/work-types";
import type { TeamDirectoryMember } from "@/lib/shared-projects-model";

const NOW = 1_800_000_000_000;
const worker = (id: string, state: RosterWorker["state"], extra: Partial<RosterWorker> = {}): RosterWorker =>
  ({ id, name: `w-${id}`, family: "claude", role: "author", state, taskId: null, step: "write", round: 0, since: NOW - 1000, phase: null, excerpt: null, beatAt: NOW, ...extra });
const machine = (key: string, instanceId: string | null, extra: Partial<RosterMachine> = {}): RosterMachine => ({
  machineKey: key, instanceId, online: true, checkedAt: NOW, latencyMs: null, helloAt: null,
  proto: key === "local" ? "local" : "push", why: null, grant: null, paused: null,
  slots: { claude: { total: 2, busy: 0, reportedBusy: null, placeable: 2, held: false }, codex: null },
  quota: { claude: null, codex: null }, workers: [], cards: { merge: [], live: [], blocked: [] }, output: [], ...extra,
});
const roster = (machines: RosterMachine[], extra: Partial<Roster> = {}): Roster =>
  ({ now: NOW, project: "fixture", self: { instanceId: "inst-self" }, machines, unattributed: { merge: [], live: [], blocked: [] }, dropped: 0, ...extra });
const directory: TeamDirectoryMember[] = [
  { personId: "p-self", code: "me", teamRole: "owner" },
  { personId: "p-a", code: "alice", teamRole: "member" },
  { personId: "p-b", code: "bob", teamRole: "member" },
];
const input = (r: Roster | null, extra: Partial<RosterInput> = {}): RosterInput => ({
  roster: r, directory, selfPersonId: "p-self", instances: [{ instanceId: "inst-x", personId: "p-a" }], tasks: [], now: NOW, ...extra,
});
const three = () => roster([machine("local", "inst-self"), machine("peer-x", "inst-x"), machine("peer-y", "inst-y")]);
const person = (v: ReturnType<typeof rosterOf>, id: string) => v.people.find(p => p.personId === id)!;

test("[验收线 1] 归人：本机归 self，peer 只经 instances 归人，找不到进 unclaimed，没机器的人照样有卡", () => {
  const v = rosterOf(input(three()));
  expect(person(v, "p-self").machines.map(m => m.key)).toEqual(["local"]);
  expect(person(v, "p-a").machines.map(m => m.key)).toEqual(["peer:peer-x"]);
  expect(v.unclaimed.map(m => m.key)).toEqual(["peer:peer-y"]);
  expect(person(v, "p-b").machines).toEqual([]);
  expect(person(v, "p-b").slotNote).toBe("roster.slot.noMachines");
  expect(person(v, "p-self").slotNote).toBeNull();
  expect(v.people.map(p => p.personId)).toEqual(["p-self", "p-a", "p-b"]);

  const none = rosterOf(input(three(), { instances: null }));
  expect(none.unclaimed.map(m => m.key)).toEqual(["peer:peer-x", "peer:peer-y"]);
  expect(person(none, "p-a").machines).toEqual([]);
  expect(person(none, "p-self").machines.map(m => m.key)).toEqual(["local"]);
});

test("[验收线 1] 不按名字猜人；directory 为 null 不建人，本机进 unclaimed 并标 isSelf", () => {
  const v = rosterOf(input(roster([machine("local", "inst-self"), machine("alice", "inst-z")]), { instances: null }));
  expect(v.unclaimed.map(m => m.key)).toEqual(["peer:alice"]);
  const noDir = rosterOf(input(three(), { directory: null }));
  expect(noDir.people).toEqual([]);
  expect(noDir.memberCount).toBeNull();
  expect(noDir.unclaimed.find(m => m.key === "local")!.isSelf).toBe(true);
  expect(noDir.unclaimed).toHaveLength(3);
});

test("[验收线 2] 同一 worker id 在两台机器 → 只出现一次（取后一台），conflicts 为 1", () => {
  const r = roster([machine("local", "inst-self", { workers: [worker("w1", "running")] }), machine("peer-x", "inst-x", { workers: [worker("w1", "running")] })]);
  const v = rosterOf(input(r));
  const all = [...v.people.flatMap(p => p.machines), ...v.unclaimed].flatMap(m => m.workers.map(w => w.id));
  expect(all).toEqual(["w1"]);
  expect(person(v, "p-a").machines[0]!.workers.map(w => w.id)).toEqual(["w1"]);
  expect(v.conflicts).toBe(1);
});

test("[验收线 2] 卡在同一人名下只出现一次；24 位十六进制代号不归人", () => {
  const r = roster([machine("local", "inst-self"), machine("peer-x", "inst-x", { cards: { merge: ["T1"], live: [], blocked: [] } })]);
  const hex = "0123456789abcdef01234567";
  const tasks = [
    { id: "T1", title: "卡一", stage: "build", assigneeCode: "alice", executorInstanceId: "inst-x" },
    { id: "T2", title: "卡二", stage: "review", assigneeCode: hex, executorInstanceId: null },
    { id: "T3", title: "卡三", stage: "build", assigneeCode: null, executorInstanceId: "inst-self" },
  ];
  const dir = [...directory, { personId: "p-hex", code: hex, teamRole: "member" as const }];
  const v = rosterOf(input(r, { tasks, directory: dir }));
  expect(person(v, "p-a").cards).toEqual([{ id: "T1", title: "卡一", stage: "build" }]);
  expect(v.people.flatMap(p => p.cards.map(c => c.id))).not.toContain("T2");
  expect(person(v, "p-self").cards.map(c => c.id)).toEqual(["T3"]);
});

const occupied = (total: number, held = false, workers = [worker("r", "running"), worker("s", "silent"), worker("n", "no_beat")]) =>
  machine("peer-x", "inst-x", { slots: { claude: { total, busy: 3, reportedBusy: 4, placeable: 0, held }, codex: null }, workers });

test("[验收线 3] 位子格：running → silent → pending → other，label 4/4；超出给 overflow", () => {
  const s = slotCells(occupied(4), "claude");
  expect(s.cells.map(c => c.state)).toEqual(["running", "silent", "pending", "other"]);
  expect(s.label).toBe("4/4");
  expect(s.overflow).toBe(0);
  expect(s.cells[0]!.worker).toEqual({ card: null, step: "write", round: 0, since: NOW - 1000, name: "w-r" });
  const small = slotCells(occupied(2), "claude");
  expect(small.cells).toHaveLength(2);
  expect(small.overflow).toBe(2);
});

test("[验收线 3] held 为真剩下全是 held；slot 为 null 给一个 unknown 格；本机 other 只看 busy", () => {
  const m = machine("peer-x", "inst-x", { slots: { claude: { total: 4, busy: 1, reportedBusy: null, placeable: 2, held: true }, codex: null }, workers: [worker("r", "running")] });
  expect(slotCells(m, "claude").cells.map(c => c.state)).toEqual(["running", "held", "held", "held"]);
  const unk = slotCells(m, "codex");
  expect(unk.cells.map(c => c.state)).toEqual(["unknown"]);
  expect(unk.overflow).toBe(0);
  const local = machine("local", "inst-self", { slots: { claude: { total: 3, busy: 2, reportedBusy: 9, placeable: 0, held: false }, codex: null } });
  expect(slotCells(local, "claude").cells.map(c => c.state)).toEqual(["other", "other", "empty"]);
});

test("[验收线 4] 额度：过期 5 分钟 unknown，离线 10 点 near，到线 stop，peer 无线只有 ok", () => {
  expect(quotaState({ usedPct: 10, resetAt: NOW, stopPct: 70, observedAt: NOW - 6 * 60_000 }, NOW)).toBe("unknown");
  expect(quotaState(null, NOW)).toBe("unknown");
  expect(quotaState({ usedPct: 10, resetAt: NOW, stopPct: 70, observedAt: null }, NOW)).toBe("unknown");
  expect(quotaState({ usedPct: 62, resetAt: NOW, stopPct: 70, observedAt: NOW }, NOW)).toBe("near");
  expect(quotaState({ usedPct: 70, resetAt: NOW, stopPct: 70, observedAt: NOW }, NOW)).toBe("stop");
  expect(quotaState({ usedPct: 99, resetAt: NOW, stopPct: null, observedAt: NOW }, NOW)).toBe("ok");
  expect(quotaState({ usedPct: 50, resetAt: NOW, stopPct: 70, observedAt: NOW }, NOW)).toBe("ok");
});

const row = (title: string, since: number, code: string | null = null, reason: string | null = null): WorkRow => ({
  taskId: title, featureId: null, nodeKey: null, title, who: null, machine: "local", step: null, round: 0, since,
  normalMinutes: 0, remainingMinutes: 0, overMinutes: 0, reason, code, estimate: "",
});

test("[验收线 5] 就绪没派：null 是未知；ready 在前，只收调度等待码", () => {
  expect(readyQueue(null)).toBeNull();
  const board: WorkBoard = {
    now: NOW, asOfSeq: 1, working: [], machines: {}, completionHours: null, availableSlots: 0,
    todo: { ready: [row("R2", 20), row("R1", 10)], blocked: [] },
    waiting: [row("cap", 5, "capacity", "本机名额满"), row("ci", 1, "ci", "等 CI"), row("lock", 3, "resource_busy", "文件锁：x"), row("mq", 2, "merge_queue", "合并排队")],
  };
  const q = readyQueue(board)!;
  expect(q.map(r => r.row.title)).toEqual(["R1", "R2", "lock", "cap"]);
  expect(q[0]!.reasonKey).toBe("roster.ready.waitScheduler");
  expect(q[2]!.reason).toBe("文件锁：x");
  expect(DISPATCH_WAIT).toEqual(["capacity", "placement", "resource_busy", "reviewer_capacity", "queue_frozen", "pooled", "quota"]);
});

test("[验收线 6] roster 为 null：位子全是未知，指标里位子和在线为 null，成员数照常", () => {
  const v = rosterOf(input(null));
  expect(v.people.map(p => p.slotNote)).toEqual(["roster.slot.unreadable", "roster.slot.unreadable", "roster.slot.unreadable"]);
  expect(v.people.every(p => p.machines.length === 0)).toBe(true);
  const m = rosterMetrics(v, null);
  expect(m.members).toBe(3);
  expect(m.online).toBeNull();
  expect(m.claude).toBeNull();
  expect(m.codex).toBeNull();
  expect(m.deliveredToday).toBeNull();
});

test("[验收线 6] parseRosterWire：一台 total 是字符串 → 丢这台，dropped 1；外层不对 → null；未知键忽略", () => {
  const good = { ...machine("local", "inst-self"), extraKey: 1 };
  const bad = { ...machine("peer-x", "inst-x"), slots: { claude: { total: "4", busy: 0, reportedBusy: null, placeable: 2, held: false }, codex: null } };
  const r = parseRosterWire({ now: NOW, project: "fixture", self: { instanceId: "inst-self" }, machines: [good, bad], unattributed: { merge: [], live: [], blocked: [] }, future: true });
  expect(r!.dropped).toBe(1);
  expect(r!.machines.map(m => m.machineKey)).toEqual(["local"]);
  expect(r!.machines[0]).not.toHaveProperty("extraKey");
  expect(parseRosterWire(null)).toBeNull();
  expect(parseRosterWire({ self: {}, machines: "x", now: NOW, project: "fixture" })).toBeNull();
  expect(parseRosterWire([])).toBeNull();
  const nanMachine = { ...machine("a", null), quota: { claude: { usedPct: Number.NaN, resetAt: NOW, stopPct: null, observedAt: null } } };
  const nan = parseRosterWire({ now: NOW, project: "fixture", self: { instanceId: null },
    unattributed: { merge: [], live: [], blocked: [] }, machines: [nanMachine] });
  expect(nan!.dropped).toBe(1);
});

test("rosterMetrics：在线 n/m、位子部分可知、角色计数、等合并去重、今天交付", () => {
  const r = roster([
    machine("local", "inst-self", {
      online: true, workers: [worker("a", "running"), worker("b", "running", { role: "reviewer" })],
      slots: { claude: { total: 4, busy: 2, reportedBusy: null, placeable: 2, held: false }, codex: { total: 2, busy: 0, reportedBusy: null, placeable: 2, held: false } },
      cards: { merge: ["M1", "M2"], live: [], blocked: [] }, output: [{ day: "d1", delivered: 9, reviewed: 2 }, { day: "d2", delivered: 2, reviewed: 1 }],
    }),
    machine("peer-x", "inst-x", { online: null, cards: { merge: ["M2"], live: [], blocked: [] }, output: [{ day: "d2", delivered: 1, reviewed: 1 }] }),
  ], { unattributed: { merge: ["M3", "M1"], live: [], blocked: [] } });
  const m = rosterMetrics(rosterOf(input(r)), r);
  expect(m.members).toBe(3);
  expect(m.online).toBeNull();
  expect(m.claude).toEqual({ used: 2, total: 6, partial: false });
  expect(m.codex).toEqual({ used: 0, total: 2, partial: true });
  expect(m.writing).toBe(1);
  expect(m.reviewing).toBe(1);
  expect(m.awaitingMerge).toBe(3);
  expect(m.deliveredToday).toBe(3);
});

test("ROSTER4 malformed known fields are unknown or dropped, never confirmed zero/free", () => {
  const wire = roster([machine("local", "inst-self")]);
  expect(parseRosterWire({ ...wire, unattributed: "broken" })).toBeNull();
  const badSlots = { claude: { total: 2, busy: 0, reportedBusy: null, placeable: 2, held: "false" }, codex: null };
  for (const extra of [{ cards: null }, { output: null }, { slots: badSlots }]) {
    const parsed = parseRosterWire({ ...wire, machines: [{ ...wire.machines[0], ...extra }] })!;
    expect(parsed.dropped).toBe(1);
    const m = rosterMetrics(rosterOf(input(parsed)), parsed);
    expect(m.claude).toBeNull();
    expect(m.deliveredToday).toBeNull();
  }
});

test("ROSTER4 a peer named local is not the local machine and cannot acquire self's seats", () => {
  const local = machine("local", "inst-self"), peer = { ...machine("local", "inst-x"), proto: "push" as const };
  const view = rosterOf(input(roster([local, peer])));
  expect(person(view, "p-self").machines.map(m => m.key)).toEqual(["local"]);
  expect(person(view, "p-a").machines.map(m => m.key)).toEqual(["peer:local"]);
});
