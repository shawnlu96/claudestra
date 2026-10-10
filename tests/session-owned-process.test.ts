import { describe, expect, test } from "bun:test";
import {
  matchSessionOwnedProcess,
  type OwnedProcessRecord,
  type ProcessCreationRegistration,
  type ProcessSessionOwner,
  type SessionOwnedProcessInput,
} from "../src/lib/session-owned-process.js";

// All evidence is synthetic. No process discovery, production registration or model invocation.
const root: OwnedProcessRecord = { pid: 100, uid: 501, startId: "boot-a:100:20", ppid: 1, pgid: 100 };
const child: OwnedProcessRecord = { pid: 200, uid: 501, startId: "boot-a:200:30", ppid: 100, pgid: 100 };
const leaf: OwnedProcessRecord = { pid: 300, uid: 501, startId: "boot-a:300:40", ppid: 200, pgid: 100 };
const owner: ProcessSessionOwner = { sessionId: "session-a", generation: 3, root };

function registration(parent: OwnedProcessRecord, process: OwnedProcessRecord): ProcessCreationRegistration {
  return { owner: structuredClone(owner), kind: "created", parent: { ...parent }, child: { ...process } };
}

function fixture(nested = false) {
  const processes = nested ? [root, child, leaf] : [root, child];
  return {
    owner: structuredClone(owner),
    targetPid: nested ? leaf.pid : child.pid,
    registrations: { status: "ok" as const, entries: nested ? [registration(root, child), registration(child, leaf)] : [registration(root, child)] },
    observations: [1, 2].map((sequence) => ({
      status: "ok" as const, owner: structuredClone(owner), sequence, processes: structuredClone(processes),
    })) as [Sample, Sample],
  };
}

type Sample = { status: "ok"; owner: ProcessSessionOwner; sequence: number; processes: OwnedProcessRecord[] };

function result(input: unknown) {
  return matchSessionOwnedProcess(input as SessionOwnedProcessInput);
}

function editObserved(input: ReturnType<typeof fixture>, pid: number, patch: Partial<OwnedProcessRecord>, only?: number) {
  input.observations.forEach((sample, i) => {
    if (only === undefined || only === i) sample.processes = sample.processes.map((p) => p.pid === pid ? { ...p, ...patch } : p);
  });
}

describe("creation evidence joined with two observations", () => {
  test("direct and nested registered children match, irrespective of input ordering", () => {
    for (const nested of [false, true]) {
      const input = fixture(nested);
      input.registrations.entries.reverse();
      input.observations[1].processes.reverse();
      expect(result(input)).toEqual({ status: "matched", reason: "creation-confirmed" });
    }
  });

  test("an explicitly detached group captured at creation still matches exact identity", () => {
    const input = fixture(true);
    input.registrations.entries[1] = registration(child, { ...leaf, pgid: leaf.pid });
    editObserved(input, leaf.pid, { pgid: leaf.pid });
    expect(result(input).status).toBe("matched");
    // Detaching after registration cannot be excused by the still-valid ancestor chain.
    input.registrations.entries[1] = registration(child, leaf);
    expect(result(input)).toEqual({ status: "mismatch", reason: "group-mismatch" });
  });

  test("UID zero is a real identity, while an owner root cannot prove itself a child", () => {
    const input = fixture();
    input.owner = { ...input.owner, root: { ...root, uid: 0 } };
    input.registrations.entries = [{ kind: "created", owner: input.owner, parent: input.owner.root, child: { ...child, uid: 0 } }];
    input.observations.forEach((s) => { s.owner = input.owner; s.processes = s.processes.map((p) => ({ ...p, uid: 0 })); });
    expect(result(input).status).toBe("matched");
    input.targetPid = root.pid;
    expect(result(input).status).toBe("mismatch");
  });

  test("unknown historical MCP and background shell are not adopted via names or ancestry", () => {
    for (const command of ["mcp-server --owner session-a", "bash --session session-a", "/safe/claude"]) {
      const input = fixture();
      input.registrations.entries = [];
      for (const sample of input.observations) Object.assign(sample.processes[1], { command, argv: command, owner });
      expect(result(input)).toEqual({ status: "unknown", reason: "unregistered" });
    }
  });

  test("a nested child requires creation records for every hop to the owning root", () => {
    const input = fixture(true);
    input.registrations.entries.shift();
    expect(result(input)).toEqual({ status: "unknown", reason: "unregistered" });
  });

  test("neither inputs nor returned data retain mutable shared state between calls", () => {
    const input = fixture(true), before = structuredClone(input);
    const first = result(input);
    expect(input).toEqual(before);
    Object.assign(first, { status: "unknown" });
    expect(result(input).status).toBe("matched");
    editObserved(input, leaf.pid, { startId: "boot-a:300:999" });
    expect(result(input).status).toBe("mismatch");
    expect(result(before).status).toBe("matched");
  });
});

