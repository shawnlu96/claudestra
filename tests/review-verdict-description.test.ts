/**
 * dispatch-recovery-MATW：submit_verdict（MCP）正规入账保留审查方 wire 里的 description，别的字段（basis / session / head / 计数 / 单号）照旧；
 * 升级前记的（逐项没 description）重试仍认幂等；修复材料只认这条原文——旧记录照旧 undescribed 回退全文，不拿 probe 顶、不从报告里猜。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { fixMaterials, sendsItems } from "../src/lib/fix-materials.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, recordReview, setMeta, setTask } from "../src/lib/ledger-write.js";
import { submitVerdict, verdictKey, type VerdictDeps } from "../src/lib/review-verdict.js";

const P = "claude-orchestrator";
const OWNER = { actor: "owner", now: 1_000 };
const PM = { actor: "agent-pm", now: 1_100 };
const H1 = "a".repeat(40);
let db: Database, dir: string, reviews: string, report: string, deps: VerdictDeps;

const me = (agent: string): CallerIdentity => ({ agent, sessionId: `sess-${agent}`, family: "codex", verified: true });
const reviewEvents = () => listEvents(db, { project: P, target: "T50" }).filter((e) => e.kind === "review");
const finding = (id: string, severity: "P1" | "P2", description: string) =>
  ({ findingId: id, family: "gate", severity, probe: `复现 ${id}`, description, basis: "regression" });
const wire = (over: Record<string, unknown> = {}) => ({
  v: 1, orderId: "T50:review:r1", head: H1, verdict: "changes", p0: 0, p1: 1, p2: 1,
  findings: [finding("F1", "P1", "旧写者在换租约后必须被拒\n第二行"), finding("F2", "P2", "返回值没校验")], reportPath: report, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matw-verdict-"));
  reviews = join(dir, "ledger", "reviews");
  mkdirSync(reviews, { recursive: true });
  report = join(reviews, "T50-r1.md");
  writeFileSync(report, "# 结论\nF1 说的是另一件事（报告自由文本不当说明用）\n");
  deps = { registry: [{ name: "agent-x", runtime: "claude-code" }, { name: "agent-y", runtime: "codex" }], reviewsDir: reviews, now: 2_000 };
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: P, id: "T50", title: "卡", kind: "code" });
  setTask(db, OWNER, { id: "T50", rev: 1, patch: { agent: "agent-x" } });
  assignStep(db, PM, { taskId: "T50", step: "write", executor: "agent-x", executorKind: "agent" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T50'");
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T50", headSHA: H1, moveFrom: "build" });
  assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-y", executorKind: "agent" });
});
afterEach(() => {
  closeLedger(":memory:");
  rmSync(dir, { recursive: true, force: true });
});

/** What a pre-MATW bridge recorded for wire(): the same call and dedup key, rows without description. */
function legacyRecord(): void {
  const w = wire();
  recordReview(db, { actor: "agent-y", now: 2_000, dedupKey: verdictKey(w) }, {
    taskId: "T50", reviewer: "agent-y", verdict: "changes", p0: 0, p1: 1, p2: 1, path: report, head: H1, reviewerSessionId: "sess-agent-y",
    reviewerFamily: "codex", findings: w.findings.map(({ description: _d, ...f }) => f) as never, orderId: w.orderId, sameFamily: false, via: "mcp",
  } as never);
}

describe("submit_verdict 存 description", () => {
  test("逐项原样存审查方的 description；basis / session / head / 计数 / 单号照旧", () => {
    expect(submitVerdict(db, me("agent-y"), wire(), deps)).toMatchObject({ ok: true, duplicate: false });
    const e = reviewEvents()[0]!;
    expect(e.data).toMatchObject({ verdict: "changes", p0: 0, p1: 1, p2: 1, path: report, head: H1, reviewerSessionId: "sess-agent-y",
      reviewerFamily: "codex", orderId: "T50:review:r1", via: "mcp" });
    expect(e.data.findings).toEqual([
      { findingId: "F1", family: "gate", severity: "P1", probe: "复现 F1", basis: "regression", description: "旧写者在换租约后必须被拒\n第二行" },
      { findingId: "F2", family: "gate", severity: "P2", probe: "复现 F2", basis: "regression", description: "返回值没校验" },
    ]);
  });

  test("同结论重试幂等；改了 description 算不同结论（拒，交 PM）", () => {
    const a = submitVerdict(db, me("agent-y"), wire(), deps);
    expect(submitVerdict(db, me("agent-y"), wire(), deps)).toMatchObject({ ok: true, duplicate: true, eventSeq: a.ok ? a.eventSeq : -1 });
    const changed = wire({ findings: [finding("F1", "P1", "换了一句"), finding("F2", "P2", "返回值没校验")] });
    expect(submitVerdict(db, me("agent-y"), changed, deps)).toMatchObject({ ok: false, error: "conflict" });
    expect(reviewEvents()).toHaveLength(1);
  });

  test("升级前记的结论（没存 description）：同一结论重试仍认幂等，不改历史记录", () => {
    legacyRecord();
    const before = JSON.stringify(reviewEvents()[0]!.data);
    expect(submitVerdict(db, me("agent-y"), wire(), deps)).toMatchObject({ ok: true, duplicate: true });
    expect(JSON.stringify(reviewEvents()[0]!.data)).toBe(before);
    expect(submitVerdict(db, me("agent-y"), wire({ verdict: "block" }), deps)).toMatchObject({ ok: false, error: "conflict" });
  });
});

describe("修复材料读到的说明", () => {
  test("MCP 入账的结论：on 每项都有审查方原文说明，可只发结构化项；来源指这条审查事件", () => {
    submitVerdict(db, me("agent-y"), wire(), deps);
    const events = listEvents(db, { project: P, target: "T50" });
    const m = fixMaterials("on", events, report, readFileSync(report, "utf8"))!;
    expect(m.items.map((i) => i.description)).toEqual(["旧写者在换租约后必须被拒\n第二行", "返回值没校验"]);
    expect(m.fallback).toBeUndefined();
    expect(sendsItems(m)).toBe(true);
    expect(m.source.eventSeq).toBe(reviewEvents()[0]!.seq);
  });

  test("历史记录（没存 description、不是出借审查）：仍 undescribed 回退全文，不拿 probe 或报告自由文本顶", () => {
    legacyRecord();
    const m = fixMaterials("on", listEvents(db, { project: P, target: "T50" }), report, readFileSync(report, "utf8"))!;
    expect(m.fallback).toBe("undescribed");
    expect(m.items.map((i) => i.description)).toEqual([null, null]);
    expect(sendsItems(m)).toBe(false);
  });
});
