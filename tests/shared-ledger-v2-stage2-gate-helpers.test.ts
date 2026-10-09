import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow, planIntent } from "../src/lib/ledger-scheduler-write.js";
import type { SharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { withExecutorScope, type ExecutorFence } from "../src/lib/shared-ledger-v2-write-gate.js";

export const execution: SharedLedgerMode = { authorityMode: "execution", sharedPlanning: true,
  centerExecution: { centerId: "center", teamId: "team", projectId: "cp", centerFeatureId: "cf", epoch: 1 } };
export const firstFence: ExecutorFence = { serviceGeneration: 1, epoch: 1, bootId: "boot-1", leaseId: "lease-1" };
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "s2g-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const owner = { actor: "owner", now: 100 }, scheduler = { actor: "scheduler", now: 200 };
  createTask(db, owner, { project: "p", id: "T", title: "card", kind: "code", agent: "agent-one", extra: { sharedFeatureId: "F" } });
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: { "agent-one": { runtime: "claude-code" } } }));
  const setMode = (m: SharedLedgerMode, featureId = "F") => writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { [featureId]: m } }));
  const stage = (value: string) => db.query("UPDATE tasks SET stage=? WHERE id='T'").run(value);
  const workflow = () => setWorkflow(db, owner, { taskId: "T", taskRev: getTask(db, "T")!.rev,
    template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "hold" });
  const seq = () => (db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const scope = <T>(fn: () => T, fence: ExecutorFence | null = firstFence, claimFence: ExecutorFence | null = null) =>
    withExecutorScope(db, { featureId: "F", taskId: "T", fence: fence!, claimFence,
      leaseIdOf: value => (value as ExecutorFence).leaseId }, fn);
  const plan = (id = "ensure") => planIntent(db, scheduler, { id, taskId: "T", taskRev: getTask(db, "T")!.rev,
    workflowRev: 1, causalSeq: seq(), node: "restate", action: "ensure_session", reason: "create session", resources: ["task:t"] });
  const bind = { taskId: "T", role: "author" as const, intentId: "ensure", agent: "agent-one", sessionId: "session-one",
    family: "claude" as const, transport: "acp" as const, registryPath };
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, db, owner, scheduler, setMode, stage, workflow, scope, plan, bind, close };
}
export type Fixture = ReturnType<typeof fixture>;
export function snapshot(f: Fixture): unknown {
  const tables = f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, f.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
export function rejected(f: Fixture, fn: () => unknown, code = "forbidden"): void {
  const before = snapshot(f);
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
  expect(snapshot(f)).toEqual(before);
}
