/** MAINP2 验收线 7：merge + 有效 PASS + 当前 head CI 现查全绿 + 60 分钟没动 → 报 PM；缓存 / 未知 / 旧 head 不算绿；基线静默与去重。 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { MERGE_READY_IDLE_MS, type MergeCiFact, type MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { EventKind, LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { mainCarryKey, MAIN_CARRY_OP } from "../src/lib/review-main-carry-manual.js";

const MIN = 60_000, NOW = 10_000 * MIN, PM = "agent-pm";
const H = "a".repeat(40), H2 = "b".repeat(40), OLD = "c".repeat(40);
let seq = 0;
const ev = (ts: number, kind: EventKind, data: Record<string, unknown> = {}, extra: Partial<LedgerEvent> = {}): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "x", project: "p", target: "T1", kind, text: "", data, dedupKey: null, ...extra });
const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({ id: "T1", project: "p", itemId: null, title: "T1", kind: "code", stage: "merge",
  stageBefore: null, round: 1, agent: "agent-x", pm: PM, branch: "b", pr: "https://github.com/o/r/pull/1", headSHA: H, spec: null, specRev: 1,
  model: null, rev: 3, extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: "agent", assignee: "agent-x", ...over });
const review = (head: string, at: number, over: Record<string, unknown> = {}) => ev(at, "review", { round: 1, head, verdict: "pass", reviewer: "agent-rv",
  reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0, ...over });
const card = (stageAt: number, extra: LedgerEvent[] = [], over: Partial<LedgerTask> = {}) =>
  ({ task: task(over), events: [ev(0, "task", { op: "new" }), review(over.headSHA ?? H, stageAt - MIN), ev(stageAt, "stage", { from: "review", to: "merge" }), ...extra] });
const ci = (over: Partial<MergeCiFact> = {}): MergeCiFact => ({ head: H, state: "green", source: "live", checkedAt: NOW, ...over });
const snap = (tasks: AuditSnapshot["tasks"], over: Partial<AuditSnapshot & MergeReadyInputs> = {}): AuditSnapshot & MergeReadyInputs =>
  ({ project: "p", pms: [PM], tasks, agents: [], reviewers: [], held: [], ownerInbox: [], mergeCi: { T1: ci() }, ...over });
const policy = (mode: "on" | "observe" | "off"): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const ready = (s: AuditSnapshot, now = NOW, mode: "on" | "observe" | "off" = "observe") =>
  auditLedger(s, now, policy(mode)).findings.filter((f) => f.rule === "merge_ready_idle");

describe("merge_ready_idle", () => {
  test("PASS + live green CI on the current head + idle > 60 min → one finding to the PM naming the blockers", () => {
    const f = ready(snap([card(NOW - 61 * MIN)]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: "T1", notify: PM, key: expect.stringContaining(H) });
    expect(f[0]!.detail).toContain("台账里看不出");
    const blocked = ready(snap([{ ...card(NOW - 61 * MIN), blockedBy: ["T0"] }], { queueFrozen: true, mergeBlockers: { T1: ["UI 截图验收缺", "测量输入缺"] },
      mergeUnknown: [{ intentId: "i", taskId: "T1", reason: "x", since: 1 }] }));
    expect(blocked[0]!.detail).toMatch(/合并队列冻结.*依赖未上线：T0.*合并 journal 结果不明.*UI 截图验收缺；测量输入缺/);
  });
  test("threshold: exactly 60 min idle is quiet; any later event resets the clock", () => {
    expect(ready(snap([card(NOW - MERGE_READY_IDLE_MS)]))).toEqual([]);
    expect(ready(snap([card(NOW - 3 * 60 * MIN, [ev(NOW - 30 * MIN, "note")])]))).toEqual([]);
  });
  test("CI: cache, unknown, pending, red, missing checks and an older head's green never count", () => {
    for (const c of [ci({ source: "cache" }), ci({ state: "unknown" }), ci({ state: "pending" }), ci({ state: "red" }), ci({ missing: ["test"] }), ci({ head: H2 })]) {
      expect(ready(snap([card(NOW - 2 * 60 * MIN)], { mergeCi: { T1: c } }))).toEqual([]);
    }
    expect(ready(snap([card(NOW - 2 * 60 * MIN)], { mergeCi: {} }))).toEqual([]);
  });
  test("CI source not read this round → skipped (not evaluated); not wired at all → rule absent", () => {
    const r = auditLedger(snap([card(NOW - 2 * 60 * MIN)], { mergeCi: null }), NOW, policy("on"));
    expect(r.skipped).toContainEqual({ rule: "merge_ready_idle", reason: expect.stringContaining("CI") });
    expect(r.evaluated).not.toContain("merge_ready_idle");
    const absent = auditLedger(snap([card(NOW - 2 * 60 * MIN)], { mergeCi: undefined }), NOW, policy("on"));
    expect([absent.evaluated.includes("merge_ready_idle"), absent.skipped.some((s) => s.rule === "merge_ready_idle")]).toEqual([false, false]);
  });
  test("no valid PASS: P1, block verdict, review on another head, not in merge → quiet", () => {
    const p1 = card(NOW - 2 * 60 * MIN);
    p1.events[1] = review(H, NOW - 3 * 60 * MIN, { p1: 1, findings: [{ findingId: "f", family: "x", severity: "P1", probe: "a.ts:1" }] });
    const block = card(NOW - 2 * 60 * MIN);
    block.events[1] = review(H, NOW - 3 * 60 * MIN, { verdict: "block" });
    const stale = card(NOW - 2 * 60 * MIN);
    stale.events[1] = review(H2, NOW - 3 * 60 * MIN);
    for (const t of [p1, block, stale, card(NOW - 2 * 60 * MIN, [], { stage: "live" })]) expect(ready(snap([t]))).toEqual([]);
  });
  test("a PASS carried by a formal PM main carry still counts; the detail says so", () => {
    const t = { task: task(), events: [ev(0, "task", { op: "new" }), review(OLD, NOW - 5 * 60 * MIN), ev(NOW - 4 * 60 * MIN, "stage", { from: "review", to: "merge" })] };
    const rs = t.events[1]!.seq;
    t.events.push(ev(NOW - 3 * 60 * MIN, "task", { op: "set", patch: { headSHA: H } }, { actor: "pm" }));
    t.events.push(ev(NOW - 3 * 60 * MIN, "decision", { op: MAIN_CARRY_OP, from: OLD, to: H, round: 1, specRev: 1, sourceReviewSeq: rs },
      { actor: "pm", dedupKey: mainCarryKey("T1", OLD, H) }));
    expect(ready(snap([t]))[0]!.detail).toContain("经 1 次正式沿用");
  });
  test("coexists with on / observe / off: same key whatever the mode; the store silences the first run and pushes a card once", () => {
    const s = snap([card(NOW - 2 * 60 * MIN)]);
    const keys = (["on", "observe", "off"] as const).map((m) => ready(s, NOW, m).map((f) => f.key));
    expect(new Set(keys.flat()).size).toBe(1);
    expect(ready(s, NOW, "off")[0]!.detail).toContain("mainCarry=off");
    const dir = mkdtempSync(join(tmpdir(), "mainp2-audit-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const round = (sn: AuditSnapshot, now: number) => { const r = auditLedger(sn, now, policy("observe")); return reconcileFindings(db, "p", r.findings, r.evaluated, now); };
      const first = round(s, NOW);
      expect(first.silenced.some((k) => k.includes("merge_ready_idle"))).toBe(true); // baseline backlog: silent
      expect(first.pending.filter((f) => f.rule === "merge_ready_idle")).toEqual([]);
      expect(round(s, NOW + MIN).opened.filter((k) => k.includes("merge_ready_idle"))).toEqual([]); // same card: not pushed again
      const moved = snap([card(NOW - 2 * 60 * MIN, [], { headSHA: H2 })], { mergeCi: { T1: ci({ head: H2 }) } });
      const next = round(moved, NOW + 2 * MIN);
      expect(next.pending.filter((f) => f.rule === "merge_ready_idle").map((f) => f.key)).toEqual([expect.stringContaining(H2)]);
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});
