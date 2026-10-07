/**
 * AREB1 shared predicates on a real temp ledger (scheduler-author-rebuild-proof.ts): the next-generation name, what counts as a
 * formal LIFE1 retire of the card's author, and the family / binding / cleanup-debt conditions. The end-to-end wiring is in
 * scheduler-author-rebuild.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordWorkerRetire, registerWorker, workerRetireHistory } from "../src/lib/agent-lifecycle-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { authorRetireProof, rebuildAgentName, rebuildAllowed } from "../src/lib/scheduler-author-rebuild-proof.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const OLD = "agent-task-t1-code-local-r1";
function ledger(opts: { retire?: Partial<Parameters<typeof recordWorkerRetire>[2]>; pending?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "areb1-proof-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: "T1", title: "card", kind: "code", agent: OLD });
  setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  registerWorker(db, { agent: OLD, sessionId: "s-old", taskId: "T1", role: "author", createdBy: "agent-pm", now: 110 });
  recordWorkerRetire(db, "scheduler", { agent: OLD, sessionId: "s-old", taskId: "T1", role: "author", rule: "memory", reason: "swap", idleMs: 1,
    bytesBefore: null, bytesAfter: null, steps: [], now: 120, pending: opts.pending ? [{ checkout: "/x", tmp: null }] : [], retry: false, ...opts.retire });
  const binding = (agent: string, transport: string, state: string) => {
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES ('i1','T1','p','build','ensure_session',1,1,1,1,NULL,2,'done','r',100,100)`).run();
    db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES ('T1','author',?,'s-b','claude',?,?,'i1',100,100)`).run(agent, transport, state);
  };
  return { db, binding, task: { id: "T1", agent: OLD } };
}

describe("rebuildAgentName", () => {
  test("default without replaces; the next generation with it; never the replaced name", () => {
    expect(rebuildAgentName("T1")).toBe("agent-task-t1");
    expect(rebuildAgentName("T1", "agent-task-t1")).toBe("agent-task-t1-r2");
    expect(rebuildAgentName("T1", OLD)).toBe("agent-task-t1-r2");
    expect(rebuildAgentName("T1", "agent-task-t1-r2")).toBe("agent-task-t1-r3");
    expect(rebuildAgentName("T1", "agent-task-t1-r41")).toBe("agent-task-t1-r42");
    expect(rebuildAgentName("LOCAL1", "agent-task-local1-code-local-r1")).toBe("agent-task-local1-r2");
  });
  test("no legal fresh name → null: past the safe integer, a leading zero, over manager create's 48 characters", () => {
    expect(rebuildAgentName("T1", "agent-task-t1-r9999999999999999")).toBeNull();
    expect(rebuildAgentName("T1", "agent-task-t1-r02")).toBe("agent-task-t1-r2"); // not a generation: restart at r2 (≠ the replaced)
  });
  test("a long card id cannot carry a generation suffix → null rather than a truncated (colliding) name", () => {
    const id = "x".repeat(43);
    expect(rebuildAgentName(id)).toBe(`agent-task-${id}`);
    expect(rebuildAgentName(id, `agent-task-${id}`)).toBeNull();
  });
});

describe("authorRetireProof / rebuildAllowed", () => {
  test("a scheduler retire of the registered author session, nothing after → retired; the history keeps seq / actor / session / role", () => {
    const l = ledger();
    expect(authorRetireProof(l.db, l.task)).toMatchObject({ kind: "retired", agent: OLD, sessionId: "s-old" });
    expect(workerRetireHistory(l.db, { taskId: "T1" }).map((h) => [h.op, h.actor, h.agent, h.sessionId, h.role])).toEqual([
      ["worker_register", "agent-pm", OLD, "s-old", "author"], ["worker_retire", "scheduler", OLD, "s-old", "author"]]);
    expect(rebuildAllowed(l.db, l.task, OLD, "claude")).toBeNull();
  });
  test("the workflow's family only; the card must still name the replaced author", () => {
    const l = ledger();
    expect(rebuildAllowed(l.db, l.task, OLD, "codex")).toContain("不是流程的 claude");
    expect(rebuildAllowed(l.db, { id: "T1", agent: "agent-else" }, OLD, "claude")).not.toBeNull();
    expect(rebuildAllowed(l.db, l.task, "agent-else", "claude")).toContain("已不是");
  });
  test("a retire whose cleanup is still owed is not a formal retire", () => {
    const l = ledger({ pending: true });
    expect(authorRetireProof(l.db, l.task)).toMatchObject({ kind: "none" });
  });
  test("a cleanup retry alone, another session, a non-scheduler writer → none", () => {
    expect(authorRetireProof(ledger({ retire: { sessionId: "s-other" } }).db, { id: "T1", agent: OLD })).toMatchObject({ kind: "none" });
    const l = ledger({ retire: { agent: "agent-x" } });
    expect(authorRetireProof(l.db, l.task)).toMatchObject({ kind: "none" });
  });
  test("bindings: a peer author binding or another agent's live binding refuse; a retired binding or the same local agent do not", () => {
    const peer = ledger(); peer.binding(`${OLD}@Sekai`, "peer", "active");
    expect(authorRetireProof(peer.db, peer.task)).toMatchObject({ kind: "none", why: expect.stringContaining("作者绑定") });
    const other = ledger(); other.binding("agent-other", "tmux", "active");
    expect(authorRetireProof(other.db, other.task)).toMatchObject({ kind: "none" });
    const retired = ledger(); retired.binding("agent-other", "tmux", "retired");
    expect(authorRetireProof(retired.db, retired.task)).toMatchObject({ kind: "retired" });
    const same = ledger(); same.binding(OLD, "tmux", "active");
    expect(authorRetireProof(same.db, same.task)).toMatchObject({ kind: "retired" });
  });
  test("an unreadable history → none with the reason, never retired", () => {
    const l = ledger();
    l.db.run("ALTER TABLE events RENAME TO events_gone");
    expect(authorRetireProof(l.db, l.task)).toMatchObject({ kind: "none", why: expect.stringContaining("读不了收回记录") });
  });
});
