/**
 * MAINCIW [验收线 3] recovery (and what still counts as a pause) and [验收线 4] the PM repair binding, through the real pass and the real
 * `ledger main-ci-repair` CLI (fixture: tests/scheduler-main-ci-wiring-world.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mainCiWorld, writePolicy, type Ci, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

let w: MainCiWorld, saved: string | null;
beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; w = mainCiWorld(); writePolicy({ mainCiPause: "on" }); });
afterEach(() => {
  w.close();
  if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved);
});

const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const runs = () => (w.db.query("SELECT COUNT(*) AS n FROM scheduler_merges").get() as { n: number }).n;
const passes = async (n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...await w.pass()); return out; };
const repair = (actor: string, id: string, ...flags: string[]) => w.ledger(actor, ["main-ci-repair", id, ...flags, "--reason", "修 main 的那张卡"]);

describe("[验收线 3] recovery on a new green main; stale, drifting or incomplete evidence stays a pause", () => {
  test("main X red → Y all green: the next passes form / run normally and the cards merge", async () => {
    w.card("T1"); w.card("T2");
    w.ci.bySha.set(w.hub.main, "failure");
    expect(merges(await passes(2))).toEqual([]);
    w.hub.main = w.newSha(); // PM pushed the fix straight to main: no binding needed
    const calls = await passes(12);
    expect(calls.filter((c) => /^(serial-merge|match-head):/.test(c)).length).toBeGreaterThan(0);
    expect(["T1", "T2"].some((id) => w.phase(id) === "merged")).toBe(true);
  });

  const paused = async (setup: () => void) => {
    w.card("T1"); w.card("T2");
    setup();
    const calls = await passes(3);
    expect(merges(calls)).toEqual([]);
    expect(runs()).toBe(0);
    expect(w.store.load("p")).toBeNull();
  };
  test("a read older than maxAge by the time it is used", () => paused(() => { w.clock.jumpOnChecks = 11 * 60_000; }));
  test("main moved between the two main reads", () => paused(() => {
    let n = 0;
    w.ci.mainOverride = () => (++n % 2 ? w.hub.main : "f".repeat(40));
  }));
  for (const state of ["missing", "pending"] as Ci[]) {
    test(`the required check is ${state}`, () => paused(() => { w.ci.bySha.set(w.hub.main, state); }));
  }
});

describe("[验收线 4] PM repair binding: card, head, main and fault exact; all gates unchanged", () => {
  test("bound C goes through review proof and its PR CI and merges; D stays paused", async () => {
    const c = w.card("C"); w.card("D");
    const x = w.hub.main;
    w.ci.bySha.set(x, "failure");
    w.ci.defaultCi = "failure"; // every later main is red too: only the binding may let anything through
    await w.pass();
    const r = await repair("agent-pm", "C", "--head", c.head, "--main", x);
    expect(r).toMatchObject({ ok: true, task: "C" });
    expect(String(r.faultKey)).toContain(x);
    const status = await w.ledger("agent-pm", ["main-ci", "status", "--project", "p"]);
    expect(status).toMatchObject({ ok: true, state: "red", mainSha: x, paused: true });
    expect((status.bindings as { task: string; valid: boolean }[])).toEqual([expect.objectContaining({ task: "C", valid: true })]);
    const calls = await passes(8);
    expect(calls.filter((s) => s.startsWith("serial-merge:"))).toEqual(["serial-merge:C"]);
    expect(w.phase("C")).toBe("merged");
    expect(calls.some((s) => s.endsWith(":D"))).toBe(false);
    expect(w.phase("D")).toBeNull();
    expect(w.store.load("p")).toBeNull(); // a repair never rides a train
  });

  test("refusals: not a PM, wrong head, wrong main, green main — each with zero external writes", async () => {
    const c = w.card("C");
    const x = w.hub.main;
    w.ci.bySha.set(x, "failure");
    expect(await repair("agent-author", "C", "--head", c.head, "--main", x)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await repair("agent-pm", "C", "--head", "a".repeat(40), "--main", x)).toMatchObject({ ok: false, code: "conflict" });
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", "b".repeat(40))).toMatchObject({ ok: false, code: "conflict" });
    w.ci.bySha.set(x, "success");
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", x)).toMatchObject({ ok: false, code: "conflict" });
    w.ci.bySha.set(x, "pending"); // still running only: not a repairable fault (planMainCi repairApproval)
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", x)).toMatchObject({ ok: false, code: "conflict" });
    expect(w.hub.calls).toEqual([]);
    expect(w.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='decision'").get()).toEqual({ n: 0 });
  });

  test("main moves on to red Z after the binding: the binding lapses, C is paused again", async () => {
    const c = w.card("C");
    const x = w.hub.main;
    w.ci.defaultCi = "failure";
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", x)).toMatchObject({ ok: true });
    w.hub.main = w.newSha();
    const calls = await passes(3);
    expect(merges(calls)).toEqual([]);
    expect(runs()).toBe(0);
    const status = await w.ledger("agent-pm", ["main-ci", "status", "--project", "p"]);
    expect((status.bindings as { valid: boolean }[])[0]!.valid).toBe(false);
  });

  test("a revoked binding no longer lets C through", async () => {
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", w.hub.main)).toMatchObject({ ok: true });
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "不修了"])).toMatchObject({ ok: true });
    expect(merges(await passes(3))).toEqual([]);
    expect(runs()).toBe(0);
  });

  test("bound C whose own PR CI fails is bounced to fix as usual, not cancelled as a pause", async () => {
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    expect(await repair("agent-pm", "C", "--head", c.head, "--main", w.hub.main)).toMatchObject({ ok: true });
    w.ci.prChecks.set("C", "fail");
    await passes(3);
    const ev = w.taskEvents("C");
    expect(ev.some((e) => e.data.op === "merge_unsent_cancel")).toBe(false);
    expect(ev.some((e) => e.data.op === "merge_conflict" || e.data.op === "ci_rerun" || String(e.data.receipt ?? "").startsWith("退回 fix（ci_fail）"))).toBe(true);
  });
});
