/**
 * T68h scope 3: an auto card whose spec changed (specRev bumped → workflow_drift → manual) and that the PM then moved on by
 * hand can be handed back to the scheduler with `ledger workflow-resume`: re-bound to the current specRev, re-planned, with
 * an event. workflow-set still refuses auto once the card is past spec.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

let f: ReturnType<typeof autoFixture>;
afterEach(() => f?.close());

/** Auto card in restate, spec sent back (specRev 2), engine hands it to PM, PM restates and releases it to build by hand. */
async function driftedToBuild() {
  f = autoFixture();
  await f.tick(); // ensure author session
  await f.tick(); // restate order
  expect(await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述")).toMatchObject({ ok: true });
  expect(await f.cli("pm", "stage", "T1", "--from", "restate", "--to", "spec", "--text", "规格改了")).toMatchObject({ ok: true });
  expect(f.task().specRev).toBe(2);
  expect(await f.tick()).toMatchObject({ step: "manual" });
  expect(getWorkflow(f.db, "T1")).toMatchObject({ mode: "manual", specRev: 1 });
  expect(await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述 v2")).toMatchObject({ ok: true });
  expect(await f.cli("pm", "stage", "T1", "--from", "restate", "--to", "build")).toMatchObject({ ok: true });
  expect(f.task().stage).toBe("build");
}

const resume = (actor: string, reason = "规格 v2 已复述，交回自动", over: string[] = []) => {
  const w = getWorkflow(f.db, "T1")!;
  return f.cli(actor, "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--reason", reason, ...over);
};

describe("workflow-resume", () => {
  test("past spec, workflow-set auto is refused; resume re-binds to the new specRev, records the re-planned next step, and the engine drives it", async () => {
    await driftedToBuild();
    const w = getWorkflow(f.db, "T1")!;
    expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--template", "code", "--version", "2",
      "--mode", "auto", "--author-family", "claude", "--fallback", "只报错不修")).toMatchObject({ ok: false, code: "invalid" });
    const r = await resume("pm");
    expect(r).toMatchObject({ ok: true, fromSpecRev: 1, workflow: { mode: "auto", specRev: 2, rev: w.rev + 1 }, next: { kind: "intent", action: "dispatch" } });
    const ev = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "scheduler")!;
    expect(ev.data).toMatchObject({ op: "workflow_resume", from: "manual", fromSpecRev: 1, specRev: 2, stage: "build", next: { kind: "intent", action: "dispatch" } });
    expect(await f.tick()).toMatchObject({ step: "sent" });
    expect(f.sent.at(-1)?.agent).toBe("agent-task-one");
  });

  test("refusals: executor, stale rev, missing reason, already current, open outcome, auto dispatch off", async () => {
    await driftedToBuild();
    expect(await resume("agent-task-one")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("pm", "workflow-resume", "T1", "--rev", "1", "--workflow-rev", "1", "--reason", "x")).toMatchObject({ ok: false, code: "conflict" });
    expect(await resume("pm", " ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.cliWith({ autoDispatch: () => false }, "pm", "workflow-resume", "T1", "--rev", "1", "--workflow-rev", "1", "--reason", "x"))
      .toMatchObject({ ok: false, code: "forbidden" });
    const first = (f.db.query("SELECT id FROM scheduler_intents ORDER BY eventSeq LIMIT 1").get() as { id: string }).id;
    f.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?").run(first);
    expect(await resume("pm")).toMatchObject({ ok: false, code: "conflict" });
    f.db.query("UPDATE scheduler_intents SET status = 'done' WHERE id = ?").run(first);
    expect(await resume("pm")).toMatchObject({ ok: true });
    expect(await resume("pm")).toMatchObject({ ok: false, code: "conflict" });
  });
});
