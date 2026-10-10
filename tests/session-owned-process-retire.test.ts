import { afterEach, describe, expect, test } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardWorkerIndex } from "../src/lib/agent-lifecycle-store.js";
import type { CardFacts } from "../src/lib/agent-lifecycle.js";
import type { OwnedProcessRecord, ProcessCreationRegistration, ProcessSessionOwner } from "../src/lib/session-owned-process.js";
import {
  retireSessionOwnedProcesses, type ObservationSource, type RegistrationSource, type RetireEvidence, type RetireTarget,
  type SessionRetireFacts, type SessionRetireInput, type SessionRetirePorts,
} from "../src/lib/session-owned-process-retire.js";
import { testChildEnv } from "./test-env.ts";

const EXACT = "boot+kernel-start" as const;
const card = (id: string, patch: Partial<CardFacts> = {}): CardFacts =>
  ({ id, project: "p", stage: "build", frozen: false, stageAt: null, reviewAt: null, agent: null, ...patch });

function facts(patch: Partial<SessionRetireFacts> = {}, sessionId = "session-a"): SessionRetireFacts {
  return {
    index: buildCardWorkerIndex({ registrations: [{ agent: "w1", taskId: "T1", role: "author", sessionId }], bound: [], executors: [] }),
    cards: [card("T1")], pms: new Set(), foreign: new Set(), master: new Set(), ...patch,
  };
}

function registration(owner: ProcessSessionOwner, parent: OwnedProcessRecord, child: OwnedProcessRecord): ProcessCreationRegistration {
  return { owner: structuredClone(owner), kind: "created", parent: { pid: parent.pid, uid: parent.uid, startId: parent.startId }, child: { ...child } };
}

interface Calls { order: string[]; preserved: RetireEvidence[]; retired: RetireTarget[] }

/** Scripted ports: `samples` are returned in turn (the last one repeats); every call is recorded in order. */
function scripted(entries: readonly ProcessCreationRegistration[], samples: readonly (readonly OwnedProcessRecord[] | null)[], owner: ProcessSessionOwner,
  over: Partial<SessionRetirePorts> = {}): { ports: SessionRetirePorts; calls: Calls } {
  const calls: Calls = { order: [], preserved: [], retired: [] };
  let sequence = 0;
  const ports: SessionRetirePorts = {
    registrations: async () => { calls.order.push("registrations"); return { status: "ok", startIdSource: EXACT, entries }; },
    observe: async () => {
      calls.order.push("observe");
      const processes = samples[Math.min(sequence, samples.length - 1)];
      sequence++;
      return processes ? { status: "ok", startIdSource: EXACT, owner: structuredClone(owner), sequence, processes: structuredClone(processes) } : { status: "unavailable" };
    },
    preserve: async (evidence) => { calls.order.push("preserve"); calls.preserved.push(evidence); return { ok: true, ref: "evidence-1" }; },
    retire: async (target) => { calls.order.push(`retire:${target.process.pid}`); calls.retired.push(target); return "retired"; },
    ...over,
  };
  return { ports, calls };
}

// ── synthetic evidence ──
const root: OwnedProcessRecord = { pid: 100, uid: 501, startId: "boot-a:100:20", ppid: 1, pgid: 100 };
const mcp: OwnedProcessRecord = { pid: 200, uid: 501, startId: "boot-a:200:30", ppid: 100, pgid: 100 };
const shell: OwnedProcessRecord = { pid: 210, uid: 501, startId: "boot-a:210:31", ppid: 100, pgid: 100 };
const leaf: OwnedProcessRecord = { pid: 300, uid: 501, startId: "boot-a:300:40", ppid: 200, pgid: 100 };
const owner: ProcessSessionOwner = { sessionId: "session-a", generation: 3, root: { pid: root.pid, uid: root.uid, startId: root.startId } };
const all = [root, mcp, shell, leaf];
const entries = [registration(owner, root, mcp), registration(owner, root, shell), registration(owner, mcp, leaf)];

function input(patch: Partial<SessionRetireInput> = {}): SessionRetireInput {
  return { mode: "on", trigger: "end", agent: { name: "w1", kind: "worker", sessionId: "session-a" }, owner: structuredClone(owner), facts: facts(), ...patch };
}

const reasons = (r: { processes: readonly { pid: number; reason: string }[] }) => Object.fromEntries(r.processes.map((p) => [p.pid, p.reason]));

