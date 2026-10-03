/** The real local/peer verdict intake persists pitfall before the automatic observer reads it. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { getTask } from "../src/lib/ledger-store.js";
import { runLedger } from "../src/manager/ledger.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";

const P = "demo", H = "a".repeat(40), NOW = 1_000_000;
let db: Database, dir: string, report: string;
const f = { findingId: "tx", family: "widget-tx", severity: "P1", probe: "读 revision 跳号，写入未包含事务", description: "[验收线 1] 事务边界" };
const wire = (orderId: string, pitfall?: unknown) => ({ v: 1, orderId, head: H, verdict: "changes", p0: 0, p1: 1, p2: 0,
  findings: [{ ...f, ...(pitfall !== undefined ? { pitfall } : {}) }], reportPath: report });
const run = () => observeMemory(db, "scheduler", P, { assertLease: () => {} });
const pitfalls = () => projectMemories(db, P).filter((m) => m.kind === "pitfall");
const local = (pitfall?: unknown) => submitVerdict(db,
  { agent: "agent-y", sessionId: "sess-y", family: "codex", verified: true }, wire("A:review:r1", pitfall),
  { reviewsDir: join(dir, "reviews"), registry: [{ name: "agent-x", runtime: "claude-code" }], now: NOW });

beforeEach(() => {
  db = openLedger(":memory:"); ledgerOrigin(db, () => "ab12");
  dir = mkdtempSync(join(tmpdir(), "memory-verdict-")); mkdirSync(join(dir, "reviews"));
  report = join(dir, "reviews", "A.md"); writeFileSync(report, "## tx [验收线 1]\nTransaction boundary evidence\n");
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { project: P, id: "A", title: "Atomic revision writes", kind: "code", spec: report,
    extra: { fileGlobs: ["src/lib/widget-store.ts"] } });
  assignStep(db, { actor: "owner" }, { taskId: "A", step: "write", executor: "agent-x", executorKind: "agent" });
  db.query("UPDATE tasks SET stage = 'build' WHERE id = 'A'").run();
  deliver(db, { actor: "owner", now: NOW - 1 }, { taskId: "A", headSHA: H, moveFrom: "build" });
  assignStep(db, { actor: "owner" }, { taskId: "A", step: "review", executor: "agent-y", executorKind: "agent" });
});
afterEach(() => { closeLedger(":memory:"); rmSync(dir, { recursive: true, force: true }); });

test("submit_verdict pitfall survives persisted findings/read path; replay never creates another pitfall", async () => {
  expect(local(true)).toMatchObject({ ok: true, duplicate: false });
  const events = listEvents(db, { project: P, target: "A" });
  expect(events.find((e) => e.kind === "review")!.data.findings).toMatchObject([{ pitfall: true }]);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ pitfall: true }] } });
  await run(); expect(pitfalls()).toHaveLength(1); expect(pitfalls()[0]!.authorRole).toBe("reviewer");
  expect(local(true)).toMatchObject({ ok: true, duplicate: true });
  await run(); expect(pitfalls()).toHaveLength(1);
});

test("local legacy client without pitfall still works; invalid fields stay rejected", async () => {
  expect(local("true")).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local(1)).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local()).toMatchObject({ ok: true }); await run(); expect(pitfalls()).toEqual([]);
});

async function peerOrder() {
  const key = instanceKeySync(dir);
  const deps = { db, actor: "agent-pm", projectIds: [P], now: () => NOW,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
    lend: { borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 1 }],
      notifyPm: async () => {}, result: { reportDir: () => join(dir, "reviews"), writeReport: (p: string, body: string) => writeFileSync(p, body),
        sign: (fields: string[]) => signPurpose(RECEIPT_PURPOSE, fields, key) } } };
  const offered = await runLedger(["lend-offer", "A", "--peer", "mate", "--repo", "demo/widget", "--pr", "12"], deps);
  expect(offered.ok).toBe(true); const orderId = offered.orderId as string;
  const call = (ep: string, body: unknown) => runLedger([`lend-${ep}`, "--", "mate", JSON.stringify(body)], { ...deps, actor: "owner" });
  expect((await call("claim", { v: 1, orderId, worker: "w1" })).ok).toBe(true);
  const result = (pitfall?: unknown) => ({ v: 1, orderId, gen: 1, verdict: wire(orderId, pitfall),
    report: "## tx [验收线 1]\nUse one transaction for revision and writes", session: { id: "peer-session", family: "codex" } });
  return { call, result };
}

test("peer result through lend wire/lease/signature intake retains pitfall in stored events; resend is idempotent", async () => {
  const { call, result } = await peerOrder();
  const body = result(true); const first = await call("write", body); expect(first.ok).toBe(true);
  const e = listEvents(db, { project: P, target: "A" }).find((e) => e.kind === "review")!;
  expect(e.data.findings).toMatchObject([{ pitfall: true }]);
  await run(); expect(pitfalls()).toHaveLength(1);
  expect(pitfalls()[0]).toMatchObject({ author: "peer:mate", sources: [{ origin: "ab12", originSeq: e.originSeq }] });
  expect(await call("write", body)).toEqual(first); await run(); expect(pitfalls()).toHaveLength(1);
});

test("peer old client works without optional pitfall; illegal pitfall is rejected before any review event", async () => {
  const { call, result } = await peerOrder();
  expect((await call("write", result("true"))).ok).toBe(false);
  expect(listEvents(db, { project: P }).filter((e) => e.kind === "review")).toEqual([]);
  expect((await call("write", result())).ok).toBe(true); await run(); expect(pitfalls()).toEqual([]);
});

test("legacy persisted pitfall:false reads as an ordinary finding and does not invalidate review facts", () => {
  expect(local(false)).toMatchObject({ ok: true });
  const events = listEvents(db, { project: P, target: "A" }).map((e) => e.kind === "review" ? { ...e, data: { ...e.data,
    findings: (e.data.findings as object[]).map((f) => ({ ...f, pitfall: false })) } } : e);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ family: "widget-tx" }] } });
});
