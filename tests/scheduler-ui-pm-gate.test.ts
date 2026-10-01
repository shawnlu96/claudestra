/**
 * i28-U1: a UI card's screenshots go to PM by default (ui-approve / ui-reject), only an ownerVisual card opens the owner ask.
 * Covers the four acceptance lines: no owner ask on a default card, PM's word never releases an ownerVisual card, PM's
 * acceptance is bound to head / specRev / round / digest, and only managers record it. Real ledger CLI in-process.
 */
import { describe, expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { appendEvent, setTask } from "../src/lib/ledger-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { uiMergeRefusal, uiRejectFix, UI_APPROVED } from "../src/lib/scheduler-ui-gate.js";
import { autoFixture, DIGEST, H2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const H3 = "3".repeat(40);

/** A UI card whose review on H2 just passed; the next tick decides who looks at the screenshots. */
async function passed(opts: { ownerVisual?: boolean; before?: (f: F) => Promise<unknown> } = {}): Promise<F> {
  const f = autoFixture({ template: "ui", ownerVisual: opts.ownerVisual });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  await opts.before?.(f);
  await f.review("pass", H2, []);
  return f;
}

const asks = (f: F) => (f.db.query("SELECT COUNT(*) AS n FROM asks WHERE kind = 'authorize'").get() as { n: number }).n;
const approve = (f: F, actor = "pm", head = H2, digest = DIGEST) => f.cli(actor, "ui-approve", "T1", "--head", head, "--digest", digest);
const plan = (f: F) => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 10_000 }));
const forgeApproval = (f: F, actor: string) => appendEvent(f.db, f.at(actor), { project: "p", target: "T1", kind: "decision",
  data: { op: UI_APPROVED, head: H2, specRev: 1, round: f.task().round, screenshotsDigest: DIGEST } });