describe("mode", () => {
  test("default is observe: proven children are reported, nothing is saved or handed over", async () => {
    const { ports, calls } = scripted(entries, [all], owner);
    const { mode: _mode, ...noMode } = input();
    const r = await retireSessionOwnedProcesses(noMode, ports);
    expect(r).toMatchObject({ mode: "observe", outcome: "observed", reason: "observe-only", handedOver: 0 });
    expect(reasons(r)).toEqual({ 300: "would-retire", 200: "would-retire", 210: "would-retire" });
    expect(r.processes.every((p) => p.decision === "retire")).toBe(true);
    expect(calls.order).toEqual(["registrations", "observe", "observe"]);
  });

  test("off and unrecognised modes call no port at all", async () => {
    for (const mode of ["off", "ON", "kill", null, 1] as unknown as SessionRetireInput["mode"][]) {
      const { ports, calls } = scripted(entries, [all], owner);
      expect(await retireSessionOwnedProcesses(input({ mode }), ports)).toMatchObject({ mode: "off", outcome: "off", handedOver: 0 });
      expect(calls.order).toEqual([]);
    }
  });

  test("on: evidence is saved before the first hand-over, leaves go first, exact identity and evidence ref are passed", async () => {
    const { ports, calls } = scripted(entries, [all], owner);
    const r = await retireSessionOwnedProcesses(input({ trigger: "restart" }), ports);
    expect(r).toMatchObject({ mode: "on", outcome: "retired", reason: "handed-over", handedOver: 3, staleRegistrations: 0 });
    expect(calls.order).toEqual(["registrations", "observe", "observe", "preserve", "observe", "retire:300", "retire:200", "retire:210"]);
    expect(calls.retired[0]).toEqual({ agent: "w1", sessionId: "session-a", generation: 3, trigger: "restart", process: leaf, evidenceRef: "evidence-1" });
    expect(calls.preserved[0].registrations).toHaveLength(3);
    expect(calls.preserved[0].decisions.map((d) => d.decision)).toEqual(["retire", "retire", "retire"]);
  });
});

describe("sessions that are only reported", () => {
  const cases: [string, Partial<SessionRetireInput>, string][] = [
    ["user's own agent (no ledger record)", { facts: facts({ index: new Map() }) }, "user-session"],
    ["record names another session (name reused)", { facts: facts({}, "session-old") }, "unknown-history"],
    ["only a card's executor field, no session on record", { facts: facts({
      index: buildCardWorkerIndex({ registrations: [], bound: [], executors: [{ agent: "w1", taskId: "T1", stage: "build" }] }) }) }, "unknown-history"],
    ["records disagree on the session", { facts: facts({ index: buildCardWorkerIndex({ registrations: [{ agent: "w1", taskId: "T1", role: "author", sessionId: "session-a" }],
      bound: [{ agent: "w1", taskId: "T1", role: "author", sessionId: "session-b" }], executors: [] }) }) }, "session-conflict"],
    ["master", { facts: facts({ master: new Set(["w1"]) }) }, "protected-agent"],
    ["PM by ledger", { facts: facts({ pms: new Set(["w1"]) }) }, "protected-agent"],
    ["PM by role", { agent: { name: "w1", role: "pm", sessionId: "session-a" } }, "protected-agent"],
    ["main agent", { agent: { name: "w1", kind: "main", sessionId: "session-a" } }, "protected-agent"],
    ["lend worker", { facts: facts({ foreign: new Set(["w1"]) }) }, "foreign-owner"],
    ["frozen card", { facts: facts({ cards: [card("T1", { frozen: true })] }) }, "frozen-card"],
    ["card extra unreadable", { facts: facts({ cards: [card("T1", { extraError: "bad json" })] }) }, "card-unknown"],
    ["card not in the ledger", { facts: facts({ cards: [] }) }, "card-unknown"],
    ["owner is another session than the agent runs", { owner: { ...owner, sessionId: "session-z" } }, "invalid-input"],
    ["agent session unknown", { agent: { name: "w1" } }, "invalid-input"],
  ];
  for (const [name, patch, reason] of cases) {
    test(name, async () => {
      const { ports, calls } = scripted(entries, [all], owner);
      expect(await retireSessionOwnedProcesses(input(patch), ports)).toMatchObject({ outcome: "report-only", reason, handedOver: 0, processes: [] });
      expect(calls.order).toEqual([]);
    });
  }
});

