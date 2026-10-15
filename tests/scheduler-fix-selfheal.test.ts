/**
 * SELFHEAL1 验收线 1 / 2 / 6 + PM 补（fix→review 只给「无 P1 自动回审」）：planner 单元（合成快照）与真台账 + 真 CLI 的整轮（autoFixture）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { moveStage } from "../src/lib/ledger-write.js";
import { configureSelfHealMode, SELF_HEAL_MARK, selfHealRefusal } from "../src/lib/scheduler-fix-selfheal.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { autoFixture, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

let restore: (() => void) | null = null;
const mode = (m: RecoveryMode) => { restore?.(); restore = configureSelfHealMode(() => m); };
afterEach(() => { restore?.(); restore = null; });

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}, text = ""): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text, dedupKey: null });
const task = (stage: Stage, round: number): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "T", kind: "code", stage, stageBefore: null, round,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow = (m: TaskWorkflow["mode"] = "auto"): TaskWorkflow => ({
  taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: m, authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1,
});
const review = (seq: number, round: number, findings: { findingId: string; family: string; severity: string; probe: string }[], head = HEAD): LedgerEvent =>
  event(seq, "review", { round, head, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: "codex",
    path: `reviews/T1-r${round}/report.md`, verdict: "changes", findings,
    p0: 0, p1: findings.filter((f) => f.severity === "P1").length, p2: findings.filter((f) => f.severity === "P2").length });
const p2 = { findingId: "n-1", family: "naming", severity: "P2", probe: "rename" };
const p1 = { findingId: "r-1", family: "race", severity: "P1", probe: "[验收线 1] race" };
/** Fix stage, round 1, the round-1 review in `rv` (none = report missing). */
const fixSnap = (rv: LedgerEvent[]): PlannerSnapshot => ({
  task: task("fix", 1), workflow: workflow(), intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  events: [event(1, "task", { op: "new" }), event(10, "stage", { from: "build", to: "review", round: 1, specRev: 1 }), event(15, "deliver", { round: 1, headSHA: HEAD }),
    ...rv, event(25, "stage", { from: "review", to: "fix", round: 1, specRev: 1 })],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer, reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const healed = (seq: number, head = HEAD) => event(seq, "stage", { from: "fix", to: "review", round: 1, specRev: 1 }, `${SELF_HEAL_MARK}：… head ${head} …`);

describe("[验收线 1] fix 阶段收敛后没有 P1", () => {
  test("先红后绿：off 与改前逐字一致（fix_report 退人工）；on 规划成 fix→review 的 stage 意图，依据报告写进原因", () => {
    const s = fixSnap([review(20, 1, [p2])]);
    mode("off");
    expect(planScheduler(s)).toEqual({ kind: "escalate", code: "fix_report", reason: "修复阶段没有 P1，需 PM 核对为什么退回" });
    mode("on");
    const d = planScheduler(s);
    expect(d).toMatchObject({ kind: "intent", action: "stage", node: "fix", targetStage: "review", observedOnly: false, resources: ["task:s1"] });
    if (d.kind !== "intent") throw new Error("intent");
    expect(d.id).toBe("t68:s25:r1:fix:a0");
    for (const s of [SELF_HEAL_MARK, HEAD, "reviews/T1-r1/report.md", "selfHealBeforeManual"]) expect(d.reason).toContain(s);
  });

  test("observe：照旧退 fix_report，原因后附一句恢复观察", () => {
    mode("observe");
    const d = planScheduler(fixSnap([review(20, 1, [p2])]));
    expect(d).toMatchObject({ kind: "escalate", code: "fix_report" });
    if (d.kind !== "escalate") throw new Error("escalate");
    expect(d.reason).toStartWith("修复阶段没有 P1，需 PM 核对为什么退回；恢复观察 selfHealBeforeManual：本会自救");
  });

  test("同一个 head 只一次：已有带标记的 fix→review 事件就照旧 fix_report；换了 head 的旧标记不算", () => {
    mode("on");
    const s = fixSnap([healed(5), review(20, 1, [p2])]);
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "fix_report" });
    expect(planScheduler(fixSnap([healed(5, "b".repeat(40)), review(20, 1, [p2])]))).toMatchObject({ kind: "intent", targetStage: "review" });
  });

  test("回审前核对：新交付 / head 与最近审查结论不同 / 轮次或规格变了 / 卡不是 auto，任一条都不回审", () => {
    mode("on");
    const base = fixSnap([review(20, 1, [p2])]);
    const delivered = { ...base, events: [...base.events, event(30, "deliver", { round: 1, headSHA: HEAD })] };
    expect(selfHealRefusal(delivered, null)).toContain("新交付");
    expect(planScheduler(delivered)).toMatchObject({ kind: "escalate", code: "fix_report" });
    const moved = fixSnap([review(20, 1, [p2], "c".repeat(40))]);
    expect(selfHealRefusal(moved, null)).toContain("head");
    const round = { ...base, events: base.events.map((e) => e.seq === 25 ? event(25, "stage", { from: "review", to: "fix", round: 0, specRev: 1 }) : e) };
    expect(selfHealRefusal(round, null)).toContain("轮次");
    const spec = { ...base, events: base.events.map((e) => e.seq === 25 ? event(25, "stage", { from: "review", to: "fix", round: 1, specRev: 0 }) : e) };
    expect(selfHealRefusal(spec, null)).toContain("规格");
    expect(selfHealRefusal({ ...base, workflow: workflow("observe") }, null)).toContain("自动流程");
  });
});

