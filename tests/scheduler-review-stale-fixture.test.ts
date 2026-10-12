import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { autoFixture, H1, H2 } from "./scheduler-auto-helpers.js";

export function staleFixture(opts: { swap?: Record<string, unknown>; ordinary?: boolean } = {}) {
  const f = autoFixture();
  f.db.run("UPDATE tasks SET stage = 'review', round = 3, headSHA = ? WHERE id = 'T1'", [H1]);
  const event = (kind: "scheduler" | "stage" | "review", data: Record<string, unknown>) =>
    insertEvent(f.db, f.at("scheduler"), { project: "p", target: "T1", kind, text: "合成", data }, false);
  const swap = event("scheduler", { op: "reviewer_swap", legacy: true, intentId: "legacy", sessionId: "s-original",
    head: H1, specRev: 1, round: 3, toFamily: "codex", ...opts.swap });
  const created = event("scheduler", { op: "intent", id: "ensure-r3" });
  const intent = (id: string, action: string, status = "done", seq = created.seq) => {
    const t = f.task();
    f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head,
      templateVersion, status, attempts, receipt, reason, createdAt, updatedAt)
      VALUES (?, 'T1', 'p', 'adversarial_review', ?, NULL, ?, ?, ?, ?, ?, 2, ?, 0, NULL, '合成', 1, 1)`,
    [id, action, seq, seq, t.rev, t.specRev, t.headSHA, status]);
  };
  intent("ensure-r3", "ensure_session", "done", opts.ordinary ? swap.seq : created.seq);
  const agent = "agent-task-rv-t1-r3-re", sessionId = "s-re";
  f.db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T1', 'reviewer', ?, ?, 'codex', 'acp', 'active', 'ensure-r3', 1, 1)`, [agent, sessionId]);
  event("scheduler", { op: "session_bind", role: "reviewer", agent, sessionId, family: "codex" });
  event("review", { round: 3, specRev: 1, head: H1, verdict: "pass", reviewer: agent, reviewerSessionId: sessionId, reviewerFamily: "codex",
    p0: 0, p1: 0, p2: 0, findings: [], reportPath: "reviews/T1-r3/report.md" });
  event("stage", { from: "merge", to: "review", round: 4, specRev: 1, headSHA: H2 });
  f.db.run("UPDATE tasks SET round = 4, headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [H2]);
  const registry = JSON.parse(readFileSync(f.registryPath, "utf8"));
  registry.agents[agent] = { runtime: "codex", transport: "acp", sessionId, cwd: `${f.dir}/rv-t1-re` };
  writeFileSync(f.registryPath, JSON.stringify(registry));
  const snapshot = () => autoSnapshot(f.reader.get()!, f.task(), { registry: [], maxWorkers: 2 });
  const born = listEvents(f.db, { target: "T1" }).find((e) => e.kind === "task")!.seq;
  return { f, event, intent, swap, agent, sessionId, snapshot, id: `review-stale:s${born}:r4`, resource: `task:s${born}` };
}

test("[验收线 1] 合成台账保留 r3 PASS、ensure 来源与 r4 当前窗口", () => {
  const s = staleFixture();
  try {
    expect(s.f.task()).toMatchObject({ round: 4, headSHA: H2 });
    expect(s.snapshot().events.find((e) => e.kind === "review")).toMatchObject({ data: { verdict: "pass", round: 3, head: H1 } });
    expect(s.snapshot().reviewer).toMatchObject({ agent: s.agent, sessionId: s.sessionId, family: "codex" });
  } finally { s.f.close(); }
});
