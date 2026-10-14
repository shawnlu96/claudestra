import { expect, test } from "bun:test";
import { ciQueueFullStep } from "../src/lib/scheduler-ci-queue-full.js";
import { openMainCiGate } from "../src/lib/scheduler-main-ci-wiring-gate.js";
import { recordObserved } from "../src/lib/recovery-policy.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { useMainCiWorld, writePolicy } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
for (const mode of ["observe", "on"] as const) {
  test(`PM revoke during ${mode} queue PR read cancels merge without rerun or would-rerun record`, async () => {
    const w = world();
    writePolicy({ mainCiPause: "on", ciQueueFull: "off" });
    const c = w.card("C"); w.ci.defaultCi = "failure";
    await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "repair main"]);
    const intent = await w.begin("C"); await w.step(intent, "ready", "await_ci");
    w.ci.prChecks.set("C", "pending"); await w.pass();
    const config = { enabled: true, pollMs: 1000, autoDispatch: false, projects: { p: { repoDir: ".", maxActiveWorkers: 1, requiredChecks: ["check"] } } };
    // Reuse the pass's genuine main health and reread PM bindings on the writable test ledger; all external effects stay fake.
    const gate = openMainCiGate(w.db, config);
    gate.modes = w.gate!.modes; gate.reads = w.gate!.reads; gate.now = w.gate!.now;
    const commands: string[][] = [];
    const external: MergeExternal = {
      inspect: async () => {
        await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "PM withdrew repair"]);
        return { state: "OPEN", head: c.head, branch: "task/C", base: "main", draft: false, crossRepository: false,
          mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" },
            { name: "ci scope light", bucket: "pass", link: `https://github.com/${w.repo}/actions/runs/42/job/7` }] };
      },
      freshness: async () => ({ behindBy: 0, mainHead: w.hub.main }), carryReview: async () => ({ ok: false, reason: "no" }),
      updateBranch: async () => {}, merge: async () => c.head,
    };
    const result = await ciQueueFullStep(w.db, config, {
      external: () => external, active: () => {}, policy: () => ({ mode, source: "config", manualAfterMs: null }),
      command: async (args) => { commands.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
      manager: async (...args) => ({ ok: true, ...recordObserved(w.db, { project: "p", target: "C", mechanism: "ciQueueFull",
        actionKey: args[args.indexOf("--action-key") + 1]!, action: args[args.indexOf("--action") + 1]!,
        data: JSON.parse(args[args.indexOf("--data") + 1]!) }, Date.now()) }),
    });
    expect(result).toEqual([]); expect(commands).toEqual([]);
    expect(w.taskEvents("C").filter((e) => e.data.mechanism === "ciQueueFull")).toEqual([]);
    await w.pass();
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent)).toEqual({ status: "cancelled" });
    expect(w.frozen()).toBe(false);
  });
}
