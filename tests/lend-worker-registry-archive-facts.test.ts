/** Canonical files and process observations are synthetic; these checks never read the machine's processes or credentials. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityPath, readActivity } from "../src/lib/agent-supervisor-activity.js";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { workerArchiveFactsProblem, workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { readCanonicalWorkerExit, workerArchiveExitProblem, type CanonicalExitReaders, type WorkerExitEvidence } from "../src/lib/lend-worker-registry-archive-facts.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const f of clean.splice(0).reverse()) f(); });
function fixture(family: "codex" | "claude" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "lend-exit-facts-")), db = openLendJournal(join(root, "journal.sqlite"));
  clean.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  recordAsked(db, { orderId: "exit-o", peer: "A", fp: "synthetic", family, preview: {} });
  advance(db, "exit-o", "asked", "claimed", { leaseGen: 3 });
  advance(db, "exit-o", "claimed", "cloned", { dir: root, agent: workerName("exit-o") });
  advance(db, "exit-o", "cloned", "started", { sessionId: "exit-session", startedAt: 1000 });
  const row = advance(db, "exit-o", "started", "cancelled", { settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(row)!;
  const path = activityPath(id.agent, root);
  writeFileSync(path, JSON.stringify({ v: 1, agent: id.agent, sessionId: id.sessionId, hostPid: 1234,
    busy: false, turnAt: 1100, updateAt: 1200, writtenAt: 1300 }), { mode: 0o600 });
  const evidence = (): WorkerExitEvidence => ({ source: "canonical-acp-activity", activity: readActivity(id.agent, root),
    observed: { identity: id, hostPid: 1234, processStartedAt: 900, at: 1400 },
    process: { outcome: "ESRCH", startedAt: null, reused: false }, checkedAt: 1500 });
  const info = { kind: "worker", status: "stopped", cwd: root, runtime: "codex", sessionId: id.sessionId };
  const facts = { identity: id, journalAuthenticated: true, workerExited: true, preservationComplete: true,
    protected: false, pendingResult: false, exitEvidence: evidence() };
  return { root, db, row, id, path, evidence, info, facts };
}

test("a canonical activity file, exact generation and previously known host start can support strict ESRCH", () => {
  const f = fixture();
  expect(workerArchiveExitProblem(getOrder(f.db, f.id.orderId)!, f.evidence())).toBeNull();
  expect(workerArchiveFactsProblem(f.id, f.row, f.info, f.facts)).toBeNull();
});

test.each(["no-window", "kill-ok", "EPERM", "unknown-error", "running", "reused", "unknown-reuse", "unknown-process-start"])
  ("%s cannot turn workerExited=true into an independently proved exit", (kind) => {
    const f = fixture(), e = f.evidence();
    if (kind === "reused") e.process = { outcome: "running", startedAt: 1450, reused: true };
    else if (kind === "unknown-reuse") e.process.reused = null;
    else if (kind === "unknown-process-start") e.observed!.processStartedAt = null;
    else e.process.outcome = kind === "running" ? "running" : "unknown";
    expect(workerArchiveExitProblem(f.row, e)).not.toBeNull();
    expect(workerArchiveFactsProblem(f.id, f.row, f.info, { ...f.facts, exitEvidence: e })).not.toBeNull();
  });

test.each(["missing", "corrupt", "replacement", "generation", "pid", "busy", "untrusted", "missing-observation"])
  ("%s activity/observation is retained, including after reopening the real journal", (kind) => {
    const f = fixture(), e = f.evidence();
    if (kind === "missing") { rmSync(f.path); e.activity = readActivity(f.id.agent, f.root); }
    else if (kind === "corrupt") { writeFileSync(f.path, "{broken"); e.activity = readActivity(f.id.agent, f.root); }
    else if (kind === "replacement") e.activity!.sessionId = "new-session";
    else if (kind === "generation") e.observed!.identity = { ...f.id, leaseGen: 4 };
    else if (kind === "pid") e.activity!.hostPid = 4321;
    else if (kind === "busy") e.activity!.busy = true;
    else if (kind === "untrusted") e.source = null;
    else e.observed = null;
    expect(workerArchiveExitProblem(f.row, e)).not.toBeNull();
    f.db.close();
    const reopened = openLendJournal(join(f.root, "journal.sqlite"));
    try { expect(workerArchiveExitProblem(getOrder(reopened, f.id.orderId)!, e)).not.toBeNull(); }
    finally { reopened.close(); }
  });

test("bad time relationships and an inconsistent process start refuse retirement", () => {
  const f = fixture();
  for (const patch of [{ processStartedAt: NaN }, { processStartedAt: 1400 }, { at: 1200 }, { at: 1600 }]) {
    const e = f.evidence(); Object.assign(e.observed!, patch);
    expect(workerArchiveExitProblem(f.row, e)).not.toBeNull();
  }
  for (const patch of [{ turnAt: 999 }, { updateAt: 1000 }, { writtenAt: 1100 }, { writtenAt: f.row.updatedAt + 1 }]) {
    const e = f.evidence(); Object.assign(e.activity!, patch);
    expect(workerArchiveExitProblem(f.row, e)).not.toBeNull();
  }
  const e = f.evidence(); e.process.startedAt = 901;
  expect(workerArchiveExitProblem(f.row, e)).toContain("PID");
});

test("Claude explicitly stays blocked even with an injected Codex-shaped host observation", () => {
  const f = fixture();
  expect(workerArchiveExitProblem({ ...f.row, family: "claude" }, f.evidence())).toContain("blocked-capability");
});

function readersFor(f: ReturnType<typeof fixture>): CanonicalExitReaders {
  return { activity: (agent) => readActivity(agent, f.root), observed: () => f.evidence().observed,
    processStartedAt: () => { throw Object.assign(new Error("synthetic ESRCH"), { code: "ESRCH" }); }, now: () => 1500 };
}

test("canonical exit reader constructs evidence from a fresh exact journal row, never from worker exit flags", () => {
  const f = fixture(), result = readCanonicalWorkerExit(f.id, f.db, readersFor(f));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.evidence).toMatchObject({ source: "canonical-acp-activity", observed: { identity: f.id },
    process: { outcome: "ESRCH", reused: false } });
  expect(readCanonicalWorkerExit(f.id, f.db)).toMatchObject({ ok: false, code: "blocked-capability" });
});

test("changed generation or Claude never reaches a process reader", () => {
  const f = fixture(), readers = readersFor(f), effects: string[] = [];
  readers.processStartedAt = () => { effects.push("process"); return 900; };
  patchOrder(f.db, f.id.orderId, ["cancelled"], { leaseGen: 4 });
  expect(readCanonicalWorkerExit(f.id, f.db, readers)).toMatchObject({ ok: false, code: "protected" });
  const claude = fixture("claude"), claudeReaders = readersFor(claude);
  claudeReaders.processStartedAt = readers.processStartedAt;
  expect(readCanonicalWorkerExit(claude.id, claude.db, claudeReaders)).toMatchObject({ ok: false, code: "blocked-capability" });
  expect(effects).toEqual([]);
});

test.each(["EPERM", "EIO", "no-code", "empty-process-result", "PID-reused"])("canonical %s probe is unknown/live, not dead", (kind) => {
  const f = fixture(), readers = readersFor(f);
  readers.processStartedAt = () => {
    if (kind === "empty-process-result") return null;
    if (kind === "PID-reused") return 1450;
    throw Object.assign(new Error("synthetic failed probe"), kind === "no-code" ? {} : { code: kind });
  };
  expect(readCanonicalWorkerExit(f.id, f.db, readers)).toMatchObject({ ok: false, code: "protected" });
  expect(getOrder(f.db, f.id.orderId)?.settle).toEqual({ notify: null, removeDir: false });
});

test("missing or malformed canonical sources refuse before querying any process", () => {
  const f = fixture(), readers = readersFor(f);
  let probes = 0;
  readers.processStartedAt = () => { probes++; return 900; };
  readers.observed = () => null;
  expect(readCanonicalWorkerExit(f.id, f.db, readers)).toMatchObject({ ok: false, code: "blocked-capability" });
  readers.observed = () => ({ ...f.evidence().observed!, processStartedAt: null });
  expect(readCanonicalWorkerExit(f.id, f.db, readers).ok).toBe(false);
  writeFileSync(f.path, "{broken");
  expect(readCanonicalWorkerExit(f.id, f.db, readers).ok).toBe(false);
  expect(probes).toBe(0);
});

test.each(["journal", "activity", "observation"])("late %s drift during the process probe is rejected by fresh source reads", (kind) => {
  const f = fixture(), readers = readersFor(f), observation = f.evidence().observed!;
  readers.observed = () => observation;
  readers.processStartedAt = () => {
    if (kind === "journal") patchOrder(f.db, f.id.orderId, ["cancelled"], { leaseGen: 4 });
    else if (kind === "activity") writeFileSync(f.path, JSON.stringify({ ...f.evidence().activity!, sessionId: "replacement" }));
    else observation.processStartedAt = 800;
    throw Object.assign(new Error("synthetic ESRCH"), { code: "ESRCH" });
  };
  const result = readCanonicalWorkerExit(f.id, f.db, readers);
  expect(result).toMatchObject({ ok: false, code: "protected" });
  if (result.ok) throw new Error("drifting source was accepted");
  expect(result.reason).toContain("漂移");
});
