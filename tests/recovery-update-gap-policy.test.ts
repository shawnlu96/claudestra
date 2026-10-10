/**
 * UGCFG: updateGap is a registered recovery key (lib/recovery-policy.ts) and nothing else changes. Absent config = observe,
 * on / off / inherit through the audited setter, bad values still stop, and the keys registered before it keep their order.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import {
  decideRecovery, observeDedupKey, RECOVERY_KEYS, recoveryPolicies, recoveryPolicy, setRecovery,
  type RecoveryKey, type RecoveryPolicy,
} from "../src/lib/recovery-policy.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PRIOR_KEYS: RecoveryKey[] = ["materials", "localFallback", "localDelivery", "modelOutcome", "askReminder", "manualStall", "planGap", "audit", "placementReservations"];
const DEFAULT: RecoveryPolicy = { mode: "observe", manualAfterMs: null, source: "default" };
const dir = () => mkdtempSync(join(tmpdir(), "recovery-update-gap-"));
const file = (content: unknown) => {
  const path = join(dir(), "recovery-policy.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

describe("updateGap recovery key", () => {
  test("registered exactly once, after every prior key, which keep their order", () => {
    expect([...RECOVERY_KEYS]).toEqual([...PRIOR_KEYS, "manualMergeQueue", "updateGap", "lendConfigFailure", "mainCarry", "lockYield", "authorRebuild",
      "uiCarry", "uiReviewCarry", "uiDelivery", "ciKnownFlaky", "nearMarker", "auditTrainQueue", "auditIdleFacts", "auditMirrorPush", "auditStall"]);
    expect(RECOVERY_KEYS.filter((k) => k === "updateGap")).toHaveLength(1);
    expect(observeDedupKey({ project: "a", mechanism: "updateGap", target: "", actionKey: "drain" })).toContain("updateGap");
  });

  test("missing file / missing project / empty entry = observe (never guessed on); decision is observe", () => {
    const none = join(dir(), "absent.json");
    expect(recoveryPolicy("a", "updateGap", none)).toEqual(DEFAULT);
    expect(recoveryPolicy("b", "updateGap", file({ projects: { a: { mode: "on" } } }))).toEqual(DEFAULT);
    expect(recoveryPolicy("c", "updateGap", file({ projects: { c: {} } })).mode).toBe("observe");
    expect(decideRecovery(recoveryPolicy("a", "updateGap", none))).toEqual({ kind: "observe" });
    expect(recoveryPolicies("a", none).updateGap).toEqual(DEFAULT);
  });

  test("inherits project mode, takes its own on / off override without touching other keys", () => {
    const path = file({ projects: { a: { mode: "on" }, b: { keys: { updateGap: "on" } }, c: { mode: "on", keys: { updateGap: "off" } } } });
    expect(recoveryPolicy("a", "updateGap", path)).toEqual({ mode: "on", manualAfterMs: null, source: "config" });
    expect([recoveryPolicy("b", "updateGap", path).mode, recoveryPolicy("b", "planGap", path).mode]).toEqual(["on", "observe"]);
    expect([recoveryPolicy("c", "updateGap", path).mode, recoveryPolicy("c", "audit", path).mode]).toEqual(["off", "on"]);
    expect(decideRecovery(recoveryPolicy("c", "updateGap", path)).kind).toBe("skip");
  });

  test("bad updateGap value or unreadable file → off with a diagnostic, for updateGap and prior keys alike", () => {
    const bad = file({ projects: { a: { keys: { updateGap: "yes" } } } });
    for (const k of ["updateGap", "materials"] as const) expect(recoveryPolicy("a", k, bad)).toMatchObject({ mode: "off", source: "error" });
    expect(recoveryPolicy("a", "updateGap", file("{not json"))).toMatchObject({ mode: "off", source: "error" });
  });

  test("audited setter: PM sets updateGap on / off / inherit; other keys' values unchanged", async () => {
    const db = openLedger(tempLedgerPath("recovery-update-gap-db-"));
    setMeta(db, { actor: "owner", now: 1 }, { project: "a", key: "pms", value: ["agent-pm-a"] });
    const path = file({ projects: { a: { keys: { planGap: "off" } } } });
    const ctx = { actor: "agent-pm-a", now: 2 };
    await setRecovery(db, ctx, { project: "a", set: { key: "updateGap", mode: "on" }, reason: "开" }, { path });
    expect(recoveryPolicy("a", "updateGap", path).mode).toBe("on");
    await setRecovery(db, ctx, { project: "a", set: { key: "updateGap", mode: "off" }, reason: "关" }, { path });
    expect(recoveryPolicy("a", "updateGap", path).mode).toBe("off");
    await setRecovery(db, ctx, { project: "a", set: { key: "updateGap", mode: "inherit" }, reason: "撤" }, { path });
    expect(recoveryPolicy("a", "updateGap", path).mode).toBe("observe");
    expect(JSON.parse(readFileSync(path, "utf8")).projects.a.keys).toEqual({ planGap: "off" });
    for (const k of PRIOR_KEYS) expect(recoveryPolicy("a", k, path).mode).toBe(k === "planGap" ? "off" : "observe");
    db.close();
  });
});
