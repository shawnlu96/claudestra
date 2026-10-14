/** Revoked repair bindings stop both update ports, including a claim returned as updating by CIF2. */
import { expect, test } from "bun:test";
import { useMainCiWorld, writePolicy } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
for (const route of ["behind", "ciBehind"] as const) {
  for (const drift of [false, true]) {
    test(`[验收线 ${drift ? 2 : 4}] ${route}: revoke at claim receipt, head drift=${drift}, cancels without writes or freeze`, async () => {
      const w = world();
      writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off" });
      const c = w.card("C");
      w.ci.defaultCi = "failure";
      await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"]);
      const intent = await w.begin("C");
      const effects: string[] = [];
      if (route === "behind") w.hub.synced.set(c.prRef, w.newSha());
      else {
        w.ci.prChecks.set("C", "fail");
        const fix = w.newSha();
        w.ci.ports.ciRerun = {
          runAttempt: async () => ({ attempt: 1, status: "completed", conclusion: "failure", headSha: c.head }),
          failedLog: async () => ["##[group]tests/stale.test.ts:", "error: expect(received).toBe(expected)",
            "(fail) stale [0.40ms]", "##[endgroup]", " 1 fail", "Ran 1 tests across 1 files.",
            "##[error]Process completed with exit code 1."].join("\n"),
          prFiles: async () => ["src/own.ts"], rerunFailed: async () => { effects.push("rerun"); },
        };
        w.ci.ports.ciBehind = {
          mainSince: async () => ({ mergeBase: c.head, mainHead: fix, commits: [fix] }),
          fileCommits: async () => [fix], updateBranch: async () => { effects.push("ciBehind.updateBranch"); },
        };
      }
      let revoked = false;
      w.ci.onReceipt = async (args) => {
        if (revoked || args[1] !== "scheduler-merge-step" || !args.includes(route === "behind" ? "updating" : "resolved")) return;
        if (w.phase("C") !== "updating") return;
        revoked = true;
        expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"])).toMatchObject({ ok: true });
        if (drift) w.db.query("UPDATE tasks SET headSHA=? WHERE id='C'").run(w.newSha());
      };
      const calls = [...await w.pass(), ...await w.pass()];
      expect(revoked).toBe(true);
      expect(effects).toEqual([]);
      expect(calls.filter((c) => /^(update|serial-merge|match-head):/.test(c))).toEqual([]);
      expect(w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent)).toEqual({ status: "cancelled" });
      expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(intent)).toBeNull();
      expect(w.taskEvents("C").filter((e) => e.data.op === "merge_unsent_cancel").at(-1)?.data)
        .toMatchObject({ cause: "main_ci_pause", counted: false });
      expect(w.frozen()).toBe(false);
      expect(w.db.query("SELECT stage FROM tasks WHERE id='C'").get()).toEqual({ stage: "merge" });
    });
  }
}
