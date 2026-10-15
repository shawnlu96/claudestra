/**
 * OBSGATE1 · per-key default mode (lib/recovery-key-defaults.ts) as recovery-policy.ts reads it: a key added after the card
 * defaults on, old keys and the high-risk classes stay observe, explicit config and the project mode keep their precedence,
 * and the gate leaves one recovery_default_on note per project + key for a key that is on only by default.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { defaultRecoveryMode, LEGACY_OBSERVE_KEYS } from "../src/lib/recovery-key-defaults.js";
import { gateRecovery, RECOVERY_KEYS, recoveryPolicy, type RecoveryKey, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

/** Not in the frozen snapshot, not high-risk: registered for these tests only (the table is the reader's own check). */
const NEW = "zzObsGateSynthetic" as RecoveryKey;
const file = (content: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "recovery-key-defaults-")), "recovery-policy.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
};
const MISSING = join(tmpdir(), "nope-recovery-key-defaults", "recovery-policy.json");

beforeAll(() => { (RECOVERY_KEYS as unknown as string[]).push(NEW); });
afterAll(() => { (RECOVERY_KEYS as unknown as string[]).splice(RECOVERY_KEYS.indexOf(NEW), 1); });

describe("defaultRecoveryMode", () => {
  test("[验收线 1] a key added after the card, not high-risk, unconfigured = on; config and project mode still win", () => {
    expect(LEGACY_OBSERVE_KEYS).not.toContain(NEW);
    expect(highRiskRecoveryKey(NEW)).toBe(false);
    expect(defaultRecoveryMode(NEW)).toBe("on");
    expect(recoveryPolicy("a", NEW, MISSING)).toEqual({ mode: "on", manualAfterMs: null, source: "default" });
    const path = file({ projects: { a: {}, off: { keys: { [NEW]: "off" } }, obs: { mode: "on", keys: { [NEW]: "observe" } },
      pm: { mode: "observe", manualStallHours: 2 }, pmOff: { mode: "off" }, pmOn: { mode: "observe", keys: { [NEW]: "on" } } } });
    expect(recoveryPolicy("a", NEW, path)).toEqual({ mode: "on", manualAfterMs: null, source: "config" });
    expect(recoveryPolicy("z", NEW, path)).toEqual({ mode: "on", manualAfterMs: null, source: "default" });
    expect(recoveryPolicy("off", NEW, path).mode).toBe("off");
    expect(recoveryPolicy("obs", NEW, path).mode).toBe("observe");
    expect(recoveryPolicy("pm", NEW, path)).toEqual({ mode: "observe", manualAfterMs: 2 * 3_600_000, source: "config" });
    expect(recoveryPolicy("pmOff", NEW, path).mode).toBe("off");
    expect(recoveryPolicy("pmOn", NEW, path).mode).toBe("on");
  });

  test("[验收线 2] high-risk keys added later observe; old keys unconfigured still observe; configured keys unchanged", () => {
    const highRisk = RECOVERY_KEYS.filter((k) => highRiskRecoveryKey(k));
    expect(highRisk.length).toBeGreaterThan(0);
    for (const k of highRisk) expect(defaultRecoveryMode(k, [])).toBe("observe"); // as if added after the card
    expect(defaultRecoveryMode("materials", [])).toBe("on"); // the same check without the snapshot: not high-risk
    expect(defaultRecoveryMode(NEW, [], () => true)).toBe("observe");
    const path = file({ projects: { a: { keys: { audit: "on" } }, b: { mode: "on" } } });
    for (const k of RECOVERY_KEYS.filter((k) => LEGACY_OBSERVE_KEYS.includes(k))) { // old keys only: later keys have their own default
      expect(recoveryPolicy("z", k, MISSING)).toEqual({ mode: "observe", manualAfterMs: null, source: "default" });
      expect(recoveryPolicy("a", k, path).mode).toBe(k === "audit" ? "on" : "observe");
      expect(recoveryPolicy("b", k, path).mode).toBe("on");
    }
  });

  test("[验收线 2] every key registered after the card defaults by its class: high-risk observe, any other on", () => {
    const later = RECOVERY_KEYS.filter((k) => !LEGACY_OBSERVE_KEYS.includes(k));
    expect(later).toContain(NEW);
    for (const k of later) {
      const want = highRiskRecoveryKey(k) ? "observe" : "on";
      expect([k, defaultRecoveryMode(k)]).toEqual([k, want]);
      expect([k, recoveryPolicy("z", k, MISSING).mode]).toEqual([k, want]);
    }
    // a future registration (another test's or a real new key) is not held to the snapshot
    const FUTURE = "zzFutureRegisteredKey" as RecoveryKey;
    (RECOVERY_KEYS as unknown as string[]).push(FUTURE);
    try {
      expect(recoveryPolicy("z", FUTURE, MISSING).mode).toBe("on");
      expect(defaultRecoveryMode(FUTURE, LEGACY_OBSERVE_KEYS, (k) => k === FUTURE)).toBe("observe");
    } finally { (RECOVERY_KEYS as unknown as string[]).splice(RECOVERY_KEYS.indexOf(FUTURE), 1); }
  });

  test("the snapshot is frozen at the 98 keys main had when the card merged (only a smaller table may follow)", () => {
    expect(LEGACY_OBSERVE_KEYS.length).toBe(98);
    expect(new Set(LEGACY_OBSERVE_KEYS).size).toBe(LEGACY_OBSERVE_KEYS.length);
    expect(Object.isFrozen(LEGACY_OBSERVE_KEYS)).toBe(true);
  });
});