describe("default ui card: PM accepts the screenshots", () => {
  test("a pass notifies PM once with the images and bound commands, opens no owner ask, then waits", async () => {
    const f = await passed();
    try {
      const before = f.notices.length;
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice") });
      expect(asks(f)).toBe(0);
      expect(f.notices).toHaveLength(before + 1);
      const text = f.notices.at(-1)!;
      for (const s of ["before.png", "after.png", `截图摘要：${DIGEST}`, `ui-approve T1 --head ${H2} --digest ${DIGEST}`, "ui-reject T1"]) expect(text).toContain(s);
      for (let i = 0; i < 2; i++) expect(await f.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("等待 PM 看前后截图") });
      expect(f.notices).toHaveLength(before + 1);
      expect(asks(f)).toBe(0);
    } finally { f.close(); }
  });

  test("a failed notice leaves the intent pending and is sent on the next pass", async () => {
    const f = await passed();
    try {
      const notify = f.tickDeps.notifyPm;
      f.tickDeps.notifyPm = async () => { throw new Error("bridge down"); };
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("没发出去") });
      expect(f.intents().at(-1)).toMatchObject({ action: "ask", status: "pending" });
      f.tickDeps.notifyPm = notify;
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice 已发") });
      expect(f.intents().at(-1)).toMatchObject({ action: "ask", status: "done" });
    } finally { f.close(); }
  });

  test("only a real manager records ui-approve, and only for the head / digest on the card; then the card merges", async () => {
    const f = await passed();
    try {
      await f.tick();
      for (const who of ["agent-task-one", "agent-rv-t1", "scheduler"]) expect(await approve(f, who)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", "ui-reject", "T1", "--text", "自己退")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", "ui-owner-visual", "T1", "off")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await approve(f, "pm", H3)).toMatchObject({ ok: false, code: "conflict" });
      expect(await approve(f, "pm", H2, "e".repeat(64))).toMatchObject({ ok: false, code: "conflict" });
      expect(await f.cli("pm", "ui-approve", "T1", "--head", H2)).toMatchObject({ ok: false, code: "invalid" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toContain("PM 截图验收");
      expect(await approve(f)).toMatchObject({ ok: true, event: { data: { op: UI_APPROVED, head: H2, specRev: 1, round: f.task().round } } });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toBeNull();
      expect(asks(f)).toBe(0);
    } finally { f.close(); }
  });

  test("an approval written by a non-manager is ignored by the gate even when it carries the right binding", async () => {
    const f = await passed();
    try {
      await f.tick();
      forgeApproval(f, "agent-task-one");
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(f.task().stage).toBe("review");
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).not.toBeNull();
    } finally { f.close(); }
  });

  test("the acceptance is bound: a new head, round, specRev or digest voids it in the planner and in the merge write", async () => {
    const f = await passed();
    try {
      await f.tick();
      expect(await approve(f)).toMatchObject({ ok: true });
      const t = f.task();
      const twists: [string, string, unknown][] = [["headSHA", "headSHA", H3], ["round", "round", t.round + 1], ["specRev", "specRev", t.specRev + 1],
        ["extra", "extra", JSON.stringify({ ...t.extra, screenshotsDigest: "e".repeat(64) })]];
      for (const [col, , value] of twists) {
        f.db.query(`UPDATE tasks SET ${col} = ? WHERE id = 'T1'`).run(value as string);
        expect(uiMergeRefusal(f.db, f.task(), 10_000)).not.toBeNull();
        expect(plan(f)).not.toMatchObject({ kind: "intent", targetStage: "merge" });
        f.db.query(`UPDATE tasks SET ${col} = ? WHERE id = 'T1'`).run((col === "extra" ? JSON.stringify(t.extra) : t[col as "round"]) as never);
      }
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toBeNull();
    } finally { f.close(); }
  });

  test("ui-reject sends the card to fix with PM's words as the one P1 of the fix order", async () => {
    const f = await passed();
    try {
      await f.tick();
      expect(await f.cli("pm", "ui-reject", "T1")).toMatchObject({ ok: false, code: "invalid" });
      expect(await f.cli("pm", "ui-reject", "T1", "--text", "深色模式下按钮看不清")).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      const fix = uiRejectFix(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
      expect(fix?.findings).toEqual([expect.objectContaining({ severity: "P1", family: "ui_screenshot", probe: "深色模式下按钮看不清" })]);
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(f.intents().at(-1)).toMatchObject({ node: "fix", action: "dispatch", recipient: "agent-task-one" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("an owner screenshot ask opened before this rule still releases the card when the owner answers it", async () => {
    const f = await passed();
    try {
      const params = { task: "T1", specRev: 1, head: H2, screenshotsDigest: DIGEST };
      const binding = { action: "scheduler_ui_screenshot", params, approve: ["scheduler_ui_approve"] };
      const ask = openAsk(f.db, { project: "p", taskId: "T1", fromAgent: "scheduler", source: "system", kind: "authorize", title: "看前后截图",
        expiresAt: 1e12, bind: { ...binding, paramsHash: bindHash(binding, "scheduler") } }, 9_000);
      answerAsk(f.db, ask.id, { choices: ["[button:scheduler_ui_approve]"], labels: ["批准合并"], principal: "owner", owner: true, via: "web_card", at: 9_100 } as never);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toBeNull();
    } finally { f.close(); }
  });
});

describe("ownerVisual card: the owner looks, PM cannot release it", () => {
  test("pass opens the owner ask; PM's ui-approve is refused and a manager-written approval event is not enough", async () => {
    const f = await passed({ ownerVisual: true });
    try {
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringMatching(/^ask /) });
      expect(asks(f)).toBe(1);
      expect(await approve(f)).toMatchObject({ ok: false, code: "conflict" });
      forgeApproval(f, "pm");
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 owner 看前后截图" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toContain("owner");
    } finally { f.close(); }
  });

  test("extra rewritten without ownerVisual by a non-manager does not turn the owner gate off", async () => {
    const f = await passed({ ownerVisual: true, before: async (g) => {
      const { ownerVisual: _drop, ...rest } = g.task().extra;
      expect(await g.cli("agent-task-one", "task-set", "T1", "--rev", String(g.task().rev), "--extra", JSON.stringify(rest))).toMatchObject({ ok: false });
      // The CLI already refuses the executor; the gate must hold even for a write that got past it.
      setTask(g.db, g.at("agent-task-one"), { id: "T1", rev: g.task().rev, patch: { extra: rest } });
    } });
    try {
      expect(f.task().extra.ownerVisual).toBeUndefined();
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringMatching(/^ask /) });
      expect(asks(f)).toBe(1);
    } finally { f.close(); }
  });

  test("PM switches the gate with ui-owner-visual: on opens the owner ask, off hands it back to PM", async () => {
    const on = await passed({ before: (g) => g.cli("pm", "ui-owner-visual", "T1", "on") });
    try {
      expect(await on.tick()).toMatchObject({ step: "ask", detail: expect.stringMatching(/^ask /) });
    } finally { on.close(); }
    const off = await passed({ ownerVisual: true, before: (g) => g.cli("pm", "ui-owner-visual", "T1", "off") });
    try {
      expect(await off.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice") });
      expect(asks(off)).toBe(0);
    } finally { off.close(); }
  });
});
