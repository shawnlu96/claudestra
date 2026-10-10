import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { manualResumeManagerTick } from "../src/lib/scheduler-recovery-ports.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

describe("stage2 ledger command held recovery", () => {
  test("a central card held as v2_unmapped does not stop a later local manual card in the same tick", async () => {
    const s = ledgercmdFixture(), f = s.f;
    const warn = spyOn(console, "warn").mockImplementation(() => {}), error = spyOn(console, "error").mockImplementation(() => {});
    restores.push(() => warn.mockRestore(), () => error.mockRestore());
    createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "dependency", kind: "code" });
    createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "local", kind: "code", agent: "agent-task-one" });
    setWorkflow(f.db, f.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "only inform" });
    for (const id of ["T1", "T2"]) {
      addDep(f.db, f.at("owner"), { from: "T0", to: id, kind: "blocks", when: "T0 上线后" });
      const task = getTask(f.db, id)!, w = getWorkflow(f.db, id)!;
      expect(await f.cli("pm", "workflow-set", id, "--rev", String(task.rev), "--workflow-rev", String(w.rev), "--template", w.template,
        "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "only inform",
        "--reason-code", "deps_not_live", "--reason", "wait T0")).toMatchObject({ ok: true });
    }
    for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const) {
      moveStage(f.db, f.at("owner"), { taskId: "T0", from, to });
    }
    recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
    s.port.route = id => id === "T1" ? "central" : "local";
    const calls: string[][] = [];
    const manager = withSchedulerV2LedgerCmds(async (...args) => { calls.push(args); return { ok: true }; }, s.port);
    const out = await manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager, notifyPm: async () => {}, now: () => 5000,
      recoveryPolicy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
    expect(out.map(o => [o.taskId, o.action])).toEqual([["T1", "refused"], ["T2", "resumed"]]);
    expect(out[0]!.why).toContain("v2_unmapped");
    expect(calls.map(a => [a[1], a[2]])).toEqual([["scheduler-manual-resume", "T2"]]);
    expect(s.observations).toEqual(["v2_unmapped"]);
    expect(s.requests).toHaveLength(0);
    expect(warn.mock.calls.flat().join("\n")).toContain("T1 held by central mapping (v2_unmapped), skipped this tick");
  });
});
