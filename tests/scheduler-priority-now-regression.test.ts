import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger, closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { recordPriorityNow } from "../src/lib/scheduler-priority-now-record.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";

let db: Database;
const project = "prio", pm = "agent-pm", id = "ab12-work";
const evidence = { ownerWords: "now", ownerAt: 1000, sourceRef: "test:owner" };
const spec = { mtimeMs: 0, text: "# task\n模板:code\n\n## Goal\n" };
const svc = { autoDispatch: true, projects: [project], maxWorkers: () => 3 };
function mode(value: "on" | "observe", rev = 0) {
  setPriorityMode(db, { actor: pm, project, dedupKey: crypto.randomUUID() },
    { mechanism: "priorityNowStart", mode: value, rev, evidence });
}
beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
  createFeature(db, { actor: pm }, { project, slug: "work", title: "work" });
  initDag(db, { actor: pm }, { id, rev: 1, nodes: [
    { key: "a", oneLine: "now", fileGlobs: ["src/a.ts"] }, { key: "b", oneLine: "next", fileGlobs: ["src/b.ts"] },
    { key: "c", oneLine: "blocked now", deps: ["a"], fileGlobs: ["src/c.ts"] },
  ] });
  setAutostartSwitch(db, { actor: pm }, { project, featureId: id, on: true, reason: "test" });
  for (const key of ["a", "c"]) setPriority(db, { actor: pm, project, dedupKey: key },
    { target: { kind: "node", id, nodeKey: key }, band: "now", rev: 0, evidence });
  mode("on");
});
afterEach(() => closeLedger(":memory:"));
function env(claims: string[], failRecord = false): StartTickEnv {
  return {
    db, svc, now: Date.now, readSpec: () => spec, memo: new Set(), attempt: () => "test", notifyPm: async () => {},
    ledger: async (...args) => {
      if (args[1] === "scheduler-priority-now") {
        if (failRecord) throw new Error("waiting writer offline");
        return recordPriorityNow(db, { actor: "scheduler" }, project, id, JSON.parse(args[args.indexOf("--data") + 1]), svc);
      }
      if (args[2] === "claim") { claims.push(args[4]); return { ok: false, code: "denied", error: "test claim refused" }; }
      return { ok: true };
    },
    plain: async () => ({ ok: true }), quota: async () => ({ status: "unknown", source: null, observedAt: 0, plan: null, reason: "test", windows: [] }),
    startEnv: () => ({ ledgerDir: "/test/ledger", worktreeRoot: "/test/worktrees", projectDirs: async () => [], agentNames: () => [],
      exists: () => false, branchExists: async () => false, autoReady: () => null, template: () => null }),
    stepIO: () => { throw new Error("a refused claim must not execute"); },
  };
}

test("failed now claim is attempted once, then ordinary next is selected in the same tick", async () => {
  const claims: string[] = [];
  const base = env(claims);
  let preflights = 0;
  const failed = await autostartTick({ ...base, startEnv: () => { preflights++; return base.startEnv(); } });
  expect(preflights).toBe(2);
  expect(claims).toEqual(["a", "b"]);
  expect(failed.filter((f) => f.taskId === `${id}/a`)).toHaveLength(1);
  await autostartTick(base);
  expect(claims).toEqual(["a", "b", "a", "b"]);
});

test("waiting record failures are reported and ordinary/now starts still run", async () => {
  const claims: string[] = [];
  const failed = await autostartTick(env(claims, true));
  expect(claims).toEqual(["a", "b"]);
  expect(failed.some((f) => f.error.includes("waiting writer offline"))).toBe(true);
});

test("observe labels blocked nodes as would wait", () => {
  mode("observe", 1);
  recordPriorityNow(db, { actor: "scheduler" }, project, id, { key: "c" }, svc);
  expect(listEvents(db).findLast((e) => e.data.namespace === "priority-now")?.text).toStartWith("本会等待：");
});

test("waiting observations batch a feature and do not spawn writers for unchanged records", async () => {
  mode("observe", 1);
  const base = { ...env([]), readSpec: () => null }, calls: string[][] = [];
  const tick = { ...base, ledger: async (...args: string[]) => { calls.push(args); return base.ledger(...args); } };
  await autostartTick(tick);
  expect(calls.filter((args) => args[1] === "scheduler-priority-now")).toHaveLength(1);
  calls.length = 0;
  await autostartTick(tick);
  expect(calls.filter((args) => args[1] === "scheduler-priority-now")).toHaveLength(0);
});