describe("unclear evidence hands nothing over", () => {
  const none = async (ports: SessionRetirePorts, calls: Calls, patch: Partial<SessionRetireInput> = {}) => {
    const r = await retireSessionOwnedProcesses(input(patch), ports);
    expect(r.handedOver).toBe(0);
    expect(calls.retired).toEqual([]);
    return r;
  };

  test("second-precision start identity in the records or in a sample", async () => {
    const coarse = scripted(entries, [all], owner, { registrations: async (): Promise<RegistrationSource> => ({ status: "ok", startIdSource: "ps-lstart", entries }) });
    expect(await none(coarse.ports, coarse.calls)).toMatchObject({ outcome: "refused", reason: "start-id-unreliable" });
    for (const startIdSource of ["ps-lstart", "unknown", undefined] as const) {
      let sequence = 0;
      const s = scripted(entries, [all], owner, { observe: async () => ({ status: "ok", startIdSource, owner, sequence: ++sequence, processes: all }) as ObservationSource });
      const r = await none(s.ports, s.calls);
      expect(r.reason).toBe("nothing-proven");
      expect(new Set(Object.values(reasons(r)))).toEqual(new Set(["start-id-unreliable"]));
      expect(s.calls.preserved).toEqual([]);
    }
  });

  test("records or samples unavailable, or a port that throws", async () => {
    const down = scripted(entries, [all], owner, { registrations: async () => ({ status: "unavailable" }) });
    expect(await none(down.ports, down.calls)).toMatchObject({ outcome: "refused", reason: "registrations-unavailable" });
    const thrown = scripted(entries, [all], owner, { registrations: async () => { throw new Error("store down"); } });
    expect(await none(thrown.ports, thrown.calls)).toMatchObject({ reason: "registrations-unavailable" });
    const blind = scripted(entries, [all, null], owner);
    expect(new Set(Object.values(reasons(await none(blind.ports, blind.calls))))).toEqual(new Set(["source-unavailable"]));
    const crash = scripted(entries, [all], owner, { observe: async () => { throw new Error("ps failed"); } });
    expect(new Set(Object.values(reasons(await none(crash.ports, crash.calls))))).toEqual(new Set(["source-unavailable"]));
  });

  test("pid reuse: same pid, another start identity", async () => {
    const reused = all.map((p) => (p.pid === mcp.pid ? { ...p, startId: "boot-a:200:99" } : p));
    const { ports, calls } = scripted([registration(owner, root, mcp)], [reused], owner);
    expect(reasons(await none(ports, calls))).toEqual({ 200: "identity-mismatch" });
  });

  test("a child that left its creation group or was re-parented is kept while its proven sibling goes", async () => {
    const moved = all.map((p) => (p.pid === shell.pid ? { ...p, pgid: shell.pid } : p.pid === leaf.pid ? { ...p, ppid: 1 } : p));
    const { ports, calls } = scripted(entries, [moved], owner);
    const r = await retireSessionOwnedProcesses(input(), ports);
    expect(reasons(r)).toEqual({ 300: "parent-mismatch", 200: "retired", 210: "group-mismatch" });
    expect(calls.retired.map((t) => t.process.pid)).toEqual([200]);
  });

  test("an unregistered process under the session root is never a target, whatever it looks like", async () => {
    const stray: OwnedProcessRecord = { pid: 400, uid: 501, startId: "boot-a:400:50", ppid: 1, pgid: 400 };
    const { ports, calls } = scripted([registration(owner, root, mcp)], [[...all, stray]], owner);
    const r = await retireSessionOwnedProcesses(input(), ports);
    expect(r.processes.map((p) => p.pid)).toEqual([200]);
    expect(calls.retired.map((t) => t.process.pid)).toEqual([200]);
  });

  test("evidence not saved (refused, threw, no reference): nothing handed over and no third sample", async () => {
    for (const preserve of [async () => ({ ok: false as const }), async () => { throw new Error("disk full"); }, async () => ({ ok: true as const, ref: "" })]) {
      const { ports, calls } = scripted(entries, [all], owner, { preserve });
      const r = await none(ports, calls);
      expect(r).toMatchObject({ outcome: "refused", reason: "preserve-failed" });
      expect(r.processes.every((p) => p.decision === "report" && p.reason === "preserve-failed")).toBe(true);
      expect(calls.order.filter((c) => c === "observe")).toHaveLength(2);
    }
  });

  test("a process that changed while the evidence was being saved is not handed over", async () => {
    const after = all.map((p) => (p.pid === mcp.pid ? { ...p, startId: "boot-a:200:77" } : p));
    const { ports, calls } = scripted(entries, [all, all, after], owner);
    const r = await retireSessionOwnedProcesses(input(), ports);
    // the leaf's chain runs through the changed parent, so it is kept too
    expect(reasons(r)).toEqual({ 300: "identity-mismatch", 200: "identity-mismatch", 210: "retired" });
    expect(calls.retired.map((t) => t.process.pid)).toEqual([210]);
  });

  test("mixed records for this session and generation (another root) refuse the whole set", async () => {
    const otherRoot = { ...owner, root: { ...owner.root, startId: "boot-a:100:21" } };
    const { ports, calls } = scripted([...entries, registration(otherRoot, root, { ...shell, pid: 220 })], [all], owner);
    expect(new Set(Object.values(reasons(await none(ports, calls))))).toEqual(new Set(["owner-mismatch"]));
    const broken = scripted([...entries, { kind: "created" } as unknown as ProcessCreationRegistration], [all], owner);
    expect(new Set(Object.values(reasons(await none(broken.ports, broken.calls))))).toEqual(new Set(["invalid-evidence"]));
  });

  test("a refusal or error from the retire entry stops the run", async () => {
    for (const [answer, reason] of [["refused", "refused"], ["throw", "retire-error"], ["killed", "refused"]] as const) {
      const { ports, calls } = scripted(entries, [all], owner, {});
      const seen: number[] = [];
      ports.retire = async (t) => { seen.push(t.process.pid); if (answer === "throw") throw new Error("entry failed"); return answer as "refused"; };
      const r = await retireSessionOwnedProcesses(input(), ports);
      expect(r).toMatchObject({ outcome: "refused", reason: "retire-incomplete", handedOver: 1 });
      expect(seen).toEqual([300]);
      expect(reasons(r)).toEqual({ 300: reason, 200: "not-attempted", 210: "not-attempted" });
      expect(calls.preserved).toHaveLength(1);
    }
  });
});

