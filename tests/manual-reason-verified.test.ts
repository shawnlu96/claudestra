import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LedgerEvent, LedgerTask, Stage, TaskKind } from "../src/lib/ledger-stages.js";
import { diagnoseManual, type ManualReasonRecord } from "../src/lib/manual-reason.js";
import { auditLedger, type AuditRule } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const manualTask = (kind: TaskKind, stage: Stage): LedgerTask => ({
  id: "T1", project: "p", kind, stage, title: "manual card", itemId: null, stageBefore: null, round: 0,
  agent: null, assigneeKind: null, assignee: null, pm: null, branch: null, pr: null, headSHA: null, spec: null,
  specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0,
});

function manualEvents(code: ManualReasonRecord["code"] | null): LedgerEvent[] {
  const record: ManualReasonRecord | null = code === null ? null : {
    v: 1, code, label: code, text: "waiting for resolution", blocking: null, release: "resolve", node: "PM",
    approval: false, specRev: 1, head: null, uiDigest: null,
  };
  return [{ seq: 1, ts: 0, actor: "pm", project: "p", target: "T1", kind: "scheduler", text: "manual entry", dedupKey: null,
    data: { op: "workflow", mode: "manual", ...(record ? { manualReason: record } : {}) } }];
}

const diagnose = (kind: TaskKind, stage: Stage, code: ManualReasonRecord["code"] | null = "merge_unknown") =>
  diagnoseManual({ task: manualTask(kind, stage), events: manualEvents(code), mergeUnknown: [], blockedBy: [] });

describe("manual diagnosis stops at the task kind's endpoint", () => {
  for (const kind of ["code", "ops"] as const) {
    test(`${kind}: verified skips a structured, otherwise resumable manual`, () => {
      expect(diagnose(kind, "verified")).toBeNull();
    });

    test(`${kind}: verified skips a manual without a reason`, () => {
      expect(diagnose(kind, "verified", null)).toBeNull();
    });

    test(`${kind}: live and merge still diagnose the same resumable manual`, () => {
      for (const stage of ["live", "merge"] as const) {
        expect(diagnose(kind, stage)).toMatchObject({ code: "merge_unknown", structured: true, wouldResume: true, gaps: [] });
        expect(diagnose(kind, stage, null)).toMatchObject({ code: null, wouldResume: false });
      }
    });
  }

  test("done and cancelled still skip every task kind", () => {
    for (const kind of ["code", "ops", "investigate"] as const) {
      for (const stage of ["done", "cancelled"] as const) expect(diagnose(kind, stage)).toBeNull();
    }
  });

  test("investigate uses done and cancelled as endpoints, not verified", () => {
    expect(diagnose("investigate", "verified")).toMatchObject({ code: "merge_unknown", wouldResume: true });
  });

  test("merge owner_hold remains available to merge-ready and review gates", () => {
    expect(diagnose("code", "merge", "owner_hold")).toMatchObject({ code: "owner_hold", wouldResume: false });
  });
});

type Fixture = ReturnType<typeof autoFixture>;
type AuditProject = { open: { key: string; rule: AuditRule; taskId: string | null }[]; resolved: number };

const actionState = (f: Fixture) => ({
  intents: f.intents(),
  workflows: f.db.query("SELECT * FROM task_workflows ORDER BY taskId").all(),
  eventCount: f.db.query("SELECT COUNT(*) AS count FROM events").get(),
});

function advanceToLive(f: Fixture, taskId: string): void {
  const path: Stage[] = ["spec", "restate", "build", "review", "merge", "live"];
  for (let i = 1; i < path.length; i++) moveStage(f.db, f.at("owner"), { taskId, from: path[i - 1], to: path[i] });
}

async function auditRound(f: Fixture) {
  const ports: SnapshotSources = {
    heldPath: join(f.dir, "audit-held.json"), registry: async () => [], windows: async () => [], turn: async () => "idle",
    reviewers: () => [], fileTimes: async () => ({ startedAt: null, lastWriteAt: null }),
  };
  const before = actionState(f);
  const [snapshot] = await collectAuditSnapshots(f.db, ["p"], f.at("owner").now, ports);
  const report = auditLedger(snapshot, f.at("owner").now);
  const result = await f.cliWith({ auditSources: ports }, "owner", "audit", "--project", "p", "--json");
  expect(result.ok).toBe(true);
  const project = (result.projects as AuditProject[])[0];
  expect(project.open.filter((row) => row.rule.startsWith("manual_")).map((row) => row.key).sort()).toEqual(
    report.findings.filter((row) => row.rule.startsWith("manual_")).map((row) => row.key).sort(),
  );
  expect(actionState(f)).toEqual(before);
  return { report, project };
}

describe("formal ledger audit resolves manual findings after verification", () => {
  for (const missingReason of [false, true]) {
    const rule: AuditRule = missingReason ? "manual_reason_missing" : "manual_would_resume";
    test(`${rule}: live reports, verified resolves, with no audit actions`, async () => {
      const f = autoFixture();
      try {
        if (missingReason) {
          // A pre-MAN1 manual entry is synthesised only in this temporary ledger.
          f.db.query("UPDATE task_workflows SET mode = 'manual', rev = rev + 1 WHERE taskId = 'T1'").run();
          insertEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "scheduler", text: "legacy manual",
            data: { op: "workflow", mode: "manual" } }, false);
        } else {
          createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "dependency", kind: "code" });
          addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "dependency live" });
          advanceToLive(f, "T0");
          expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", "1",
            "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "PM",
            "--reason", "deps_not_live: waiting for T0")).toMatchObject({ ok: true });
        }
        advanceToLive(f, "T1");
        f.advance(31 * 60_000);
        const live = await auditRound(f);
        const findings = live.project.open.filter((row) => row.rule.startsWith("manual_"));
        expect(findings).toEqual([expect.objectContaining({ rule, taskId: "T1" })]);
        const key = findings[0].key;
        expect(live.report.evaluated).toContain(rule);

        recordVerify(f.db, f.at("owner"), { taskId: "T1", result: "pass",
          data: { checks: [{ id: "manual-evidence", status: "pass" }] } });
        const verified = await auditRound(f);
        expect(verified.report.evaluated).toContain(rule);
        expect(verified.report.findings.filter((row) => row.rule.startsWith("manual_"))).toEqual([]);
        expect(verified.project.open.some((row) => row.key === key)).toBe(false);
        expect(verified.project.resolved).toBeGreaterThanOrEqual(1);
        const stored = f.db.query("SELECT resolvedAt FROM audit_findings WHERE key = ?").get(key) as { resolvedAt: number | null };
        expect(stored.resolvedAt).toBeNumber();

        const next = await auditRound(f);
        expect(next.project.open.filter((row) => row.rule.startsWith("manual_"))).toEqual([]);
        expect(f.db.query("SELECT resolvedAt FROM audit_findings WHERE key = ?").get(key)).toEqual(stored);
      } finally { f.close(); }
    });
  }
});
