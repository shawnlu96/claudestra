/**
 * MAINCIW merge invariants, through the real pass / CLI (fixture: tests/scheduler-main-ci-wiring-world.test.ts):
 * [验收线 2] a paused unsent run with a moved head is still cancelled (slot freed); a train voided by the pause leaves its CI running
 * under trainCiTimeout=on; [验收线 4] a binding after a revoke takes effect; and the CLI / skip routing of the new commands.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { readMainCiState } from "../src/lib/scheduler-main-ci-wiring-store.js";
import { SKIP_LEDGER_COMMANDS } from "../src/lib/scheduler-v2-skip-paths.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";
import { mainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

let w: MainCiWorld, saved: string | null;
beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; w = mainCiWorld(); });
afterEach(() => {
  w.close();
  if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved);
});

const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const passes = async (n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...await w.pass()); return out; };

describe("[验收线 2] pause ends what it must, and only that", () => {
  test("a ready run whose PR head moved is still cancelled main_ci_pause: slot freed, no freeze, card stays in merge", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("T1");
    const intent = await w.begin("T1");
    w.hub.heads.set(c.prRef, w.newSha()); // the author pushed after review
    w.ci.bySha.set(w.hub.main, "failure");
    const calls = await w.pass();
    expect(merges(calls)).toEqual([]);
    expect((w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status).toBe("cancelled");
    expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(intent)).toBeNull();
    expect(w.taskEvents("T1").filter((e) => e.data.op === "merge_unsent_cancel").at(-1)!.data).toMatchObject({ counted: false, cause: "main_ci_pause" });
    expect(w.frozen()).toBe(false);
    expect(w.db.query("SELECT stage FROM tasks WHERE id='T1'").get()).toEqual({ stage: "merge" });
  });

  test("a testing train voided by the pause under trainCiTimeout=on cancels no CI run", async () => {
    writePolicy({ mainCiPause: "on", trainCiTimeout: "on" });
    const actions: string[] = [];
    Object.assign(w.gh, {
      branchRuns: async () => [{ id: 42, url: "https://github.com/x/actions/runs/42", status: "in_progress" }],
      runJobs: async () => [{ id: 7, name: "check", status: "in_progress" }],
      cancelRun: async (_r: string, id: number) => { actions.push(`cancel:${id}`); return "requested"; },
      jobLog: async () => ({ text: "", truncated: false }),
      runStatus: async () => "in_progress",
    });
    w.card("T1"); w.card("T2");
    w.hub.pending = true;
    for (let i = 0; i < 4 && !w.store.load("p")?.cars.some((c) => c.created); i++) await w.pass();
    expect(w.store.load("p")?.phase).toBe("testing");
    expect(w.store.load("p")!.cars.some((c) => c.created)).toBe(true); // its CI is on GitHub now
    w.ci.bySha.set(w.hub.main, "failure");
    await passes(3);
    const s = w.store.load("p")!;
    expect(actions).toEqual([]);
    expect(s.outcome).toBe("void");
    expect(s.phase).toBe("done");
    expect(s.bounced).toEqual([]);
    expect(s.ciExit).toMatchObject({ cancel: "confirmed", runs: [] });
  });
});

describe("[验收线 4] a binding after a revoke is a new, effective binding", () => {
  test("bind → revoke → bind again: a new event after the revoke, valid in status, C merges; a plain retry stays a replay", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("C"); w.card("D");
    const x = w.hub.main;
    w.ci.defaultCi = "failure";
    const bind = () => w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", x, "--reason", "修 main"]);
    const first = await bind();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"])).toMatchObject({ ok: true });
    const again = await bind();
    expect(again).toMatchObject({ ok: true, duplicate: false });
    expect(again.request).not.toBe(first.request);
    expect(await bind()).toMatchObject({ ok: true, duplicate: true, request: again.request });
    const status = await w.ledger("agent-pm", ["main-ci", "status", "--project", "p"]);
    expect(status.bindings as unknown[]).toEqual([expect.objectContaining({ task: "C", request: again.request, valid: true })]);
    const calls = await passes(8);
    expect(calls.filter((s) => s.startsWith("serial-merge:"))).toEqual(["serial-merge:C"]);
    expect(w.phase("D")).toBeNull();
  });
});

describe("routing and diagnostics of the new commands", () => {
  test("main-ci status is a read on a read-only connection; scheduler-main-ci is routed by project", () => {
    expect(isWriteInvocation("ledger", ["main-ci", "status", "--project", "p"])).toBe(false);
    expect(READER_ONLY_SUBS.has("main-ci")).toBe(true);
    expect(isWriteInvocation("ledger", ["main-ci-repair", "C", "--revoke", "--reason", "x"])).toBe(true);
    expect(SKIP_LEDGER_COMMANDS["scheduler-main-ci"]).toBe("project");
  });

  test("a corrupt persisted failure start is reported, then treated as unset", () => {
    w.db.run("INSERT INTO meta (project, key, value) VALUES ('p', 'mainCiReadFailureSince', '{oops')");
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(readMainCiState(w.db, "p")).toEqual({ readFailureSince: null, uncertainty: null });
      expect(err.mock.calls.some((a) => String(a[0]).includes("mainCiReadFailureSince"))).toBe(true);
    } finally { err.mockRestore(); }
  });
});