describe("recovery_default_on note", () => {
  const notes = (db: ReturnType<typeof openLedger>) => listEvents(db, {}).filter((e) => e.data.op === "recovery_default_on");
  const action = (project: string, mechanism: RecoveryKey) => ({ project, mechanism, target: "", actionKey: "x", action: "试一下" });

  test("[验收线 5] first gate read of a default-on key writes one note per project + key; repeats write nothing", async () => {
    const path = tempLedgerPath("recovery-default-on-");
    let db = openLedger(path);
    const policy: RecoveryPolicyPort = (p, k) => recoveryPolicy(p, k, MISSING);
    let acted = 0;
    for (let i = 0; i < 3; i++) expect((await gateRecovery(db, action("p", NEW), () => ++acted, { now: 1000 + i, policy })).outcome).toBe("acted");
    expect(acted).toBe(3);
    expect(notes(db)).toHaveLength(1);
    expect(notes(db)[0]).toMatchObject({ project: "p", target: "", kind: "note", data: { op: "recovery_default_on", mechanism: NEW } });
    await gateRecovery(db, action("q", NEW), () => 0, { now: 2000, policy });
    expect(notes(db).map((e) => e.project).sort()).toEqual(["p", "q"]);
    closeLedger(path);
    db = openLedger(path); // a fresh connection (no memo) still dedups in the ledger
    await gateRecovery(db, action("p", NEW), () => 0, { now: 3000, policy });
    expect(notes(db)).toHaveLength(2);
    closeLedger(path);
  });

  test("a note rolled back with an outer transaction is written again on the next read (no memo inside a transaction)", async () => {
    const path = tempLedgerPath("recovery-default-on-rollback-");
    const db = openLedger(path);
    const policy: RecoveryPolicyPort = (p, k) => recoveryPolicy(p, k, MISSING);
    db.run("BEGIN");
    await gateRecovery(db, action("p", NEW), () => 0, { now: 1, policy });
    expect(notes(db)).toHaveLength(1);
    db.run("ROLLBACK");
    expect(notes(db)).toHaveLength(0);
    await gateRecovery(db, action("p", NEW), () => 0, { now: 2, policy });
    expect(notes(db)).toHaveLength(1);
    await gateRecovery(db, action("p", NEW), () => 0, { now: 3, policy });
    expect(notes(db)).toHaveLength(1);
    closeLedger(path);
  });

  test("explicit on, an old key, observe and an injected port never note", async () => {
    const path = tempLedgerPath("recovery-default-on-none-");
    const db = openLedger(path);
    const cfg = file({ projects: { on: { keys: { [NEW]: "on" } }, pm: { mode: "on" }, obs: { mode: "observe" } } });
    for (const p of ["on", "pm", "obs"]) await gateRecovery(db, action(p, NEW), () => 0, { now: 1, policy: (pp, k) => recoveryPolicy(pp, k, cfg) });
    await gateRecovery(db, action("old", "materials"), () => 0, { now: 1, policy: (p, k) => recoveryPolicy(p, k, MISSING) });
    await gateRecovery(db, action("fake", NEW), () => 0, { now: 1, policy: () => ({ mode: "on", manualAfterMs: null, source: "default" }) });
    expect(notes(db)).toHaveLength(0);
    closeLedger(path);
  });
});