describe("[验收线 2] 缺上一轮完整审查报告", () => {
  test("on：回 review 让审查重出一份，只一次；本轮那份不完整结论里还有 P1 就不回审", () => {
    mode("off");
    const missing = fixSnap([review(20, 0, [p2])]); // no round-1 review: fixStartReviewFacts none
    expect(planScheduler(missing)).toEqual({ kind: "escalate", code: "fix_report", reason: "修复阶段缺上一轮完整审查报告" });
    mode("on");
    const d = planScheduler(missing);
    expect(d).toMatchObject({ kind: "intent", action: "stage", targetStage: "review" });
    if (d.kind === "intent") expect(d.reason).toContain("缺上一轮完整审查报告");
    expect(planScheduler({ ...missing, events: [...missing.events, healed(26)] })).toMatchObject({ kind: "escalate", code: "fix_report" });
    const broken = review(20, 1, [p1]);
    broken.data.path = ""; // invalid report, but it still names a P1
    expect(planScheduler(fixSnap([broken]))).toMatchObject({ kind: "escalate", code: "fix_report" });
  });
});

describe("[验收线 6] PM 切 manual / 只有这条决定能推 fix→review", () => {
  test("manual 卡不自救（照旧 wait manual）", () => {
    mode("on");
    expect(planScheduler({ ...fixSnap([review(20, 1, [p2])]), workflow: workflow("manual") })).toMatchObject({ kind: "wait", code: "manual" });
  });

  test("有 P1 的正常 fix 照旧派作者，不会规划出 fix→review", () => {
    mode("on");
    expect(planScheduler(fixSnap([review(20, 1, [p1])]))).toMatchObject({ kind: "intent", action: "dispatch" });
  });

  test("源码里只有 scheduler-fix-selfheal.ts 规划 targetStage review", () => {
    const dir = join(import.meta.dir, "../src/lib");
    const hits = readdirSync(dir).filter((f) => f.endsWith(".ts") && /targetStage: "review"/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual(["scheduler-fix-selfheal.ts"]);
  });
});

describe("整轮（真台账 + 真 CLI）", () => {
  /** Write → deliver H1 → round-1 review (`rows`) → PM pushes review→fix by hand (the only way into fix with no P1 left). */
  async function atFix(rows: object[]) {
    const f = autoFixture();
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    await f.tick();
    await f.tick();
    expect((await f.review("changes", H1, rows)).ok).toBe(true);
    moveStage(f.db, f.at("pm"), { taskId: "T1", from: "review", to: "fix" });
    return f;
  }

  test("先红后绿：off 退人工；on 推 review、round+1、记『无 P1 自动回审』与依据报告，再照常派新一轮审查；同 head 第二次退人工", async () => {
    mode("off");
    const red = await atFix([P2]);
    try {
      expect(await red.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("修复阶段没有 P1") });
    } finally { red.close(); }

    mode("on");
    const f = await atFix([P2]);
    try {
      expect(f.task()).toMatchObject({ stage: "fix", round: 1 });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "fix→review" });
      expect(f.task()).toMatchObject({ stage: "review", round: 2, headSHA: H1 });
      const moved = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "stage")!;
      expect(moved.data).toMatchObject({ from: "fix", to: "review", round: 2 });
      expect(moved.text).toContain(SELF_HEAL_MARK);
      expect(moved.text).toContain("reviews/T1-r1/report.md");
      const sent = f.sent.length;
      await f.tick();
      expect(f.intents().at(-1)).toMatchObject({ action: "review" });
      expect(f.sent.length).toBe(sent + 1); // a new round-2 order to the reviewer, not the round-1 report reused
      expect(f.pins.at(-1)).toBe(H1);

      expect((await f.review("changes", H1, [P2])).ok).toBe(true);
      moveStage(f.db, f.at("pm"), { taskId: "T1", from: "review", to: "fix" });
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("修复阶段没有 P1") });
    } finally { f.close(); }
  });

  test("observe：真 tick 照旧退人工，且经执行侧写恰好一条 recovery_observe 样本（卡 + head + 轮次去重）", async () => {
    mode("observe");
    const f = await atFix([P2]);
    try {
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("恢复观察 selfHealBeforeManual") });
      const samples = () => listEvents(f.db, { project: "p", target: "T1" })
        .filter((e) => e.kind === "note" && e.data.op === "recovery_observe" && e.data.mechanism === "selfHealBeforeManual");
      expect(samples()).toHaveLength(1);
      expect(samples()[0]!.data).toMatchObject({ kind: "fix_selfheal", mode: "observe", head: H1, round: 1, basis: "no_p1", actionKey: `fix-selfheal:${H1}:r1` });
      expect(samples()[0]!.text).toContain(SELF_HEAL_MARK);
      expect(f.task().stage).toBe("fix");
    } finally { f.close(); }
  });

  test("off：真 tick 退人工，不写样本", async () => {
    mode("off");
    const f = await atFix([P2]);
    try {
      expect(await f.tick()).toMatchObject({ step: "manual" });
      expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe")).toEqual([]);
    } finally { f.close(); }
  });

  test("有新交付（head 变了）就不回审：照常进 review 新 head，不走自救", async () => {
    mode("on");
    const f = await atFix([P1]);
    try {
      expect(await f.tick()).toMatchObject({ step: "sent" }); // P1: the ordinary fix order to the author
      await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
      expect(f.task()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
      expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.kind === "stage" && e.text.includes(SELF_HEAL_MARK))).toBe(false);
    } finally { f.close(); }
  });

  test("别的决定拿不到 fix>review：手工登记的 fix 节点 stage 意图推 review 被台账按重算拒掉", async () => {
    mode("on");
    const f = await atFix([P1]);
    try {
      const seq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
      const id = `t68:s${seq}:r1:fix:a0`;
      expect((await f.cli("scheduler", "scheduler-plan", "T1", "--id", id, "--rev", String(f.task().rev), "--workflow-rev", "1",
        "--seq", String(seq), "--node", "fix", "--action", "stage", "--reason", "x", "--resources", "task:s1")).ok).toBe(true);
      expect(await f.cli("scheduler", "scheduler-stage", id, "--to", "review")).toMatchObject({ ok: false, code: "conflict" });
      expect(f.task().stage).toBe("fix");
    } finally { f.close(); }
  });
});
