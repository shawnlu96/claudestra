import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked, type LendRow } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { archiveHash, workerArchiveIdentity, workerArchiveProblem, workerArchiveFactsProblem, type WorkerArchiveRecord } from "../src/lib/lend-worker-registry-archive.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
function fixture() {
  const db = openLendJournal(join(root, `${seq++}.sqlite`));
  recordAsked(db, { orderId: "o1", peer: "A", fp: "fingerprint", family: "codex", preview: {} });
  advance(db, "o1", "asked", "claimed", { leaseGen: 3 });
  advance(db, "o1", "claimed", "cloned", { dir: "/clone", agent: workerName("o1") });
  advance(db, "o1", "cloned", "started", { sessionId: "session-1" });
  const payload = { orderId: "o1", gen: 3, session: { id: "session-1" }, verdict: "pass" };
  const payloadSha = archiveHash(JSON.stringify(payload));
  advance(db, "o1", "started", "result_pending", { payload, payloadSha });
  const row = advance(db, "o1", "result_pending", "acked", { receipt: { orderId: "o1", sha256: payloadSha }, settle: { notify: null, removeDir: false } });
  const info: WorkerArchiveRecord = { sessionId: "session-1", cwd: "/clone", runtime: "codex", status: "stopped", kind: "worker" };
  return { db, row, info, id: workerArchiveIdentity(row)! };
}

describe("B journal exact retirement eligibility", () => {
  test("real journal persists a verified ack across reopening", () => {
    const f = fixture();
    expect(workerArchiveProblem(f.id, getOrder(f.db, "o1"), f.info)).toBeNull();
    const path = f.db.filename;
    f.db.close();
    const reopened = openLendJournal(path);
    expect(workerArchiveProblem(f.id, getOrder(reopened, "o1"), f.info)).toBeNull();
    reopened.close();
  });

  test.each(["started", "result_pending", "stopped", "declined", "unknown", "done"])("retains state %s", (state) => {
    const f = fixture();
    expect(workerArchiveProblem(f.id, { ...f.row, state } as LendRow, f.info)).not.toBeNull();
    f.db.close();
  });

  test("protects ordinary agents, active/unknown workers and replacements", () => {
    const f = fixture();
    for (const patch of [{ kind: "main" }, { kind: undefined }, { role: "pm" }, { status: "active" }, { status: undefined },
      { sessionId: "replacement" }, { cwd: "/other" }, { pending: { op: "restart" } }, { runtime: "pi" }]) {
      expect(workerArchiveProblem(f.id, f.row, { ...f.info, ...patch })).not.toBeNull();
    }
    for (const patch of [{ leaseGen: 4 }, { agent: "agent-master" }, { agent: "agent-ordinary" }, { sessionId: "replacement" },
      { receipt: null }, { payloadSha: "bad" }, { settle: { notify: null, removeDir: true } }]) {
      expect(workerArchiveProblem(f.id, { ...f.row, ...patch }, f.info)).not.toBeNull();
    }
    f.db.close();
  });

  test("cancelled/released only qualify without outstanding results", () => {
    const f = fixture();
    for (const state of ["cancelled", "released"] as const) {
      expect(workerArchiveProblem(f.id, { ...f.row, state }, f.info)).not.toBeNull();
      expect(workerArchiveProblem(f.id, { ...f.row, state, payload: null, payloadSha: null, work: null }, f.info)).toBeNull();
    }
    f.db.close();
  });

  test("fresh journal reread rejects late result or changed claim generation", () => {
    const f = fixture();
    patchOrder(f.db, "o1", ["acked"], { leaseGen: 4 });
    expect(workerArchiveProblem(f.id, getOrder(f.db, "o1"), f.info)).not.toBeNull();
    patchOrder(f.db, "o1", ["acked"], { leaseGen: 3, payload: { late: true } });
    expect(workerArchiveProblem(f.id, getOrder(f.db, "o1"), f.info)).not.toBeNull();
    f.db.close();
  });
});

test("an acknowledged write still protects a later unacknowledged artifact", () => {
  const f = fixture();
  const work = { head: "commit-a", summary: "summary", selfCheck: "checks" };
  const payload = { ...f.row.payload, deliver: { ...work, orderId: f.id.orderId } };
  const payloadSha = archiveHash(JSON.stringify(payload));
  const row = { ...f.row, payload, payloadSha, work, receipt: { orderId: f.id.orderId, sha256: payloadSha } };
  expect(workerArchiveProblem(f.id, row, f.info)).toBeNull();
  expect(workerArchiveProblem(f.id, { ...row, work: { ...work, head: "later-commit" } }, f.info)).toContain("未确认");
  f.db.close();
});

test("canonical facts protect PM, frozen cards, other live tasks and every unknown exit/authentication/preservation/result fact", () => {
  const f = fixture();
  try {
    const facts = { identity: f.id, journalAuthenticated: true, workerExited: true, preservationComplete: true, protected: false, pendingResult: false };
    expect(workerArchiveFactsProblem(f.id, f.row, f.info, facts)).toBeNull();
    for (const key of ["journalAuthenticated", "workerExited", "preservationComplete", "protected", "pendingResult"] as const) {
      expect(workerArchiveFactsProblem(f.id, f.row, f.info, { ...facts, [key]: null })).not.toBeNull();
    }
    for (const patch of [{ journalAuthenticated: false }, { workerExited: false }, { preservationComplete: false }, { protected: true }, { pendingResult: true },
      { identity: { ...f.id, leaseGen: 4 } }]) {
      expect(workerArchiveFactsProblem(f.id, f.row, f.info, { ...facts, ...patch })).not.toBeNull();
    }
    for (const role of ["owner", "master", "pm", "dispatcher"]) {
      expect(workerArchiveProblem(f.id, f.row, { ...f.info, role })).not.toBeNull();
    }
    const reordered = { sessionId: f.id.sessionId, leaseGen: f.id.leaseGen, agent: f.id.agent, orderId: f.id.orderId };
    expect(workerArchiveProblem(reordered, f.row, f.info)).toBeNull();
  } finally { f.db.close(); }
});
