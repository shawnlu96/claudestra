import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { appendEvent, createTask, deliver, moveStage, recordReview } from "../src/lib/ledger-write.js";
import { schedulerObserveTick } from "../src/lib/scheduler-observe-tick.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

const H1 = "1".repeat(40), H2 = "2".repeat(40);
const P1 = { findingId: "race-1", family: "concurrency", severity: "P1" as const, probe: "two ticks claim the same intent" };
const P2 = { findingId: "name-1", family: "naming", severity: "P2" as const, probe: "rename helper" };

const DIGEST = "d".repeat(64);

function fixture(template: "code" | "ui" = "code") {
  const dir = mkdtempSync(join(tmpdir(), "t68e-observe-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const registryPath = join(dir, "registry.json");
  const setReviewSession = (sessionId: string) => writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {
    "agent-one": { runtime: "claude-code", sessionId: "s-one" }, "agent-review": { runtime: "codex", transport: "acp", sessionId },
    "agent-other": { runtime: "codex", transport: "acp", sessionId: "s-other" },
  } }));
  setReviewSession("s-review");
  let now = 1000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  createTask(db, at("owner"), { project: "p", id: "T1", title: "observe", kind: "code", agent: "agent-one",
    extra: { fileGlobs: ["src/lib/x.ts"], ...(template === "ui" ? { screenshotsDigest: DIGEST } : {}) } });
  setWorkflow(db, at("owner"), { taskId: "T1", taskRev: 1, template, templateVersion: 2, mode: "observe", authorFamily: "claude", fallback: "只报错" });
  const deps = (actor: string): LedgerDeps => ({
    db, actor, registryPath, projectIds: ["p"], now: () => (now += 10),
    loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {},
  });
  const observe = async () => {
    const r = await runLedger(["scheduler-observe", "T1"], deps("scheduler"));
    expect(r.ok).toBe(true);
    return r as { duplicate: boolean; decision: Record<string, unknown>; event: { data: Record<string, unknown> } };
  };
  const review = (verdict: "pass" | "changes", head: string, findings: object[], move?: "fix" | "merge", who = ["agent-review", "s-review"]) =>
    recordReview(db, at("owner"), { taskId: "T1", reviewer: who[0], verdict, path: `reviews/T1-r${getTask(db, "T1")!.round}/report.md`,
      p0: 0, p1: findings.filter((f) => (f as { severity: string }).severity === "P1").length, p2: findings.filter((f) => (f as { severity: string }).severity === "P2").length,
      head, reviewerSessionId: who[1], reviewerFamily: "codex", findings: findings as never, ...(move ? { move: { from: "review", to: move } } : {}) });
  const dispatch = (head: string, type = "adversarial") => appendEvent(db, at("owner"), { project: "p", target: "T1", kind: "dispatch",
    data: { reviewer: type, round: getTask(db, "T1")!.round, head } });
  /** spec → restate → build → delivered at H1 → review step assigned to agent-review. */
  const toReview = () => {
    moveStage(db, at("agent-one"), { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, at("owner"), { taskId: "T1", from: "restate", to: "build" });
    deliver(db, at("agent-one"), { taskId: "T1", headSHA: H1, moveFrom: "build" });
    assignStep(db, at("owner"), { taskId: "T1", step: "review", executor: "agent-review", executorKind: "agent" });
  };
  const rows = async () => (await runLedger(["scheduler-diff", "T1", "--all"], deps("owner"))).rows as
    { planned: string; actual: string | null; verdict: string; note: string; round: number }[];
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  /** A scheduler screenshot ask bound to the card; `owner` = the answer carries the authenticated owner mark. */
  const uiAsk = (head: string, from = "scheduler") => {
    const binding = { action: "scheduler_ui_screenshot", params: { task: "T1", specRev: 1, head, screenshotsDigest: DIGEST }, approve: ["ok"] };
    return openAsk(db, { project: "p", taskId: "T1", fromAgent: from, source: "system", kind: "authorize", title: "看前后截图",
      expiresAt: now + 1e9, bind: { ...binding, paramsHash: bindHash(binding, from) } }, now + 1);
  };
  const answer = (id: string, button: string, mark: { owner?: true; external?: boolean } = { owner: true }) =>
    answerAsk(db, id, { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: now + 2, ...mark });
  return { db, at, deps, observe, review, dispatch, toReview, rows, uiAsk, answer, setReviewSession, close, now: () => now };
}

