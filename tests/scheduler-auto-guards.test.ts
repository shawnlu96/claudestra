import { describe, expect, test } from "bun:test";
import { answerAsk, getAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture, DIGEST, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

const wf = (mode: string, rev: number, extra: string[] = []) =>
  ["workflow-set", "T2", "--rev", String(rev), "--template", "code", "--version", "2", "--mode", mode, "--author-family", "codex", "--fallback", "退回人工", ...extra];

describe("T68f auto opt-in and PM takeover", () => {
  test("auto only for new spec cards; an in-flight card is refused with the reason; auto→manual needs a reason", async () => {
    const f = autoFixture();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "in flight", kind: "code" });
      moveStage(f.db, f.at("owner"), { taskId: "T2", from: "spec", to: "restate" });
      const late = await f.cli("pm", ...wf("auto", 2));
      expect(late).toMatchObject({ ok: false, code: "invalid" });
      expect(String(late.error)).toContain("T2 是在途卡（restate）");

      const t3 = createTask(f.db, f.at("owner"), { project: "p", id: "T3", title: "new", kind: "code" }).row;
      expect((await f.cli("pm", ...wf("auto", t3.rev).map((a) => a === "T2" ? "T3" : a))).ok).toBe(true);
      expect((await f.cli("pm", ...wf("manual", t3.rev, ["--workflow-rev", "1"]).map((a) => a === "T2" ? "T3" : a))))
        .toMatchObject({ ok: false, error: expect.stringContaining("要带 --reason") });
      const back = await f.cli("pm", ...wf("manual", t3.rev, ["--workflow-rev", "1", "--reason", "owner 要亲自盯"]).map((a) => a === "T2" ? "T3" : a));
      expect(back.ok).toBe(true);
      const ev = listEvents(f.db, { project: "p", target: "T3" }).findLast((e) => e.kind === "scheduler");
      expect(ev?.data).toMatchObject({ op: "workflow", mode: "manual", takeover: "owner 要亲自盯", manual: true });
      expect((await f.cli("pm", ...wf("auto", t3.rev, ["--workflow-rev", "2"]).map((a) => a === "T2" ? "T3" : a))).ok).toBe(true); // still spec
    } finally { f.close(); }
  });

  test("restate-approve is PM-only and only for auto cards sitting in restate", async () => {
    const f = autoFixture();
    try {
      expect(await f.cli("pm", "restate-approve", "T1")).toMatchObject({ ok: false, code: "conflict" });
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate");
      expect(await f.cli("agent-task-one", "restate-approve", "T1")).toMatchObject({ ok: false, code: "forbidden" });
      expect((await f.cli("pm", "restate-approve", "T1")).ok).toBe(true);
    } finally { f.close(); }
  });
});

describe("T68f review writes on auto cards", () => {
  async function atReview() {
    const f = autoFixture();
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    await f.tick();
    await f.tick();
    return f;
  }

  test("nobody moves an auto card with review --to, PM included; the bound reviewer writes its own verdict only", async () => {
    const f = await atReview();
    try {
      expect(await f.review("changes", H1, [P1], ["--to", "fix"])).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.review("changes", H1, [P1], ["--to", "fix"], "pm")).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("自动卡") });
      expect(await f.review("changes", H1, [P1], [], "agent-task-one")).toMatchObject({ ok: false, code: "forbidden" });
      const wrongSession = await f.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0");
      expect(wrongSession).toMatchObject({ ok: false, code: "forbidden" });
      expect((await f.review("changes", H1, [P1])).ok).toBe(true);
      expect(f.task().stage).toBe("review");
    } finally { f.close(); }
  });

  test("stage intents are scheduler-only and replay-safe; one made stale by a PM move is refused and cancelled", async () => {
    const f = await atReview();
    try {
      await f.review("changes", H1, [P1]);
      const plan = planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
      if (plan.kind !== "intent") throw new Error("expected a stage intent");
      const seq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
      expect((await f.cli("scheduler", "scheduler-plan", "T1", "--id", plan.id, "--rev", String(f.task().rev), "--workflow-rev", "1",
        "--seq", String(seq), "--node", plan.node, "--action", plan.action, "--reason", plan.reason, "--resources", plan.resources.join(","))).ok).toBe(true);
      expect(await f.cli("pm", "scheduler-stage", plan.id, "--to", "fix")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("scheduler", "scheduler-stage", plan.id, "--to", "merge")).toMatchObject({ ok: false, code: "conflict" });
      moveStage(f.db, f.at("pm"), { taskId: "T1", from: "review", to: "blocked" });
      expect(await f.cli("scheduler", "scheduler-stage", plan.id, "--to", "fix")).toMatchObject({ ok: false, code: "conflict" });
      expect(await f.tick()).toMatchObject({ step: "replan" });
      expect(f.intents().find((i) => i.id === plan.id)).toMatchObject({ status: "cancelled" });
    } finally { f.close(); }
  });

  test("replaying an applied stage intent is a no-op", async () => {
    const f = await atReview();
    try {
      await f.review("changes", H1, [P1]);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      const id = f.intents().findLast((i) => i.action === "stage")!.id;
      expect(await f.cli("scheduler", "scheduler-stage", id, "--to", "fix")).toMatchObject({ ok: true, duplicate: true });
      expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "stage" && e.data.to === "fix")).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("T68f UI screenshot gate", () => {
  test("pass on a ui card opens one bound owner ask; approval lets the planner move to merge and plan the merge intent", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
      await f.tick();
      await f.tick();
      await f.review("pass", H2, [P2]);
      const opened = await f.tick();
      expect(opened).toMatchObject({ step: "ask" });
      const askId = opened!.detail.replace("ask ", "");
      const ask = getAsk(f.db, askId)!;
      expect(ask).toMatchObject({ fromAgent: "scheduler", kind: "authorize", taskId: "T1", state: "open" });
      expect(ask.bind?.params).toEqual({ task: "T1", specRev: 1, head: H2, screenshotsDigest: DIGEST });
      for (let i = 0; i < 2; i++) expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 owner 看前后截图" });
      expect(f.db.query("SELECT COUNT(*) AS n FROM asks").get()).toEqual({ n: 1 });

      answerAsk(f.db, askId, { choices: ["[button:scheduler_ui_approve]"], labels: ["批准合并"], principal: "owner", owner: true, via: "web_card", at: 5000 } as never);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(f.intents().at(-1)).toMatchObject({ action: "merge", status: "pending" });
    } finally { f.close(); }
  });

  test("a guest pressing approve does not release the merge", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
      await f.tick();
      await f.tick();
      await f.review("pass", H2, []);
      const askId = (await f.tick())!.detail.replace("ask ", "");
      answerAsk(f.db, askId, { choices: ["[button:scheduler_ui_approve]"], labels: ["批准合并"], principal: "guest-1", external: true, via: "web_card", at: 5000 } as never);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("ui_unverified") });
      expect(f.intents().some((i) => i.action === "merge")).toBe(false);
    } finally { f.close(); }
  });

  test("a rejected screenshot ask sends the card back to PM", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
      await f.tick();
      await f.tick();
      await f.review("pass", H2, []);
      const askId = (await f.tick())!.detail.replace("ask ", "");
      answerAsk(f.db, askId, { choices: ["[button:scheduler_ui_reject]"], labels: ["不批准"], principal: "owner", owner: true, via: "web_card", at: 5000 } as never);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("ui_rejected") });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    } finally { f.close(); }
  });
});