describe("generations", () => {
  const next: ProcessSessionOwner = { ...owner, generation: 4 };
  const other: ProcessSessionOwner = { ...owner, sessionId: "session-b" };
  const newMcp: OwnedProcessRecord = { pid: 500, uid: 501, startId: "boot-a:500:60", ppid: 100, pgid: 100 };

  test("records of the next generation and of other sessions are set aside, never matched or handed over", async () => {
    const mixed = [registration(next, root, newMcp), ...entries, registration(other, root, { ...newMcp, pid: 600 })];
    const { ports, calls } = scripted(mixed, [[...all, newMcp]], owner);
    const r = await retireSessionOwnedProcesses(input({ trigger: "restart" }), ports);
    expect(r).toMatchObject({ outcome: "retired", staleRegistrations: 2, handedOver: 3 });
    expect(calls.retired.map((t) => t.process.pid)).toEqual([300, 200, 210]);
    expect(calls.preserved[0].registrations.every((e) => e.owner.generation === 3 && e.owner.sessionId === "session-a")).toBe(true);
  });

  test("a pid claimed by this generation and by another one is contradictory and kept", async () => {
    const { ports, calls } = scripted([registration(next, root, mcp), registration(owner, root, mcp), registration(owner, root, shell)], [all], owner);
    const r = await retireSessionOwnedProcesses(input(), ports);
    expect(reasons(r)).toEqual({ 200: "conflicting-registration", 210: "retired" });
    expect(calls.retired.map((t) => t.process.pid)).toEqual([210]);
  });

  test("only stale records: nothing registered for this generation", async () => {
    const { ports, calls } = scripted([registration(next, root, newMcp)], [all], owner);
    expect(await retireSessionOwnedProcesses(input(), ports)).toMatchObject({ outcome: "observed", reason: "nothing-registered", staleRegistrations: 1, handedOver: 0 });
    expect(calls.order).toEqual(["registrations"]);
  });
});

