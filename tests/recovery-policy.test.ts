/**
 * dispatch-recovery-CFG: the one recovery policy (lib/recovery-policy.ts). Defaults, per-key overrides, unknown keys and bad
 * files answering off, the decision table for on / observe / off × manual-stall threshold, observe dedup (also across
 * concurrent processes) and the gate with an injected policy port.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import {
  decideRecovery, gateRecovery, observedRecent, observeDedupKey, RECOVERY_KEYS, recordObserved, recoveryPolicy,
  type ObservedAction, type RecoveryDecision, type RecoveryKey, type RecoveryPolicy, type RecoveryPolicyPort,
} from "../src/lib/recovery-policy.js";
import { appendEvent, createItem } from "../src/lib/ledger-write.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const H = 3_600_000;
const file = (content: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "recovery-policy-")), "recovery-policy.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};
const DEFAULT: RecoveryPolicy = { mode: "observe", manualAfterMs: null, source: "default" };

describe("recoveryPolicy(project, key): reading the file", () => {
  test("missing file / missing project = observe, manualAfterMs null, for every key (old installs need nothing)", () => {
    const none = join(tmpdir(), "nope-recovery", "x.json"), other = file({ projects: { a: { mode: "on" } } });
    for (const k of RECOVERY_KEYS) {
      expect(recoveryPolicy("a", k, none)).toEqual(DEFAULT);
      expect(recoveryPolicy("b", k, other)).toEqual(DEFAULT);
    }
    expect(recoveryPolicy("constructor", "audit", other)).toEqual(DEFAULT); // no prototype keys read as projects
  });

  test("project mode, per-key override, hours → ms; an empty entry still defaults to observe", () => {
    const path = file({ projects: { a: { mode: "on", manualStallHours: 6, keys: { planGap: "off", audit: "observe" } }, b: { keys: { materials: "on" } }, c: {} } });
    expect(recoveryPolicy("a", "materials", path)).toEqual({ mode: "on", manualAfterMs: 6 * H, source: "config" });
    expect(recoveryPolicy("a", "planGap", path)).toEqual({ mode: "off", manualAfterMs: 6 * H, source: "config" });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("observe");
    expect([recoveryPolicy("b", "materials", path).mode, recoveryPolicy("b", "askReminder", path).mode]).toEqual(["on", "observe"]);
    expect(recoveryPolicy("c", "manualStall", path)).toEqual({ mode: "observe", manualAfterMs: null, source: "config" });
  });

  test("placementReservations (PLACE): registered key; inherits the project mode, takes an override, bad override value → off", () => {
    expect(RECOVERY_KEYS).toContain("placementReservations");
    const path = file({ projects: { a: { mode: "on" }, b: { mode: "on", keys: { placementReservations: "off" } } } });
    expect(recoveryPolicy("a", "placementReservations", path)).toEqual({ mode: "on", manualAfterMs: null, source: "config" });
    expect([recoveryPolicy("b", "placementReservations", path).mode, recoveryPolicy("b", "audit", path).mode]).toEqual(["off", "on"]);
    expect(recoveryPolicy("z", "placementReservations", path)).toEqual(DEFAULT);
    expect(recoveryPolicy("a", "placementReservations", file({ projects: { a: { keys: { placementReservations: "yes" } } } })).source).toBe("error");
  });

  test("rev (the publishing audit's seq) is bookkeeping only: readers ignore it, a non-positive-integer rev makes the file invalid", () => {
    expect(recoveryPolicy("a", "audit", file({ projects: { a: { mode: "on", rev: 7 } } }))).toEqual({ mode: "on", manualAfterMs: null, source: "config" });
    expect(recoveryPolicy("a", "audit", file({ projects: { a: { rev: 7 } } }))).toEqual({ mode: "observe", manualAfterMs: null, source: "config" });
    for (const rev of [0, -1, 1.5, "7"]) expect(recoveryPolicy("a", "audit", file({ projects: { a: { mode: "on", rev } } })).source).toBe("error");
  });

  test("unknown key → off with a diagnostic, even when the file says on", () => {
    const r = recoveryPolicy("a", "nudge" as RecoveryKey, file({ projects: { a: { mode: "on" } } }));
    expect(r).toMatchObject({ mode: "off", manualAfterMs: null, source: "error", diagnostic: expect.stringContaining("未知恢复键") });
  });

  const BAD: [string, unknown][] = [
    ["not json", "{oops"], ["array top", []], ["no projects", {}], ["unknown top key", { projects: {}, extra: 1 }],
    ["unknown project key", { projects: { a: { mode: "on", stuck: 1 } } }], ["bad mode", { projects: { a: { mode: "ON" } } }],
    ["hours 0", { projects: { a: { manualStallHours: 0 } } }], ["hours fraction", { projects: { a: { manualStallHours: 1.5 } } }],
    ["hours too big", { projects: { a: { manualStallHours: 721 } } }], ["hours string", { projects: { a: { manualStallHours: "6" } } }],
    ["unknown key name", { projects: { a: { keys: { nudge: "on" } } } }], ["bad key mode", { projects: { a: { keys: { audit: "inherit" } } } }],
    ["keys array", { projects: { a: { keys: [] } } }],
  ];
  for (const [name, content] of BAD) {
    test(`bad file (${name}) → off with diagnostic, for every project and key`, () => {
      const path = file(content);
      for (const p of ["a", "z"]) for (const k of ["materials", "manualStall"] as const) {
        const r = recoveryPolicy(p, k, path);
        expect([r.mode, r.source, r.manualAfterMs]).toEqual(["off", "error", null]);
        expect(decideRecovery(r)).toMatchObject({ kind: "skip", reason: expect.stringContaining("读不了") });
      }
    });
  }
});

describe("decideRecovery: table", () => {
  const pol = (mode: RecoveryPolicy["mode"], hours: number | null): RecoveryPolicy => ({ mode, manualAfterMs: hours === null ? null : hours * H, source: "config" });
  const ROWS: [RecoveryPolicy["mode"], number | null, number | undefined, RecoveryDecision["kind"]][] = [
    ["off", null, undefined, "skip"], ["off", 6, 100 * H, "skip"],
    ["observe", null, undefined, "observe"], ["on", null, undefined, "act"],
    // manual card: no threshold = never forced, in every mode
    ["observe", null, 999 * H, "skip"], ["on", null, 999 * H, "skip"],
    // below / at / past the owner's threshold
    ["on", 6, 6 * H - 1, "skip"], ["on", 6, 6 * H, "act"], ["observe", 6, 6 * H - 1, "skip"], ["observe", 6, 7 * H, "observe"],
  ];
  for (const [mode, hours, stalled, kind] of ROWS) {
    test(`${mode} / threshold ${hours ?? "unset"} / manual stalled ${stalled === undefined ? "-" : stalled / H + "h"} → ${kind}`, () => {
      expect(decideRecovery(pol(mode, hours), stalled === undefined ? {} : { manualStalledMs: stalled }).kind).toBe(kind);
    });
  }
});

describe("observe: dedup-able record only", () => {
  const A: ObservedAction = { project: "p", mechanism: "localFallback", target: "", actionKey: "T1:r0", action: "重派 T1 的 build" };
  const notes = (db: Database) => listEvents(db, { project: "p" }).filter((e) => e.kind === "note");

  test("same would-be action → one event; a different actionKey → a second one", () => {
    const db = openLedger(tempLedgerPath("recovery-obs-"));
    expect(recordObserved(db, A, 10).recorded).toBe(true);
    expect(recordObserved(db, A, 20).recorded).toBe(false);
    expect(recordObserved(db, { ...A, actionKey: "T1:r1" }, 30).recorded).toBe(true);
    expect(notes(db).map((e) => [e.actor, e.data.op, e.data.mechanism, e.data.actionKey])).toEqual([
      ["scheduler", "recovery_observe", "localFallback", "T1:r0"], ["scheduler", "recovery_observe", "localFallback", "T1:r1"]]);
    expect(observedRecent(db, "p", 1).map((x) => [x.mechanism, x.text])).toEqual([["localFallback", "恢复观察（localFallback）：本会 重派 T1 的 build"]]);
    expect(observedRecent(db, "q", 5)).toEqual([]);
  });

  test("project names with LIKE wildcards do not see each other's records", () => {
    const db = openLedger(tempLedgerPath("recovery-obs-like-"));
    recordObserved(db, { ...A, project: "a_b" }, 1);
    expect(observedRecent(db, "a_b", 5)).toHaveLength(1);
    expect(observedRecent(db, "a%", 5)).toEqual([]);
  });

  test("legal colon and empty-target tuples survive SQLite retries and reopen independently", () => {
    const path = tempLedgerPath("recovery-obs-collision-");
    let db = openLedger(path);
    const tuples: ObservedAction[] = [
      { ...A, project: "a", mechanism: "audit", target: "", actionKey: "-:x" },
      { ...A, project: "a", mechanism: "audit", target: "-:-", actionKey: "x" },
      { ...A, project: "a", mechanism: "audit", target: "-", actionKey: "-:x" },
      { ...A, project: "a_b", mechanism: "audit", target: "", actionKey: "-:x" },
    ];
    for (const id of ["-:-", "-"]) createItem(db, { actor: "owner", now: 0 },
      { project: "a", id, title: id, status: "doing", ownerWords: "collision fixture" });
    const seqs = tuples.map((a) => {
      const r = recordObserved(db, a, 1);
      expect(r.recorded).toBe(true);
      return r.seq;
    });
    closeLedger(path);
    db = openLedger(path);
    expect(new Set(tuples.map(observeDedupKey)).size).toBe(4);
    tuples.forEach((a, i) => expect(recordObserved(db, a, 2)).toEqual({ recorded: false, seq: seqs[i] }));
    expect(observedRecent(db, "a", 10)).toHaveLength(3);
    expect(observedRecent(db, "a_b", 10)).toHaveLength(1);
    expect(observedRecent(db, "a%", 10)).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM events WHERE kind = 'note'").get()).toEqual({ n: 4 });
    closeLedger(path);
  });

  test("legacy observations replay exact tuples while colliding tuples get new records", () => {
    const path = tempLedgerPath("recovery-obs-legacy-");
    let db = openLedger(path);
    const a = { ...A, project: "a", mechanism: "audit" as const, target: "", actionKey: "-:x" };
    const old = appendEvent(db, { actor: "scheduler", now: 1, dedupKey: "recovery-observe:a:audit:-:-:x" },
      { project: "a", target: "", kind: "note", text: "legacy", data: { op: "recovery_observe", mechanism: "audit", actionKey: "-:x" } });
    expect(recordObserved(db, a, 2)).toEqual({ recorded: false, seq: old.event.seq });
    createItem(db, { actor: "owner", now: 0 },
      { project: "a", id: "-:-", title: "target", status: "doing", ownerWords: "collision fixture" });
    const b = { ...a, target: "-:-", actionKey: "x" };
    expect(recordObserved(db, b, 3).recorded).toBe(true);
    closeLedger(path);
    db = openLedger(path);
    expect(recordObserved(db, a, 4)).toEqual({ recorded: false, seq: old.event.seq });
    expect(recordObserved(db, b, 5).recorded).toBe(false);
    expect(observedRecent(db, "a", 10).map((e) => e.target)).toEqual(["-:-", ""]);
    expect(observedRecent(db, "a%", 10)).toEqual([]);
    expect(db.query("SELECT text FROM events WHERE seq = ?").get(old.event.seq)).toEqual({ text: "legacy" });
    closeLedger(path);
  });

  test("unknown key / bad actionKey / bad target are refused, nothing written", () => {
    const db = openLedger(tempLedgerPath("recovery-obs-bad-"));
    for (const bad of [{ mechanism: "nudge" as RecoveryKey }, { actionKey: "" }, { actionKey: "a b" }, { actionKey: "x".repeat(121) }, { target: "T 1" }]) {
      expect(() => recordObserved(db, { ...A, ...bad }, 1)).toThrow();
    }
    expect(notes(db)).toEqual([]);
    expect(observeDedupKey(A)).toBe('recovery-observe-v2:["p","localFallback","","T1:r0"]');
  });

  test("concurrent processes recording the same action leave exactly one event", async () => {
    const path = tempLedgerPath("recovery-obs-race-");
    openLedger(path);
    const script = join(mkdtempSync(join(tmpdir(), "recovery-race-")), "race.ts");
    writeFileSync(script, `import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-store.ts"))};
import { recordObserved } from ${JSON.stringify(join(import.meta.dir, "../src/lib/recovery-policy.ts"))};
console.log(JSON.stringify(recordObserved(openLedger(process.argv[2]), ${JSON.stringify(A)}, Date.now())));`);
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "--no-env-file", script, path], { stdout: "pipe", stderr: "pipe", env: process.env }));
    const outs = await Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as { recorded: boolean }));
    expect(outs.filter((o) => o.recorded)).toHaveLength(1);
    expect(notes(openLedger(path))).toHaveLength(1);
  }, 30_000);
});

describe("gateRecovery: the wrapper every mechanism uses", () => {
  const A: ObservedAction = { project: "p", mechanism: "planGap", target: "", actionKey: "T9", action: "重派 T9" };
  const port = (mode: RecoveryPolicy["mode"], manualAfterMs: number | null = null): RecoveryPolicyPort => () => ({ mode, manualAfterMs, source: "config" });
  for (const [mode, outcome, acts, events] of [["on", "acted", 1, 0], ["observe", "observed", 0, 1], ["off", "skipped", 0, 0]] as const) {
    test(`${mode}: ${outcome}, act called ${acts}× per call, ${events} observe event across two calls`, async () => {
      const db = openLedger(tempLedgerPath("recovery-gate-"));
      let called = 0;
      const act = () => { called++; return "done"; };
      const r1 = await gateRecovery(db, A, act, { now: 1, policy: port(mode) });
      const r2 = await gateRecovery(db, A, act, { now: 2, policy: port(mode) });
      expect(r1.outcome).toBe(outcome);
      if (mode === "observe") expect([r1, r2]).toEqual([{ outcome: "observed", recorded: true }, { outcome: "observed", recorded: false }]);
      expect(called).toBe(acts * 2);
      expect(listEvents(db, { project: "p" }).filter((e) => e.kind === "note")).toHaveLength(events);
    });
  }

  test("the port is asked (project, mechanism); file-backed policy is re-read each call (corrupt → stop)", async () => {
    const db = openLedger(tempLedgerPath("recovery-gate-file-"));
    const asked: string[] = [];
    await gateRecovery(db, A, () => 0, { now: 1, policy: (p, k) => { asked.push(`${p}/${k}`); return { mode: "off", manualAfterMs: null, source: "config" }; } });
    expect(asked).toEqual(["p/planGap"]);
    const path = file({ projects: { p: { mode: "on" } } });
    const fromFile: RecoveryPolicyPort = (p, k) => recoveryPolicy(p, k, path);
    let called = 0;
    expect((await gateRecovery(db, A, () => ++called, { now: 1, policy: fromFile })).outcome).toBe("acted");
    writeFileSync(path, "{broken");
    expect(await gateRecovery(db, A, () => ++called, { now: 2, policy: fromFile })).toMatchObject({ outcome: "skipped" });
    expect(called).toBe(1);
  });

  test("manual card without the owner threshold is never acted on, even under on", async () => {
    const db = openLedger(tempLedgerPath("recovery-gate-manual-"));
    let called = 0;
    const r = await gateRecovery(db, { ...A, mechanism: "manualStall", manualStalledMs: 500 * H }, () => ++called, { now: 1, policy: port("on") });
    expect(r).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("manualStallHours") });
    expect((await gateRecovery(db, { ...A, mechanism: "manualStall", manualStalledMs: 500 * H }, () => ++called, { now: 1, policy: port("on", 6 * H) })).outcome).toBe("acted");
    expect(called).toBe(1);
  });
});
