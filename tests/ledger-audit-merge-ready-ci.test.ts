/** MAINP2 验收线 7（审查 r1 audit-unwired）：audit 的 CI 来源按当前 head 现查必需检查；fake gh 记调用，读失败整项目 null；经 `ledger audit` 写口跑真流程。 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots } from "../src/lib/ledger-audit-snapshot.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { collectMergeCi, mergeBlockersOf, type MergeCiDeps } from "../src/lib/ledger-audit-merge-ready.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { EventKind, LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";
import { runLedger } from "../src/manager/ledger.js";

const H = "a".repeat(40), H2 = "b".repeat(40), NOW = 1_000_000, CHECKS = ["typecheck", "test", "build"];
let seq = 0;
const ev = (kind: EventKind, data: Record<string, unknown>, id: string): LedgerEvent =>
  ({ seq: ++seq, ts: ++seq, actor: "x", project: "p", target: id, kind, text: "", data, dedupKey: null });
const card = (id: string, over: Partial<LedgerTask> = {}, verdict = "pass"): AuditSnapshot["tasks"][number] => {
  const task = { id, project: "p", itemId: null, title: id, kind: "code", stage: "merge", stageBefore: null, round: 1, agent: "a", pm: "pm", branch: "b",
    pr: "https://github.com/o/r/pull/1", headSHA: H, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0,
    assigneeKind: "agent", assignee: "a", ...over } as LedgerTask;
  return { task, events: [ev("review", { round: 1, head: task.headSHA, verdict, reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
    findings: verdict === "pass" ? [] : [{ findingId: "f", family: "x", severity: "P1", probe: "a:1" }], p0: 0, p1: verdict === "pass" ? 0 : 1, p2: 0 }, id)] };
};
function gh(runs: (head: string) => { name: string; status: string; conclusion: string | null }[] | "fail") {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    const head = /commits\/([a-f0-9]{40})\/check-runs/.exec(argv[2] ?? "")?.[1]!;
    const r = runs(head);
    if (r === "fail") return { code: 1, stdout: "", stderr: "network", timedOut: false };
    const list = r.map((x, i) => ({ id: i + 1, head_sha: head, ...x }));
    return { code: 0, stdout: JSON.stringify({ total_count: list.length, check_runs: list }), stderr: "", timedOut: false };
  };
  return { run, calls };
}
const ok = (names = CHECKS) => names.map((name) => ({ name, status: "completed", conclusion: "success" }));
const deps = (run: Run, checks: unknown = CHECKS): MergeCiDeps => ({ run, checksOf: () => checks });

describe("collectMergeCi: the audit's live current-head CI source", () => {
  test("green / missing / red / pending per card, on exactly the card's current head; cards without a PASS cost no call", async () => {
    const g = gh((h) => (h === H ? ok() : [...ok(["typecheck"]), { name: "test", status: "completed", conclusion: "failure" }]));
    const out = await collectMergeCi("p", [card("T1"), card("T2", { headSHA: H2 }), card("T3", {}, "changes"), card("T4", { stage: "review" })], NOW, deps(g.run));
    expect(out).toEqual({
      T1: { head: H, state: "green", source: "live", checkedAt: NOW, missing: [] },
      T2: { head: H2, state: "red", source: "live", checkedAt: NOW, missing: ["test", "build"] },
    });
    expect(g.calls.map((c) => c[2])).toEqual([`repos/o/r/commits/${H}/check-runs?per_page=100`, `repos/o/r/commits/${H2}/check-runs?per_page=100`]);
    const pending = await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => [...ok(["typecheck", "test"]), { name: "build", status: "in_progress", conclusion: null }]).run));
    expect(pending?.T1).toMatchObject({ state: "pending", missing: ["build"] });
  });
  test("network failure, truncated list or no project checks → null for the project (rule skips), never green", async () => {
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => "fail").run))).toBeNull();
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => ok()).run, null))).toBeNull();
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => ok()).run, []))).toBeNull();
    expect(await collectMergeCi("p", [card("T3", {}, "changes")], NOW, deps(gh(() => "fail").run))).toEqual({});
  });
});

describe("collectAuditSnapshots → auditLedger → ledger audit write port, with the live CI source", () => {
  test("green current head: finding opened through `ledger audit`; gh failing next round: skipped, the open finding stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mainp2-audit-flow-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const T0 = 1_000 * 60_000, NOW2 = T0 + 3 * 60 * 60_000;
      db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
      createTask(db, { actor: "owner", now: T0 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "a" });
      db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr='https://github.com/o/r/pull/1' WHERE id='T1'").run(H);
      insertEvent(db, { actor: "rv", now: T0 + 1 }, { project: "p", target: "T1", kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
        reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
      insertEvent(db, { actor: "pm", now: T0 + 2 }, { project: "p", target: "T1", kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
      let down = false;
      const g = gh(() => (down ? "fail" : ok()));
      const auditSources = { registry: async () => [], windows: async () => ["master"], turn: async () => "idle" as const,
        fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
        mergeCi: (p: string, t: AuditSnapshot["tasks"], n: number, d: Database) => collectMergeCi(p, t, n, { ...deps(g.run), blockersOf: (x) => mergeBlockersOf(d, x, n) }) };
      const audit = () => runLedger(["audit", "--project", "p", "--json"], { db, actor: "owner", projectIds: ["p"], now: () => NOW2, auditSources,
        loadRegistry: async () => ({ agents: {} }) as never, saveRegistry: async () => {} }) as Promise<Record<string, any>>;
      const first = await audit();
      expect(first.ok).toBe(true);
      expect(first.projects[0].open.map((f: { rule: string }) => f.rule)).toContain("merge_ready_idle");
      expect(g.calls.map((c) => c[2])).toEqual([`repos/o/r/commits/${H}/check-runs?per_page=100`]);
      down = true;
      const second = await audit();
      expect(second.projects[0].skipped).toContainEqual({ rule: "merge_ready_idle", reason: expect.stringContaining("CI") });
      expect(second.projects[0].resolved).toBe(0);
      expect(second.projects[0].open.map((f: { rule: string }) => f.rule)).toContain("merge_ready_idle");
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("review r2 audit-unwired: real blockers from the same ledger, through collectAuditSnapshots → auditLedger", () => {
  test("a UI card missing its screenshots names it; an unreadable gate is 'not verifiable', never 'nothing blocks'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mainp2-audit-ui-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const T0 = 1_000 * 60_000, NOW2 = T0 + 3 * 60 * 60_000;
      db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
      createTask(db, { actor: "owner", now: T0 }, { project: "p", id: "U1", title: "U1", kind: "code", agent: "a" });
      setWorkflow(db, { actor: "owner", now: T0 }, { taskId: "U1", taskRev: 1, template: "ui", templateVersion: 2, mode: "manual", authorFamily: "claude",
        fallback: "人工", reason: "pm_takeover: 测试" });
      db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr='https://github.com/o/r/pull/1' WHERE id='U1'").run(H);
      insertEvent(db, { actor: "rv", now: T0 + 1 }, { project: "p", target: "U1", kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
        reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
      insertEvent(db, { actor: "pm", now: T0 + 2 }, { project: "p", target: "U1", kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
      const g = gh(() => ok());
      let seenDb: unknown = null, broken = false;
      const sources = { registry: async () => [], windows: async () => ["master"], turn: async () => "idle" as const,
        fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
        mergeCi: (p: string, t: AuditSnapshot["tasks"], n: number, d: Database) => {
          seenDb = d;
          return collectMergeCi(p, t, n, { ...deps(g.run), blockersOf: (x) => { if (broken) throw new Error("库读不了"); return mergeBlockersOf(d, x, n); } });
        } };
      const finding = async () => auditLedger((await collectAuditSnapshots(db, ["p"], NOW2, sources))[0]!, NOW2).findings.find((f) => f.rule === "merge_ready_idle")!;
      const f = await finding();
      expect(seenDb).toBe(db); // the snapshot hands its own ledger to the source
      expect(f.detail).toContain("UI 截图验收：UI 前后截图摘要缺失");
      expect(f.detail).not.toContain("台账合并门全过");
      expect(f.suggestion).toContain("先解掉");
      broken = true;
      expect((await finding()).detail).toContain("台账合并门读取失败，不可核实");
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});