const externalEffects = (db: ReturnType<typeof openLedger>) => ({
  intents: (db.query("SELECT COUNT(*) AS n FROM scheduler_intents").get() as { n: number }).n,
  resources: (db.query("SELECT COUNT(*) AS n FROM scheduler_resources").get() as { n: number }).n,
  sessions: (db.query("SELECT COUNT(*) AS n FROM scheduler_sessions").get() as { n: number }).n,
  schedulerMoves: (db.query("SELECT COUNT(*) AS n FROM events WHERE actor = 'scheduler' AND kind <> 'scheduler'").get() as { n: number }).n,
});

describe("T68e observe mode", () => {
  test("deliver → changes → fix → pass: each plan matches the expected step and PM matches produce no diff", async () => {
    const f = fixture();
    try {
      const restate = await f.observe();
      expect(restate.decision).toMatchObject({ kind: "intent", action: "dispatch", node: "restate", recipient: "agent-one" });
      expect(restate.event.data.route).toEqual({ kind: "route", route: "channel", transport: "tmux", family: "claude", fallbackReason: null });
      expect((await f.observe()).duplicate).toBe(true);
      moveStage(f.db, f.at("agent-one"), { taskId: "T1", from: "spec", to: "restate" });
      expect((await f.observe()).decision).toMatchObject({ kind: "wait", code: "pm_restate" });
      moveStage(f.db, f.at("owner"), { taskId: "T1", from: "restate", to: "build" });
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "dispatch", node: "write", recipient: "agent-one" });
      deliver(f.db, f.at("agent-one"), { taskId: "T1", headSHA: H1, moveFrom: "build" });
      assignStep(f.db, f.at("owner"), { taskId: "T1", step: "review", executor: "agent-review", executorKind: "agent" });
      const toReview = await f.observe();
      expect(toReview.decision).toMatchObject({ kind: "intent", action: "review", recipient: "agent-review" });
      expect(toReview.event.data.route).toMatchObject({ route: "acp", family: "codex" });
      f.dispatch(H1);
      expect((await f.observe()).decision).toMatchObject({ kind: "wait", code: "in_flight" });
      f.review("changes", H1, [P1, P2]);
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
      moveStage(f.db, f.at("owner"), { taskId: "T1", from: "review", to: "fix" });
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "dispatch", node: "fix", recipient: "agent-one" });
      deliver(f.db, f.at("agent-one"), { taskId: "T1", headSHA: H2, moveFrom: "fix" });
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "review", recipient: "agent-review" });
      f.dispatch(H2);
      await f.observe();
      f.review("pass", H2, [P2], "merge");
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "merge", node: "merge_deploy" });

      const diff = await runLedger(["scheduler-diff", "T1", "--all"], f.deps("owner"));
      const rows = diff.rows as { planned: string; verdict: string; note: string }[];
      expect(rows.filter((r) => r.verdict === "diff")).toEqual([]);
      expect(rows.at(-1)).toMatchObject({ verdict: "pending" });
      expect(rows.filter((r) => r.verdict === "unknown").map((r) => r.planned)).toEqual(["（结论后的计划没有记录）"]);
      expect(diff.lines).toContain("T1 · review 第 1 轮 · 一致 · 引擎：推阶段到 fix ｜ 实际：owner 推阶段 review→fix（阶段一致，0 秒后）");
      const project = await runLedger(["scheduler-diff", "--project", "p"], f.deps("owner"));
      expect(project).toMatchObject({ ok: true, tasks: ["T1"], summary: { diff: 0, unknown: 1, pending: 1 } });
      expect(project.lines).toEqual([
        "T1 · review 第 2 轮 · 未知 · 引擎：（结论后的计划没有记录） ｜ 实际：owner 推阶段 review→merge（审查结论之后直接推阶段、中间没有观察；当时的 session 与授权台账只存现状，无法还原引擎的判断，需核对，0 秒后）",
        "T1 · merge 第 2 轮 · 未决 · 引擎：进合并队列（合并后由 PM 部署） ｜ 实际：（还没有）（尚无后续动作）",
      ]);
      expect(externalEffects(f.db)).toEqual({ intents: 0, resources: 0, sessions: 0, schedulerMoves: 0 });
    } finally { f.close(); }
  });

  test("PM deviations show up in the diff: skipped dispatch record, advancing through an engine stop, another reviewer", async () => {
    const f = fixture();
    try {
      moveStage(f.db, f.at("agent-one"), { taskId: "T1", from: "spec", to: "restate" });
      moveStage(f.db, f.at("owner"), { taskId: "T1", from: "restate", to: "build" });
      deliver(f.db, f.at("agent-one"), { taskId: "T1", headSHA: H1, moveFrom: "build" });
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
      assignStep(f.db, f.at("owner"), { taskId: "T1", step: "review", executor: "agent-review", executorKind: "agent" });
      expect((await f.observe()).decision).toMatchObject({ kind: "intent", action: "review", recipient: "agent-review" });
      // PM never records `ledger dispatch`: the engine refuses the unsolicited result, PM pushes on anyway.
      f.review("changes", H1, [P1]);
      expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
      moveStage(f.db, f.at("owner"), { taskId: "T1", from: "review", to: "fix" });
      await f.observe();
      const diff = await runLedger(["scheduler-diff", "T1"], f.deps("owner"));
      const rows = diff.rows as { planned: string; actual: string; verdict: string; note: string }[];
      expect(rows).toContainEqual(expect.objectContaining({ verdict: "diff", planned: "停下升级（review_unsolicited）", actual: "推阶段 review→fix" }));
      expect(rows).toContainEqual(expect.objectContaining({ verdict: "diff", actual: "指派「review」给 agent-review",
        note: "引擎会新建本卡独立 session，PM 指派了现有 agent" }));
      expect((diff.summary as { diff: number }).diff).toBeGreaterThan(0);
    } finally { f.close(); }
  });

  test("re-observing is idempotent across restarts and duplicate ticks; only the scheduler or PM may write, never on non-observe cards", async () => {
    const f = fixture();
    try {
      const first = await f.observe();
      for (let i = 0; i < 3; i++) expect((await f.observe()).duplicate).toBe(true);
      const count = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "observe").length;
      expect(count()).toBe(1);
      expect(first.duplicate).toBe(false);
      expect((await runLedger(["scheduler-observe", "T1"], f.deps("agent-one"))).code).toBe("forbidden");
      expect((await runLedger(["scheduler-diff", "T1"], f.deps("scheduler"))).code).toBe("forbidden");
      const calls: string[][] = [];
      const manager = async (...args: string[]) => { calls.push(args); return runLedger(args.slice(1), f.deps("scheduler")); };
      const tick = await schedulerObserveTick(f.db, { p: { maxActiveWorkers: 3 } }, manager);
      expect(tick).toEqual({ recorded: 0, unchanged: 1, failed: [] });
      expect(calls).toEqual([["ledger", "scheduler-observe", "T1", "--max-workers", "3"]]);
      const fb = await runLedger(["scheduler-fallback-manual", "T1", "--reason", "peer 委托本段不自动派"], f.deps("scheduler"));
      expect(fb).toMatchObject({ ok: true, workflow: { mode: "manual" } });
      expect((await runLedger(["scheduler-observe", "T1"], f.deps("scheduler"))).code).toBe("conflict");
      expect(await schedulerObserveTick(f.db, { p: { maxActiveWorkers: 3 } }, manager)).toEqual({ recorded: 0, unchanged: 0, failed: [] });
    } finally { f.close(); }
  });

  test("a card delegated to a peer is observed as manual with the reason, and can be handed back to PM", async () => {
    const f = fixture();
    try {
      assignStep(f.db, f.at("owner"), { taskId: "T1", step: "write", executor: "agent-x@far", executorKind: "peer" });
      const seen = await f.observe();
      expect(seen.decision).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "author" });
      expect(seen.event.data.route).toEqual({ kind: "manual", reason: "peer 委托（agent-x@far）本段不自动派，退回 manual" });
      const fb = await runLedger(["scheduler-fallback-manual", "T1", "--reason", "peer 委托本段不自动派", "--intent", seen.event.data.sig as string], f.deps("scheduler"));
      expect(fb).toMatchObject({ ok: true, duplicate: false, workflow: { mode: "manual" } });
      const again = await runLedger(["scheduler-fallback-manual", "T1", "--reason", "peer 委托本段不自动派", "--intent", seen.event.data.sig as string], f.deps("scheduler"));
      expect(again).toMatchObject({ ok: true, duplicate: true });
      expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fallback_manual")).toHaveLength(1);
    } finally { f.close(); }
  });

  test("structured review is all-or-nothing and must match the task head", async () => {
    const f = fixture();
    try {
      moveStage(f.db, f.at("agent-one"), { taskId: "T1", from: "spec", to: "restate" });
      moveStage(f.db, f.at("owner"), { taskId: "T1", from: "restate", to: "build" });
      deliver(f.db, f.at("agent-one"), { taskId: "T1", headSHA: H1, moveFrom: "build" });
      expect(() => recordReview(f.db, f.at("owner"), { taskId: "T1", reviewer: "agent-review", verdict: "pass", p0: 0, p1: 0, p2: 0, head: H1 }))
        .toThrow(/同时带/);
      expect(() => f.review("pass", H2, [])).toThrow(/head/);
      expect(() => f.review("changes", H1, [{ ...P1, severity: "P0" }])).toThrow(/计数/);
      const dir = mkdtempSync(join(tmpdir(), "t68e-findings-")), file = join(dir, "findings.json");
      writeFileSync(file, JSON.stringify([P2]));
      const r = await runLedger(["review", "T1", "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "1",
        "--path", "reviews/T1-r1/report.md", "--head", H1, "--session", "s-review", "--family", "codex", "--findings", file], f.deps("owner"));
      expect(r.ok).toBe(true);
      expect((r.event as { data: Record<string, unknown> }).data).toMatchObject({ head: H1, reviewerSessionId: "s-review", reviewerFamily: "codex", findings: [P2] });
      rmSync(dir, { recursive: true, force: true });
    } finally { f.close(); }
  });

  test("P1-1 regression: a verdict never vouches for its own dispatch, reviewer or session", async () => {
    const f = fixture();
    try {
      f.toReview();
      expect((await f.observe()).decision).toMatchObject({ action: "review", recipient: "agent-review" });
      f.dispatch(H1, "regular");
      await f.observe();
      f.review("pass", H1, [], undefined, ["agent-other", "nonexistent-session"]);
      expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
      const rows = await f.rows();
      expect(rows).toContainEqual(expect.objectContaining({ verdict: "diff", actual: "派审（regular）" }));
      expect(rows.filter((r) => r.verdict === "match")).toHaveLength(0);
    } finally { f.close(); }
    for (const who of [["agent-other", "s-other"], ["agent-review", "nonexistent-session"]]) {
      const g = fixture();
      try {
        g.toReview();
        g.dispatch(H1);
        await g.observe();
        g.review("pass", H1, [], undefined, who);
        expect((await g.observe()).decision).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
        moveStage(g.db, g.at("owner"), { taskId: "T1", from: "review", to: "merge" });
        await g.observe();
        expect(await g.rows()).toContainEqual(expect.objectContaining({ verdict: "diff", planned: "停下升级（review_unsolicited）", actual: "推阶段 review→merge" }));
      } finally { g.close(); }
    }
  });

  test("P1-2 regression: review --to is never a match; with an observation after the verdict round 3 is a three-P1 stop", async () => {
    for (const observed of [false, true]) {
      const f = fixture();
      try {
        f.toReview();
        for (let r = 1; r <= 3; r++) {
          f.dispatch(H1);
          await f.observe();
          f.review("changes", H1, [P1], observed ? undefined : "fix");
          await f.observe();
          if (observed) moveStage(f.db, f.at("owner"), { taskId: "T1", from: "review", to: "fix" });
          if (r < 3) deliver(f.db, f.at("agent-one"), { taskId: "T1", headSHA: H1, moveFrom: "fix" });
        }
        await f.observe();
        const moves = (await f.rows()).filter((r) => r.actual === "推阶段 review→fix").map((r) => [r.verdict, r.planned]);
        expect(moves).toEqual(observed ? [["match", "推阶段到 fix"], ["match", "推阶段到 fix"], ["diff", "停下升级（three_p1_rounds）"]]
          : Array(3).fill(["unknown", "（结论后的计划没有记录）"]));
      } finally { f.close(); }
    }
  });

  test("r2 P1 regression: facts that appear after the verdict never make an earlier move look planned", async () => {
    // A: PM moves to merge with the verdict, the owner approves the screenshots only afterwards.
    const f = fixture("ui");
    try {
      f.toReview();
      f.dispatch(H1);
      await f.observe();
      f.review("pass", H1, [], "merge");
      f.answer(f.uiAsk(H1).id, "ok");
      await f.observe();
      const rows = await f.rows();
      expect(rows.find((r) => r.actual === "推阶段 review→merge")).toMatchObject({ verdict: "unknown" });
      expect(rows.filter((r) => r.verdict === "match" && r.actual === "推阶段 review→merge")).toEqual([]);
    } finally { f.close(); }
    // B: PM records a verdict from a session that was not dispatched; the registry moves to that session afterwards.
    const g = fixture();
    try {
      g.toReview();
      g.dispatch(H1);
      await g.observe();
      g.review("pass", H1, [], "merge", ["agent-review", "s-future"]);
      g.setReviewSession("s-future");
      await g.observe();
      const rows = await g.rows();
      expect(rows.find((r) => r.actual === "推阶段 review→merge")).toMatchObject({ verdict: "unknown" });
      expect(rows.filter((r) => r.verdict === "match" && r.actual === "推阶段 review→merge")).toEqual([]);
    } finally { g.close(); }
  });

  test("P1-3 regression: the owner's real screenshot ask is projected — none / open / approved / rejected / stale", async () => {
    const f = fixture("ui");
    try {
      f.toReview();
      f.dispatch(H1);
      await f.observe();
      f.review("pass", H1, []);
      expect((await f.observe()).decision).toMatchObject({ action: "ask" });
      const { uiAsk: ask, answer } = f;
      const a = ask(H1);
      expect((await f.observe()).decision).toMatchObject({ kind: "wait", code: "owner_screenshot" });
      answer(a.id, "ok");
      expect((await f.observe()).decision).toMatchObject({ action: "stage", targetStage: "merge" });
      answer(ask(H1).id, "no");
      expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "ui_rejected" });
      answer(ask(H2).id, "ok");
      expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "ui_stale" });
      answer(ask(H1, "agent-one").id, "ok");
      expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "ui_stale" });
    } finally { f.close(); }
  });

  test("r2 P2 regression: only an answer carrying the authenticated owner mark counts as the owner's approval", async () => {
    const f = fixture("ui");
    try {
      f.toReview();
      f.dispatch(H1);
      await f.observe();
      f.review("pass", H1, []);
      for (const mark of [{}, { external: true }]) {
        f.answer(f.uiAsk(H1).id, "ok", mark);
        expect((await f.observe()).decision).toMatchObject({ kind: "escalate", code: "ui_unverified" });
      }
      f.answer(f.uiAsk(H1).id, "ok");
      expect((await f.observe()).decision).toMatchObject({ action: "stage", targetStage: "merge" });
    } finally { f.close(); }
  });

  test("P2-1 regression: a changed work order is a new observation and the record carries the findings", async () => {
    const f = fixture();
    try {
      f.toReview();
      f.dispatch(H1);
      await f.observe();
      f.review("changes", H1, [P1]);
      const first = await f.observe();
      f.review("changes", H1, [{ ...P1, findingId: "race-2", probe: "probe B" }]);
      const second = await f.observe();
      expect(second.duplicate).toBe(false);
      expect(first.event.data.decision).toMatchObject({ workOrder: { findings: [{ findingId: "race-1" }] } });
      expect(second.event.data.decision).toMatchObject({ workOrder: { findings: [{ findingId: "race-2", probe: "probe B" }] } });
    } finally { f.close(); }
  });
});
