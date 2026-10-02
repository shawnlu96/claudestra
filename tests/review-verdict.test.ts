/**
 * T97 审查员工具的 lib 层：take_review 出单、submit_verdict 记账。验收线的每条 P1 各一个反例（未验证 / 非本步骤审查员、推阶段、
 * 旧 head、计数不符、自审、自报 session / family），外加正常路径、幂等、报告路径、sameFamily、「旧终审 vs 新初审」和自动卡。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, recordReview, setMeta, setTask } from "../src/lib/ledger-write.js";
import { takeReview } from "../src/lib/review-order.js";
import { submitVerdict, type VerdictDeps } from "../src/lib/review-verdict.js";

const P = "claude-orchestrator";
const OWNER = { actor: "owner", now: 1_000 };
const PM = { actor: "agent-pm", now: 1_100 };
const H1 = "a".repeat(40), H2 = "b".repeat(40);
let db: Database, dir: string, reviews: string, report: string, deps: VerdictDeps;

const me = (agent: string, over: Partial<CallerIdentity> = {}): CallerIdentity => ({ agent, sessionId: `sess-${agent}`, family: "codex", verified: true, ...over });
const reviewEvents = () => listEvents(db, { project: P, target: "T50" }).filter((e) => e.kind === "review");
const finding = (id: string, severity: "P0" | "P1" | "P2") => ({ findingId: id, family: "gate", severity, probe: `复现 ${id}`, description: `说明 ${id}` });
const wire = (over: Record<string, unknown> = {}) => ({
  v: 1, orderId: "T50:review:r1", head: H1, verdict: "changes", p0: 0, p1: 1, p2: 1,
  findings: [finding("F1", "P1"), finding("F2", "P2")], reportPath: report, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t97-"));
  reviews = join(dir, "ledger", "reviews");
  mkdirSync(reviews, { recursive: true });
  report = join(reviews, "T50-r1.md");
  writeFileSync(report, "# 结论\n");
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

describe("正常路径", () => {
  test("旧 verdict 从逐项说明或报告标题补 basis，结构化字段优先，无标记仍可交", () => {
    writeFileSync(report, "## F1 [验收线 2] 报告标题\n## F2\n[回归] 第二项\n");
    const findings = [finding("F1", "P1"), finding("F2", "P1"),
      { ...finding("F3", "P1"), description: "[验收线 3] 说明" },
      { ...finding("F4", "P1"), basis: "regression" }, finding("F5", "P1")];
    expect(submitVerdict(db, me("agent-y"), wire({ p1: 5, p2: 0, findings }), deps).ok).toBe(true);
    const rows = reviewEvents()[0]!.data.findings as { basis?: string }[];
    expect(rows.map((f) => f.basis)).toEqual(["acceptance:2", "regression", "acceptance:3", "regression", undefined]);
  });

  test("take_review 给出审查单；submit_verdict 记结构化结论（head / session / family 取身份与单子），不推阶段", () => {
    const t = takeReview(db, me("agent-y"), reviews);
    if (!t.ok) throw new Error(t.message);
    expect(t.orders.map((o) => [o.orderId, o.head, o.step, o.node, o.round])).toEqual([["T50:review:r1", H1, "review", "review", 1]]);
    expect(t.orders[0]!.outputs.join("\n")).toContain(join(reviews, "T50-r1.md"));
    expect(takeReview(db, me("agent-z"), reviews)).toEqual({ ok: true, orders: [], errors: [] });

    const r = submitVerdict(db, me("agent-y"), wire(), deps);
    expect(r).toMatchObject({ ok: true, duplicate: false, taskId: "T50", sameFamily: false });
    const [e] = reviewEvents();
    expect(e!.actor).toBe("agent-y");
    expect(e!.data).toMatchObject({
      round: 1, reviewer: "agent-y", verdict: "changes", p0: 0, p1: 1, p2: 1, path: report, head: H1,
      reviewerSessionId: "sess-agent-y", reviewerFamily: "codex", orderId: "T50:review:r1", sameFamily: false, via: "mcp",
      author: "agent-x", authorCheck: true,
    });
    expect(e!.data.findings).toEqual([{ findingId: "F1", family: "gate", severity: "P1", probe: "复现 F1" }, { findingId: "F2", family: "gate", severity: "P2", probe: "复现 F2" }]);
    expect(getTask(db, "T50")!.stage).toBe("review");
    expect(listSteps(db, "T50").find((s) => s.step === "review")!.verdict).toBe("changes");
  });

  test("上一轮的逐项结论带进下一轮的单", () => {
    submitVerdict(db, me("agent-y"), wire(), deps);
    db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'T50'");
    deliver(db, { actor: "agent-x", now: 1_300 }, { taskId: "T50", headSHA: H2, moveFrom: "fix" });
    assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-y", executorKind: "agent", round: 2 });
    const t = takeReview(db, me("agent-y"), reviews);
    expect(t.ok && t.orders[0]).toMatchObject({ orderId: "T50:review:r2", head: H2, round: 2, findings: [{ findingId: "F1" }, { findingId: "F2" }] });
  });
});

describe("验收线 P1 反例", () => {
  test("未验证身份：拒，什么都不记", () => {
    expect(submitVerdict(db, me("agent-y", { verified: false }), wire(), deps)).toMatchObject({ ok: false, error: "identity_unverified" });
    expect(takeReview(db, me("agent-y", { verified: false }), reviews)).toMatchObject({ ok: false, error: "identity_unverified" });
    expect(reviewEvents()).toEqual([]);
  });

  test("不是本步骤的审查员（已验证的别的 agent）：拒", () => {
    expect(submitVerdict(db, me("agent-z"), wire(), deps)).toMatchObject({ ok: false, error: "no_order" });
    expect(reviewEvents()).toEqual([]);
  });

  test("结论不推阶段：pass 之后卡还在 review", () => {
    expect(submitVerdict(db, me("agent-y"), wire({ verdict: "pass", p1: 0, findings: [finding("F2", "P2")] }), deps).ok).toBe(true);
    expect(getTask(db, "T50")!.stage).toBe("review");
    expect(listEvents(db, { project: P, target: "T50" }).filter((e) => e.kind === "stage" && e.ts >= 2_000)).toEqual([]);
  });

  test("head 和派单时不一致：审的是旧 head，拒", () => {
    expect(submitVerdict(db, me("agent-y"), wire({ head: H2 }), deps)).toMatchObject({ ok: false, error: "stale_head" });
    // 派单后 PM 退回修、交了新 head：旧单的 head 对不上了
    recordReview(db, PM, { taskId: "T50", reviewer: "agent-pm-proxy", verdict: "changes", p0: 0, p1: 1, p2: 0, move: { from: "review", to: "fix" } });
    deliver(db, { actor: "agent-x", now: 1_300 }, { taskId: "T50", headSHA: H2, moveFrom: "fix" });
    expect(submitVerdict(db, me("agent-y"), wire(), deps)).toMatchObject({ ok: false, error: "stale_head" });
    expect(reviewEvents().filter((e) => e.actor === "agent-y")).toEqual([]);
  });

  test("p0 / p1 / p2 计数与 findings 对不上：拒", () => {
    expect(submitVerdict(db, me("agent-y"), wire({ p1: 0 }), deps)).toMatchObject({ ok: false, error: "invalid_wire" });
    expect(submitVerdict(db, me("agent-y"), wire({ p2: 2 }), deps)).toMatchObject({ ok: false, error: "invalid_wire" });
    expect(reviewEvents()).toEqual([]);
  });

  test("自审（审查员就是写的人）：拒；推出来的写步骤执行者也算", () => {
    assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-x", executorKind: "agent" });
    expect(submitVerdict(db, me("agent-x"), wire(), deps)).toMatchObject({ ok: false, error: "self_review" });
    expect(reviewEvents()).toEqual([]);
  });

  test("session / family 只取身份：wire 里多带自报字段整单拒；身份缺会话或是 Pi 也拒", () => {
    expect(submitVerdict(db, me("agent-y"), wire({ reviewerSessionId: "forged" }), deps)).toMatchObject({ ok: false, error: "invalid_wire" });
    expect(submitVerdict(db, me("agent-y"), wire({ family: "claude" }), deps)).toMatchObject({ ok: false, error: "invalid_wire" });
    expect(submitVerdict(db, me("agent-y", { sessionId: null }), wire(), deps)).toMatchObject({ ok: false, error: "identity_incomplete" });
    expect(submitVerdict(db, me("agent-y", { family: "pi" }), wire(), deps)).toMatchObject({ ok: false, error: "identity_incomplete" });
    expect(reviewEvents()).toEqual([]);
    submitVerdict(db, me("agent-y", { sessionId: "sess-real", family: "claude-code" }), wire(), deps);
    expect(reviewEvents()[0]!.data).toMatchObject({ reviewerSessionId: "sess-real", reviewerFamily: "claude", sameFamily: true });
  });
});

describe("幂等与报告", () => {
  test("同单同 head 同结论重试：不重复记；同单换结论：拒，交 PM", () => {
    const a = submitVerdict(db, me("agent-y"), wire(), deps);
    const b = submitVerdict(db, me("agent-y"), wire(), deps);
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(a.ok && b.ok && a.eventSeq === b.eventSeq).toBe(true);
    expect(submitVerdict(db, me("agent-y"), wire({ verdict: "block" }), deps)).toMatchObject({ ok: false, error: "conflict" });
    expect(reviewEvents().length).toBe(1);
  });

  test("同一轮同一 head 已经由 CLI 记过这个审查员的结论：拒，不叠一条", () => {
    recordReview(db, PM, { taskId: "T50", reviewer: "agent-y", verdict: "pass", p0: 0, p1: 0, p2: 0, head: H1, reviewerSessionId: "s",
      reviewerFamily: "codex", findings: [], path: report });
    expect(submitVerdict(db, me("agent-y"), wire(), deps)).toMatchObject({ ok: false, error: "conflict" });
  });

  test("报告要在 reviews 目录下、存在且非空；符号链接指到外面也拒", () => {
    const outside = join(dir, "elsewhere.md");
    writeFileSync(outside, "x");
    const empty = join(reviews, "empty.md");
    writeFileSync(empty, "");
    const link = join(reviews, "link.md");
    symlinkSync(outside, link);
    for (const reportPath of [outside, join(reviews, "missing.md"), empty, link, "ledger/reviews/T50-r1.md"]) {
      expect(submitVerdict(db, me("agent-y"), wire({ reportPath }), deps)).toMatchObject({ ok: false, error: expect.stringMatching(/bad_report|invalid_wire/) });
    }
    expect(reviewEvents()).toEqual([]);
  });
});

describe("选步骤：旧终审 vs 新初审", () => {
  test("派过第 1 轮终审、又派了第 2 轮初审：单是新初审的，旧终审员领不到也交不了", () => {
    assignStep(db, PM, { taskId: "T50", step: "final_review", executor: "agent-f", executorKind: "agent", round: 1 });
    expect(takeReview(db, me("agent-f"), reviews)).toMatchObject({ ok: true, orders: [{ orderId: "T50:final_review:r1", node: "final_review" }] });
    assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-r", executorKind: "agent", round: 2 });
    expect(takeReview(db, me("agent-f"), reviews)).toEqual({ ok: true, orders: [], errors: [] });
    expect(takeReview(db, me("agent-r"), reviews)).toMatchObject({ ok: true, orders: [{ orderId: "T50:review:r2" }] });
    expect(submitVerdict(db, me("agent-f"), wire({ orderId: "T50:final_review:r1" }), deps)).toMatchObject({ ok: false, error: "no_order" });
    expect(submitVerdict(db, me("agent-r"), wire({ orderId: "T50:review:r2" }), deps).ok).toBe(true);
  });
});

describe("自动卡", () => {
  const INTENT = "sched:T50:review:1";
  let registryPath: string;
  beforeEach(() => {
    registryPath = join(dir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ socket: "", agents: { "agent-rv": { runtime: "codex", sessionId: "sess-agent-rv", cwd: dir } } }));
    // setWorkflow 只收未开写的新卡；这里直接落一行，模拟迁移后从 spec 起就是自动卡、现在走到 review
    db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt)
      VALUES ('T50', ?, 'code', 2, 'auto', 'claude', '缩小范围', 0, 1, 1, 1)`).run(P);
    const t = getTask(db, "T50")!;
    const intent = db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head,
      templateVersion, status, reason, createdAt, updatedAt) VALUES (?, 'T50', ?, ?, 'review', 'agent-rv', 1, 999, ?, 0, ?, 2, 'submitted', 'r', 1, 1)`);
    intent.run("create-rv", P, "ensure", t.rev, null);
    intent.run(INTENT, P, "adversarial_review", t.rev, H1);
    db.prepare(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('T50', 'reviewer', 'agent-rv', 'sess-agent-rv', 'codex', 'acp', 'active', 'create-rv', 1, 1)`).run();
    deps = { ...deps, registryPath, gitHead: () => H1, gitDirty: () => null };
  });

  test("绑定的审查 session 领到 intent 单并记账；换了会话领不到；审查目录脏了按 CLI 同一道门拒", () => {
    expect(takeReview(db, me("agent-rv"), reviews)).toMatchObject({ ok: true, orders: [{ orderId: INTENT, node: "adversarial_review", fallback: "缩小范围" }] });
    expect(takeReview(db, me("agent-rv", { sessionId: "other" }), reviews)).toEqual({ ok: true, orders: [], errors: [] });
    expect(takeReview(db, me("agent-y"), reviews)).toEqual({ ok: true, orders: [], errors: [] });
    expect(submitVerdict(db, me("agent-rv"), wire({ orderId: INTENT }), { ...deps, gitDirty: () => "M a.ts" })).toMatchObject({ ok: false, error: "forbidden" });
    const r = submitVerdict(db, me("agent-rv"), wire({ orderId: INTENT }), deps);
    expect(r).toMatchObject({ ok: true, sameFamily: false });
    expect(reviewEvents()[0]!.data).toMatchObject({ orderId: INTENT, reviewerSessionId: "sess-agent-rv", reviewerFamily: "codex" });
    expect(getTask(db, "T50")!.stage).toBe("review");
  });
});
