import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { ledgerGate, type ServiceFacts } from "../src/lib/scheduler-autostart.js";

let db: Database;
const project = "prio", id = "ab12-work", pm = "agent-pm";
const evidence = { ownerWords: "现在做", ownerAt: 1000, sourceRef: "test:owner" };
const svc: ServiceFacts = { autoDispatch: true, projects: [project], maxWorkers: () => 3, capacity: () => null };
beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
  createFeature(db, { actor: pm }, { project, slug: "work", title: "work" });
  initDag(db, { actor: pm }, { id, rev: 1, nodes: [{ key: "a", oneLine: "a", fileGlobs: ["src/a.ts"] }] });
  setAutostartSwitch(db, { actor: pm }, { project, featureId: id, on: false, reason: "manual" });
  setPriority(db, { actor: pm, project, dedupKey: "now" }, { target: { kind: "node", id, nodeKey: "a" }, band: "now", rev: 0, evidence });
  setPriorityMode(db, { actor: pm, project, dedupKey: "mode" }, { mechanism: "priorityNowStart", mode: "on", rev: 0, evidence });
});
afterEach(() => closeLedger(":memory:"));

test("now on ignores feature autostart off in the claim's shared gate", () => {
  expect(ledgerGate(db, getFeature(db, id)!, "a", svc)).toBeNull();
});

test("off and observe retain old gate; next/later never inherit the feature override", () => {
  for (const [index, mode] of ["off", "observe", "on"].entries()) {
    setPriorityMode(db, { actor: pm, project, dedupKey: `m${index}` },
      { mechanism: "priorityNowStart", mode: mode as "off" | "observe" | "on", rev: index + 1, evidence });
    const gate = ledgerGate(db, getFeature(db, id)!, "a", svc);
    expect(gate?.gate ?? null).toBe(mode === "on" ? null : "switch");
  }
  for (const [index, band] of ["next", "later"].entries()) {
    setPriority(db, { actor: pm, project, dedupKey: `b${index}` },
      { target: { kind: "node", id, nodeKey: "a" }, band: band as "next" | "later", rev: index + 1, evidence });
    expect(ledgerGate(db, getFeature(db, id)!, "a", svc)?.gate).toBe("switch");
  }
});

test("now preserves project/service, freeze, no PM, capacity, dependency and spec gates", async () => {
  const { setFrozen, setMeta } = await import("../src/lib/ledger-write.js");
  const { pickPriorityNow } = await import("../src/lib/scheduler-priority-now-tick.js");
  const { claimNode } = await import("../src/lib/ledger-autostart.js");
  const { nodeCandidate, currentViews } = await import("../src/lib/scheduler-autostart.js");
  const { featureLanes } = await import("../src/lib/dag-tools-lanes.js");
  const f = getFeature(db, id)!;
  expect(ledgerGate(db, f, "a", { ...svc, autoDispatch: false })?.gate).toBe("service");
  expect(ledgerGate(db, f, "a", { ...svc, capacity: () => "no capacity" })).toEqual({ gate: "capacity", why: "no capacity" });
  const missing = nodeCandidate(db, f, "a", featureLanes(db, f), currentViews(db, f), () => null, Date.now());
  expect(missing).toMatchObject({ gate: "spec" });
  setFrozen(db, { actor: pm }, { project, frozen: true, reason: "freeze" });
  expect(ledgerGate(db, f, "a", svc)?.gate).toBe("frozen");
  setFrozen(db, { actor: pm }, { project, frozen: false, reason: "resolved" });
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [] });
  expect(ledgerGate(db, f, "a", svc)?.gate).toBe("no_pm");
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
  const candidate = pickPriorityNow({ db, svc, now: Date.now,
    readSpec: () => ({ mtimeMs: 0, text: "# Task\n模板:code\n" }) });
  expect(candidate?.cand.key).toBe("a");
  // The project stop arrives after the candidate read. The transaction must reject without recording a claim.
  setAutostartSwitch(db, { actor: pm }, { project, on: false, reason: "owner stopped" });
  expect(() => claimNode(db, { actor: "scheduler" }, { featureId: id, key: "a", arm: candidate!.cand.arm, template: "code", svc })).toThrow("项目的自动开卡关着");
  expect(() => claimNode(db, { actor: "worker" }, { featureId: id, key: "a", arm: candidate!.cand.arm, template: "code", svc })).toThrow("只有调度服务");
});