describe("counterexamples to PID, session and topology inference", () => {
  test("PID reuse or user change at any used hop defeats matching in either sample", () => {
    for (const pid of [root.pid, child.pid, leaf.pid]) {
      for (const only of [undefined, 0, 1]) {
        for (const patch of [{ startId: "boot-b:reused" }, { uid: 502 }]) {
          const input = fixture(true);
          editObserved(input, pid, patch, only);
          expect(result(input)).toEqual({ status: "mismatch", reason: "identity-mismatch" });
        }
      }
    }
  });

  test("session, generation and root changes in registry or either sample reject old ownership", () => {
    for (const changed of ["registration", "first", "second", "request"]) {
      for (const patch of [{ generation: 4 }, { sessionId: "session-b" }, { root: { ...root, startId: "boot-a:100:99" } }]) {
        const input = fixture();
        const other = { ...owner, ...patch };
        if (changed === "registration") input.registrations.entries[0] = { ...input.registrations.entries[0], owner: other };
        else if (changed === "request") input.owner = other;
        else input.observations[changed === "first" ? 0 : 1].owner = other;
        expect(result(input)).toEqual({ status: "mismatch", reason: "owner-mismatch" });
      }
    }
  });

  test("an absent/exited parent cannot be replaced by its old PID or by PPID 1", () => {
    for (const missing of [root.pid, child.pid, leaf.pid]) {
      for (const only of [undefined, 0, 1]) {
        const input = fixture(true);
        input.observations.forEach((s, i) => {
          if (only === undefined || only === i) s.processes = s.processes.filter((p) => p.pid !== missing);
        });
        expect(result(input).status).toBe("unknown");
      }
    }
    const reparented = fixture();
    editObserved(reparented, child.pid, { ppid: 1 });
    expect(result(reparented)).toEqual({ status: "mismatch", reason: "parent-mismatch" });
  });

  test("stable reparenting/group escape rejects; changes between observations remain unknown", () => {
    for (const patch of [{ ppid: 999 }, { pgid: 999 }]) {
      const stable = fixture();
      editObserved(stable, child.pid, patch);
      expect(result(stable).status).toBe("mismatch");
      for (const pid of [root.pid, child.pid, leaf.pid]) {
        const unstable = fixture(true);
        editObserved(unstable, pid, patch, 1);
        expect(result(unstable)).toEqual({ status: "unknown", reason: "observation-changed" });
      }
    }
  });

  test("contradictory registration parent and child identities fail closed", () => {
    for (const patch of [{ startId: "reused-parent" }, { uid: 999 }, { pid: 999 }]) {
      const input = fixture(true);
      input.registrations.entries[1] = { ...input.registrations.entries[1], parent: { ...child, ...patch } };
      expect(result(input).status).toBe("mismatch");
    }
    const input = fixture(true);
    input.registrations.entries[0] = registration(root, { ...child, startId: "other-incarnation" });
    expect(result(input).status).toBe("mismatch");
  });
});