test("the module itself has no way to signal, spawn or delete", () => {
  const src = readFileSync(join(import.meta.dir, "../src/lib/session-owned-process-retire.ts"), "utf8");
  expect(src).not.toMatch(/process\.kill|\.kill\(|Bun\.spawn|child_process|node:fs|rmSync|unlink|tmux/);
  expect([...src.matchAll(/ from "(.+)";$/gm)].map((m) => m[1]).sort()).toEqual(["./agent-lifecycle.js", "./session-owned-process.js"]);
});

// ── real, isolated child processes ──
// Fixture processes only: `sh` roots and `sleep` children this file starts with a bare environment and a temp HOME. Identity is
// read from the kernel (boot id + exact start value), never from ps. The retire port here is a test stand-in for LIFE1's entry.

const supported = process.platform === "darwin" || process.platform === "linux";
const libproc = process.platform === "darwin"
  ? dlopen("libproc.dylib", { proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" } }) : null;
let bootId: string | null = null;

function boot(): string {
  bootId ??= process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    : Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { env: testChildEnv({ PATH: "/usr/bin:/bin" }) }).stdout.toString().trim();
  if (!bootId) throw new Error("no boot identity");
  return bootId;
}

/** One process as the kernel has it now; null = not there (or a zombie). */
function kernelRecord(pid: number): OwnedProcessRecord | null {
  if (libproc) {
    const buf = new Uint8Array(136), view = new DataView(buf.buffer); // struct proc_bsdinfo, PROC_PIDTBSDINFO = 3
    if (libproc.symbols.proc_pidinfo(pid, 3, 0n, ptr(buf), 136) !== 136 || view.getUint32(4, true) === 5 /* SZOMB */) return null;
    return { pid, uid: view.getUint32(20, true), ppid: view.getUint32(16, true), pgid: view.getUint32(100, true),
      startId: `${boot()}:${view.getBigUint64(120, true)}.${view.getBigUint64(128, true)}` };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (f[0] === "Z" || f[0] === "X") return null;
    return { pid, uid: statSync(`/proc/${pid}`).uid, ppid: Number(f[1]), pgid: Number(f[2]), startId: `${boot()}:${f[19]}` };
  } catch { return null; /* the process is gone: absent from the sample */ }
}

interface Session { owner: ProcessSessionOwner; root: OwnedProcessRecord; children: OwnedProcessRecord[]; proc: ReturnType<typeof Bun.spawn> }
const started: Session[] = [];
const homes: string[] = [];

/** A fixture "session root" (sh) that starts `n` sleeps; each child's record is captured right at creation. */
async function startSession(sessionId: string, generation: number, n: number): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), "orph1-"));
  homes.push(home);
  const script = `${Array.from({ length: n }, () => "sleep 120 >/dev/null 2>&1 & echo $!").join("; ")}; wait`;
  const proc = Bun.spawn(["/bin/sh", "-c", script], { cwd: home, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    env: testChildEnv({ PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home }) });
  const reader = proc.stdout.getReader(), decoder = new TextDecoder();
  let text = "";
  while (text.split("\n").length <= n) {
    const { value, done } = await reader.read();
    if (done) throw new Error("fixture root exited early");
    text += decoder.decode(value);
  }
  reader.releaseLock();
  const rootRecord = kernelRecord(proc.pid)!;
  const children = text.trim().split("\n").map((l) => kernelRecord(Number(l))!);
  if (!rootRecord || children.some((c) => !c || c.ppid !== proc.pid)) throw new Error("fixture identity unreadable");
  const s: Session = { owner: { sessionId, generation, root: { pid: rootRecord.pid, uid: rootRecord.uid, startId: rootRecord.startId } }, root: rootRecord, children, proc };
  started.push(s);
  return s;
}

const alive = (p: OwnedProcessRecord): boolean => kernelRecord(p.pid)?.startId === p.startId;

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
  if (!cond()) throw new Error("fixture did not settle");
}

/** Stops one fixture process, and only while the kernel still shows the instance this file started. */
async function stopFixture(p: OwnedProcessRecord): Promise<void> {
  if (!started.some((s) => s.root.pid === p.pid || s.children.some((c) => c.pid === p.pid)) || !alive(p)) return;
  process.kill(p.pid, "SIGKILL");
  await until(() => !alive(p));
}

