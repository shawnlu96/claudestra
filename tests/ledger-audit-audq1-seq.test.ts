/** AUDQ-1 验收追加 10 review-seq：交付之后有没有审查按事件 seq 判，同一毫秒里更早的旧审查不算这次交付的结论（真 SQLite + CLI 巡检入口）。 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditFinding } from "../src/lib/ledger-audit.js";
import type { SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const MIN = 60_000, NOW = 2_000 * MIN, P = "audq1seq", PM = "agent-pm", ID = "SEQ1";
let dir: string, path: string, db: Database;
const ctx = (now: number) => ({ actor: "owner", now });

async function audit(now: number): Promise<AuditFinding[]> {
  const sources: SnapshotSources = {
    registry: async () => [{ name: PM, projectId: P }], windows: async () => [PM], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
  };
  const r = await runLedger(["audit", "--project", P, "--json", "--dry-run"], {
    db, actor: "owner", actorProject: P, projectIds: [P], now: () => now, auditSources: sources,
    loadRegistry: async () => { throw new Error("audit must not load the real registry"); },
    saveRegistry: async () => { throw new Error("audit must not save the registry"); },
  });
  expect(r.ok).toBe(true);
  return (r as unknown as { projects: { open: AuditFinding[] }[] }).projects[0]!.open;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audq1-seq-"));
  path = join(dir, "ledger.sqlite"); db = openLedger(path);
  setMeta(db, ctx(0), { project: P, key: "pms", value: [PM] });
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("旧 review 判 changes 退回 fix、同一毫秒再 deliver：40 分钟后无审查 → 1 条 manual_deliver_no_review 推 PM", async () => {
  createTask(db, ctx(0), { project: P, id: ID, title: ID, kind: "code", stage: "spec" });
  setWorkflow(db, ctx(MIN), { taskId: ID, taskRev: 1, workflowRev: 0, template: "code", templateVersion: 2, mode: "manual",
    authorFamily: "claude", fallback: "PM 核对", reason: "pm_hold: PM 留人工" });
  moveStage(db, ctx(2 * MIN), { taskId: ID, from: "spec", to: "restate" });
  moveStage(db, ctx(3 * MIN), { taskId: ID, from: "restate", to: "build" });
  deliver(db, ctx(4 * MIN), { taskId: ID, moveFrom: "build" });
  const at = NOW - 40 * MIN; // 旧 review 与新 deliver 同一个 ctx.now
  const old = recordReview(db, ctx(at), { taskId: ID, reviewer: "rv", verdict: "changes", p0: 0, p1: 1, p2: 0, path: "/r.md",
    move: { from: "review", to: "fix" } }).event;
  const d = deliver(db, ctx(at), { taskId: ID, moveFrom: "fix" }).event;
  expect([old.ts === d.ts, old.seq < d.seq]).toEqual([true, true]);
  const f = (await audit(NOW)).filter((x) => x.rule === "manual_deliver_no_review");
  expect(f).toEqual([expect.objectContaining({ taskId: ID, notify: PM, key: `${P}|manual_deliver_no_review|${ID}|${d.seq}` })]);
});