describe("incomplete, conflicted and bounded evidence", () => {
  test("missing registration source or either observation cannot match", () => {
    for (const absent of [undefined, null, { status: "unavailable" }, { status: "partial", error: "SECRET" }]) {
      const input = fixture();
      expect(result({ ...input, registrations: absent }).status).toBe("unknown");
      for (const i of [0, 1]) {
        const observations: unknown[] = [...input.observations];
        observations[i] = absent;
        expect(result({ ...input, observations }).status).toBe("unknown");
      }
    }
  });

  test("duplicate PID evidence is ambiguous even when byte-for-byte identical", () => {
    for (const conflict of [false, true]) {
      const input = fixture();
      input.registrations.entries.push(registration(root, { ...child, startId: conflict ? "other" : child.startId }));
      expect(result(input)).toEqual({ status: "unknown", reason: "duplicate-pid" });
      for (const i of [0, 1]) {
        const observed = fixture();
        observed.observations[i].processes.push({ ...child, startId: conflict ? "other" : child.startId });
        expect(result(observed)).toEqual({ status: "unknown", reason: "duplicate-pid" });
      }
    }
  });

  test("cycles in registration or either snapshot never masquerade as a partial tree", () => {
    const input = fixture(true);
    input.registrations.entries[0] = registration(leaf, { ...child, ppid: leaf.pid });
    expect(result(input)).toEqual({ status: "unknown", reason: "tree-cycle" });
    for (const i of [0, 1]) {
      for (const ppid of [child.pid, leaf.pid]) {
        const observed = fixture(true);
        editObserved(observed, child.pid, { ppid }, i);
        expect(result(observed)).toEqual({ status: "unknown", reason: "tree-cycle" });
      }
    }
  });

  test("bounded traversal rejects long chains and oversized sources", () => {
    const input = fixture();
    const chain = Array.from({ length: 65 }, (_, i) => ({ ...child, pid: 1000 + i, ppid: i === 64 ? 1 : 1001 + i }));
    input.observations[0].processes.push(...chain);
    expect(result(input)).toEqual({ status: "unknown", reason: "depth-limit" });
    const many = fixture();
    many.registrations.entries = Array.from({ length: 4097 }, () => registration(root, child));
    expect(result(many)).toEqual({ status: "unknown", reason: "evidence-limit" });
    const observed = fixture();
    observed.observations[1].processes = Array.from({ length: 4097 }, () => child);
    expect(result(observed)).toEqual({ status: "unknown", reason: "evidence-limit" });
  });

  test("two ordered samples are mandatory, never a missing, repeated or reversed sample", () => {
    for (const sequence of [0, 1, -1, 0.5, NaN, Infinity, "2"]) {
      const input = fixture();
      Object.assign(input.observations[1], { sequence });
      expect(result(input).status).toBe("unknown");
    }
    const input = fixture();
    for (const observations of [[], [input.observations[0]], [...input.observations, input.observations[1]], [...input.observations].reverse()]) {
      expect(result({ ...input, observations }).status).toBe("unknown");
    }
  });

  test("missing fields and invalid numerical identities are rejected at every boundary", () => {
    for (const invalid of [null, undefined, {}, [], false, "SECRET"]) expect(result(invalid).status).toBe("unknown");
    for (const pid of [0, 1, -1, 1.5, NaN, Infinity, 0x80000000, Number.MAX_SAFE_INTEGER + 1, "200", null]) {
      expect(result({ ...fixture(), targetPid: pid }).status).toBe("unknown");
    }
    for (const key of ["pid", "uid", "startId", "ppid", "pgid"]) {
      for (const value of [undefined, null, -1, NaN, ""]) {
        const input = fixture();
        Object.assign(input.observations[0].processes[1], { [key]: value });
        expect(result(input).status).toBe("unknown");
        const registered = fixture();
        Object.assign(registered.registrations.entries[0].child, { [key]: value });
        expect(result(registered).status).toBe("unknown");
      }
    }
    for (const key of ["sessionId", "generation", "root"]) {
      const input = fixture();
      Object.assign(input.owner, { [key]: undefined });
      expect(result(input).status).toBe("unknown");
    }
    for (const startId of [" ", "x".repeat(257)]) {
      const input = fixture();
      editObserved(input, child.pid, { startId });
      expect(result(input).status).toBe("unknown");
    }
  });

  test("malformed collection and discovery-as-registration fail closed", () => {
    for (const entries of [undefined, null, {}, [null], [{ ...registration(root, child), kind: "discovered" }]]) {
      expect(result({ ...fixture(), registrations: { status: "ok", entries } }).status).toBe("unknown");
    }
    for (const processes of [undefined, null, {}, [null]]) {
      const input = fixture();
      Object.assign(input.observations[1], { processes });
      expect(result(input).status).toBe("unknown");
    }
  });
});

test("diagnostics never echo credentials, command text, paths or supplied objects", () => {
  const secret = "credential-SENTINEL:/private/key --token=do-not-print";
  const input = fixture();
  Object.assign(input.registrations.entries[0], { argv: [secret], path: secret, reason: secret });
  for (const sample of input.observations) {
    Object.assign(sample.processes[1], { argv: [secret], path: secret, owner: secret });
  }
  const good = result(input);
  expect(good).toEqual({ status: "matched", reason: "creation-confirmed" });
  editObserved(input, child.pid, { startId: secret });
  const bad = result(input);
  expect(bad).toEqual({ status: "mismatch", reason: "identity-mismatch" });
  expect(JSON.stringify([good, bad])).not.toContain(secret);
  expect(Object.keys(bad).sort()).toEqual(["reason", "status"]);
});