afterEach(async () => {
  for (const s of started.splice(0)) for (const p of [...s.children, s.root]) await stopFixture(p);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function livePorts(s: Session, entries: ProcessCreationRegistration[], watch: OwnedProcessRecord[]): { ports: SessionRetirePorts; calls: Calls } {
  const calls: Calls = { order: [], preserved: [], retired: [] };
  let sequence = 0;
  const ports: SessionRetirePorts = {
    registrations: async () => ({ status: "ok", startIdSource: EXACT, entries }),
    observe: async () => {
      calls.order.push("observe");
      const processes = [s.root, ...watch].flatMap((p) => kernelRecord(p.pid) ?? []);
      return { status: "ok", startIdSource: EXACT, owner: s.owner, sequence: ++sequence, processes };
    },
    preserve: async (e) => { calls.order.push("preserve"); calls.preserved.push(e); return { ok: true, ref: "evidence-live" }; },
    retire: async (t) => {
      calls.order.push(`retire:${t.process.pid}`);
      calls.retired.push(t);
      if (!alive(t.process)) return "gone";
      await stopFixture(t.process);
      return "retired";
    },
  };
  return { ports, calls };
}

const liveInput = (s: Session, patch: Partial<SessionRetireInput> = {}): SessionRetireInput => ({
  mode: "on", trigger: "end", agent: { name: "w1", kind: "worker", sessionId: s.owner.sessionId }, owner: s.owner, facts: facts({}, s.owner.sessionId), ...patch });

describe.skipIf(!supported)("real isolated children", () => {
  test("only the registered child is handed over; its unregistered sibling and the root stay; a repeat hands nothing over", async () => {
    const s = await startSession("session-live", 1, 2), [mine, sibling] = s.children;
    const { ports, calls } = livePorts(s, [registration(s.owner, s.root, mine)], s.children);
    const r = await retireSessionOwnedProcesses(liveInput(s), ports);
    expect(r).toMatchObject({ outcome: "retired", handedOver: 1 });
    expect(calls.order).toEqual(["observe", "observe", "preserve", "observe", `retire:${mine.pid}`]);
    expect(calls.retired[0].process).toEqual(mine);
    expect(alive(mine)).toBe(false);
    expect(alive(sibling)).toBe(true);
    expect(alive(s.root)).toBe(true);
    const again = await retireSessionOwnedProcesses(liveInput(s), ports);
    expect(again).toMatchObject({ outcome: "observed", reason: "nothing-proven", handedOver: 0 });
    expect(reasons(again)).toEqual({ [mine.pid]: "process-missing" });
    expect(calls.retired).toHaveLength(1);
    expect(alive(sibling)).toBe(true);
  });

  test("observe mode and a user's own session leave real children running", async () => {
    const s = await startSession("session-live", 1, 1), entries = [registration(s.owner, s.root, s.children[0])];
    const watching = livePorts(s, entries, s.children);
    expect(await retireSessionOwnedProcesses(liveInput(s, { mode: "observe" }), watching.ports)).toMatchObject({ reason: "observe-only", handedOver: 0 });
    const users = livePorts(s, entries, s.children);
    expect(await retireSessionOwnedProcesses(liveInput(s, { facts: facts({ index: new Map() }) }), users.ports)).toMatchObject({ reason: "user-session" });
    expect([...watching.calls.retired, ...users.calls.retired, ...watching.calls.preserved]).toEqual([]);
    expect(alive(s.children[0])).toBe(true);
  });

  test("restart: retiring the old generation leaves the new generation's child alone, also when repeated", async () => {
    const old = await startSession("session-live", 3, 1), fresh = await startSession("session-live", 4, 1);
    const entries = [registration(fresh.owner, fresh.root, fresh.children[0]), registration(old.owner, old.root, old.children[0])];
    const { ports, calls } = livePorts(old, entries, [...old.children, ...fresh.children, fresh.root]);
    for (const handed of [1, 0]) {
      const r = await retireSessionOwnedProcesses(liveInput(old, { trigger: "restart" }), ports);
      expect(r).toMatchObject({ staleRegistrations: 1, handedOver: handed });
    }
    expect(calls.retired.map((t) => t.process.pid)).toEqual([old.children[0].pid]);
    expect(alive(old.children[0])).toBe(false);
    expect(alive(fresh.children[0])).toBe(true);
    expect(alive(fresh.root)).toBe(true);
  });

  test("an orphan whose session root is gone is only reported", async () => {
    const s = await startSession("session-live", 1, 1), orphan = s.children[0];
    await stopFixture(s.root);
    await until(() => kernelRecord(orphan.pid)?.ppid !== s.root.pid);
    const { ports, calls } = livePorts(s, [registration(s.owner, s.root, orphan)], s.children);
    const r = await retireSessionOwnedProcesses(liveInput(s), ports);
    expect(r).toMatchObject({ outcome: "observed", reason: "nothing-proven", handedOver: 0 });
    expect(calls.preserved).toEqual([]);
    expect(alive(orphan)).toBe(true);
  });
});
