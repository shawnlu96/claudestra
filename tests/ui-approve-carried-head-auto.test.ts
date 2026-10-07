/** Automatic UI cards use the same journal/refusal gate; an expired screenshot stays a PM decision in merge. */
import { expect, test } from "bun:test";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift } from "../src/lib/scheduler-merge.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { setTask } from "../src/lib/ledger-write.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { autoFixture, DIGEST, H2, toBuild } from "./scheduler-auto-helpers.js";

const NEXT = "3".repeat(40), MAIN = "4".repeat(40);
test("automatic UI: carried head needs merge reapproval; existing notice is only in review", async () => {
  const f = autoFixture({ template: "ui" });
  try {
    await toBuild(f); await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
    await f.tick(); await f.tick(); await f.review("pass", H2, []);
    await f.tick();
    const screenshotNotices = () => f.notices.filter((s) => s.includes("截图摘要："));
    expect(screenshotNotices()).toHaveLength(1);
    expect(await f.cli("pm", "ui-approve", "T1", "--head", H2, "--digest", DIGEST)).toMatchObject({ ok: true });
    await f.tick();
    setTask(f.db, f.at("pm"), { id: "T1", rev: f.task().rev, patch: { pr: "https://github.com/o/r/pull/7", branch: "task/T1" } });
    await f.tick();
    const intent = f.intents().findLast((i) => i.action === "merge")!.id;
    expect(await f.cli("scheduler", "scheduler-settle", intent, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
    beginMergeRun(f.db, f.at("scheduler"), intent, ["check"]);
    const step = (from: "ready" | "updating", to: "updating" | "await_ci", receipt?: string, newHead?: string) =>
      advanceMergeRun(f.db, f.at("scheduler"), { intentId: intent, from, to, rev: getMergeRun(f.db, intent)!.rev, receipt, newHead });
    step("ready", "updating");
    step("updating", "await_ci", carryReceipt({ oldHead: H2, newHead: NEXT, mainParent: MAIN, mainHead: MAIN, diffHash: "a".repeat(64) }) +
      carryChainSuffix([{ previousHead: H2, head: NEXT, mainParent: MAIN }]), NEXT);
    const round = f.task().round;
    expect(mergeRunDrift(f.db, getMergeRun(f.db, intent)!, 10_000)).toContain("UI 截图验收已失效");
    advanceMergeRun(f.db, f.at("scheduler"), { intentId: intent, from: "await_ci", to: "unknown",
      rev: getMergeRun(f.db, intent)!.rev, receipt: "UI 截图验收已失效" });
    expect(await f.cli("pm", "scheduler-merge-resolve", intent, "--outcome", "failed", "--receipt", "gh confirms no merge sent")).toMatchObject({ ok: true });
    const resume = () => f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev),
      "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--reason", "PM reconciled merge, same review");
    expect(await f.cli("pm", "unfreeze", "--project", "p", "--text", "no other unknown merges")).toMatchObject({ ok: true });
    expect(await resume()).toMatchObject({ ok: true });
    const plan = () => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 10_000 }));
    expect(plan()).toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
    expect(plan()).toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(f.notices.at(-1)).toContain("退回人工，请接手：merge_ui_unapproved");
    const noticeCount = f.notices.length;
    await f.tick(); expect(f.notices).toHaveLength(noticeCount);
    expect(listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.data.op === "fallback_manual")!.data.reason).toContain("merge_ui_unapproved");
    expect(screenshotNotices()).toHaveLength(1);
    const approved = await f.cli("pm", "ui-approve", "T1", "--head", NEXT, "--digest", DIGEST);
    expect(approved).toMatchObject({ ok: true, event: { data: { carriedFrom: H2 } } });
    expect(f.task()).toMatchObject({ stage: "merge", round });
    expect(await resume()).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const retry = f.intents().findLast((i) => i.action === "merge")!;
    expect(retry.id).not.toBe(intent);
    expect(await f.cli("scheduler", "scheduler-settle", retry.id, "--from", "pending", "--to", "submitted", "--receipt", "new head claimed")).toMatchObject({ ok: true });
    expect(beginMergeRun(f.db, f.at("scheduler"), retry.id, ["check"])).toMatchObject({ run: { phase: "ready", reviewedHead: NEXT } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review")).toHaveLength(1);
  } finally { f.close(); }
}, 60_000);
