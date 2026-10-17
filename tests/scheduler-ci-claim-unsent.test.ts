/** CLAIMSPENT1: a CI recovery claim the main CI gate stopped before its send is settled unsent, so the same head can send once more. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RecoveryMode } from "../src/lib/recovery-policy.ts";
import { addKnownFlaky } from "../src/lib/ci-known-flaky.ts";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.ts";
import { insertEvent } from "../src/lib/ledger-tx.ts";
import type { LedgerEvent } from "../src/lib/ledger-stages.ts";
import { CI_CLAIM_SEND_OP, CI_CLAIM_UNSENT_OP, ciClaimUnsentMark, claimSettledUnsent, settledUnsentClaims, withCiClaimUnsent } from "../src/lib/scheduler-ci-claim-unsent.ts";
import { MAIN_CI_PAUSE } from "../src/lib/scheduler-merge-unsent-receipts.ts";
import { ciRerunSpent, TRAIN_RERUN_OP } from "../src/lib/scheduler-merge-ci-rerun.ts";
import { useMainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";
import { setOutOfDiffModeSource } from "../src/lib/ci-out-of-diff-rerun.ts";

// merge-arch-CIRERUN1 · this file tests other layers of a red CI: the out-of-diff rerun (on by default) is pinned off here,
// its interplay with them is tests/ci-out-of-diff-rerun.test.ts
beforeEach(() => setOutOfDiffModeSource(() => "off"));
afterEach(() => setOutOfDiffModeSource(null));

const world = useMainCiWorld();
type Route = "behind" | "timeout" | "flaky";
const ROUTES: Route[] = ["behind", "timeout", "flaky"];
const CLAIMS = ["merge_ci_behind", "merge_ci_rerun"];

/** Card C red on a test it does not touch; `send` decides what the update / rerun port does once called. */
function rig(w: MainCiWorld, route: Route, mode: RecoveryMode, send: (what: string) => Promise<void> = async () => {}) {
  writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off", ciKnownFlaky: "on", ciClaimUnsent: mode });
  const c = w.card("C");
  w.ci.defaultCi = "failure";
  w.ci.prChecks.set("C", "fail");
  const effects: string[] = [], fix = w.newSha();
  const timed = route === "timeout";
  w.ci.ports.ciRerun = {
    runAttempt: async () => ({ attempt: 1, status: "completed", conclusion: "failure", headSha: c.head }),
    failedLog: async () => ["##[group]tests/stale.test.ts:", ...(timed ? [] : ["error: expect(received).toBe(expected)"]), "(fail) stale [0.40ms]",
      ...(timed ? ["  ^ this test timed out after 5000ms."] : []), "##[endgroup]", " 1 fail"].join("\n"),
    prFiles: async () => ["src/own.ts"],
    rerunFailed: async () => { effects.push("rerun"); await send("rerun"); },
  };
  w.ci.ports.ciBehind = {
    mainSince: async () => ({ mergeBase: c.head, mainHead: fix, commits: [fix] }),
    fileCommits: async () => [fix],
    updateBranch: async () => { effects.push("update"); await send("update"); },
  };
  if (route === "flaky") {
    const owner = { actor: "owner", now: Date.now() };
    const f = createFeature(w.db, owner, { project: "p", slug: "flaky", title: "fix" }).row.id;
    initDag(w.db, owner, { id: f, rev: 1, nodes: [{ key: "FIX", oneLine: "fix stale" }] });
    addKnownFlaky(w.db, owner, { project: "p", file: "tests/stale.test.ts", featureId: f, node: "FIX", reason: "timing" });
  }
  const bind = async (reason: string) =>
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", reason])).toMatchObject({ ok: true });
  const revoke = async () => expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"])).toMatchObject({ ok: true });
  /** Revoke once, right after the current intent's CI claim is committed (before its send). */
  const revokeAtClaim = () => {
    let armed = true;
    w.ci.onReceipt = async (args) => {
      if (!armed || args[1] !== "scheduler-merge-step") return;
      const intent = w.intentOf("C")?.id;
      if (!w.taskEvents("C").some((e) => CLAIMS.includes(String(e.data.op)) && e.data.intentId === intent)) return;
      armed = false;
      await revoke();
    };
  };
  const passes = async (n: number) => { for (let i = 0; i < n; i++) await w.pass(); };
  const ops = (op: string) => w.taskEvents("C").filter((e) => e.data.op === op);
  const observed = () => ops("recovery_observe").filter((e) => e.data.mechanism === "ciClaimUnsent");
  const state = () => ({ stage: (w.db.query("SELECT stage FROM tasks WHERE id='C'").get() as { stage: string }).stage, frozen: w.frozen(),
    bounces: ops("merge_conflict").length, fallbacks: ops("fallback_manual").length });
  return { c, effects, bind, revoke, revokeAtClaim, passes, ops, observed, state };
}

/** The first run claims, the PM revokes before its send, the gate cancels it; then the PM binds the same head again. */
async function claimThenRevoke(w: MainCiWorld, route: Route, mode: RecoveryMode, send?: (what: string) => Promise<void>) {
  const r = rig(w, route, mode, send);
  await r.bind("修 main");
  await w.begin("C");
  r.revokeAtClaim();
  await r.passes(3);
  return r;
}

for (const route of ROUTES) {
  test(`[验收线 1] ${route}: on — claim then revoke sends nothing, rebinding the same head sends exactly once`, async () => {
    const w = world();
    const r = await claimThenRevoke(w, route, "on");
    expect(r.effects).toEqual([]);
    const [proof] = r.ops(CI_CLAIM_UNSENT_OP), [cancel] = r.ops("merge_unsent_cancel");
    expect(cancel?.data).toMatchObject({ cause: "main_ci_pause", counted: false });
    const claim = w.taskEvents("C").find((e) => e.seq === proof?.data.claimSeq)!;
    expect(proof?.data).toMatchObject({ action: route === "behind" ? "update" : "rerun", intentId: claim.data.intentId, cancelSeq: cancel!.seq,
      prHead: r.c.head, run: claim.data.run });
    expect(proof!.seq).toBe(cancel!.seq + 1);
    await r.bind("重绑");
    await r.passes(6);
    expect(r.effects).toEqual([route === "behind" ? "update" : "rerun"]);
    expect(r.state()).toEqual({ stage: "merge", frozen: false, bounces: 0, fallbacks: 0 });
    // the resent claim is a new intent's own; the old claim and its dedup stay as they were
    const claims = w.taskEvents("C").filter((e) => CLAIMS.includes(String(e.data.op)));
    expect(claims.length).toBe(2);
    expect(new Set(claims.map((e) => e.data.intentId)).size).toBe(2);
    expect(claims[0]!.seq).toBe(claim.seq);
  });

  for (const mode of ["off", "observe"] as const) {
    test(`[验收线 3] ${route}: ${mode} keeps the old budget — rebinding sends nothing`, async () => {
      const w = world();
      const r = await claimThenRevoke(w, route, mode);
      await r.bind("重绑");
      await r.passes(4);
      expect(r.effects).toEqual([]);
      expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
      expect(r.observed().length).toBe(mode === "observe" ? 1 : 0);
      if (route === "behind") expect(r.state().bounces).toBe(1); // the old rule: same head already merged main in
    });
  }
}

test("[验收线 3] observe: one observation per claim, never a refund even after switching to on", async () => {
  const w = world();
  const r = await claimThenRevoke(w, "timeout", "observe");
  expect(r.observed().length).toBe(1);
  writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off", ciKnownFlaky: "on", ciClaimUnsent: "on" });
  expect(settledUnsentClaims(w.db, "p", "C").size).toBe(0);
  expect(ciRerunSpent(w.db, "C", r.c.head)).not.toBeNull();
  await r.bind("重绑");
  await r.passes(4);
  expect(r.effects).toEqual([]);
  expect(r.observed().length).toBe(1);
});

test("[验收线 1] restart and repeated pause / rebind still send once", async () => {
  const w = world();
  const r = await claimThenRevoke(w, "timeout", "on");
  w.restart();
  await r.bind("重绑");
  w.ci.onReceipt = null; // this time the revoke lands after the send
  await r.passes(2);
  expect(r.effects).toEqual(["rerun"]);
  await r.revoke();
  await r.passes(3);
  await r.bind("再绑");
  await r.passes(4);
  w.restart();
  await r.passes(2);
  expect(r.effects).toEqual(["rerun"]);
  expect(r.ops(CI_CLAIM_UNSENT_OP).length).toBe(1);
});

test("[验收线 2] a sent rerun revoked afterwards is spent", async () => {
  const w = world();
  const r = rig(w, "timeout", "on");
  await r.bind("修 main");
  await w.begin("C");
  await r.passes(1);
  expect(r.effects).toEqual(["rerun"]);
  await r.revoke();
  await r.passes(3);
  expect(r.ops("merge_unsent_cancel").length).toBe(1);
  expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
  await r.bind("重绑");
  await r.passes(4);
  expect(r.effects).toEqual(["rerun"]);
});

for (const route of ["behind", "timeout"] as const) {
  test(`[验收线 2] ${route}: a send that timed out is spent and bounces as before`, async () => {
    const w = world();
    const r = rig(w, route, "on", async () => { throw new Error("gh 超时"); });
    await r.bind("修 main");
    await w.begin("C");
    await r.passes(2);
    expect(r.effects[0]).toBe(route === "behind" ? "update" : "rerun"); // a failed rerun then falls to CIF2 as it always did
    expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
    expect(r.state().bounces).toBe(1);
  });
}

test("[验收线 2] a cancellation that fails to commit leaves the claim spent and sends nothing", async () => {
  const w = world();
  const r = rig(w, "timeout", "on");
  await r.bind("修 main");
  await w.begin("C");
  r.revokeAtClaim();
  let failed = false;
  w.ci.beforeWrite = async (args) => {
    if (!failed && args[1] === "scheduler-merge-step" && args.includes("unknown")) { failed = true; throw new Error("ledger unavailable"); }
  };
  await r.passes(1);
  w.ci.beforeWrite = null;
  expect(failed).toBe(true);
  expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
  await r.bind("重绑");
  await r.passes(4);
  expect(r.effects).toEqual([]);
  expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
});

test("[验收线 2] a train or manual rerun of the head still spends it", async () => {
  const w = world();
  const r = await claimThenRevoke(w, "timeout", "on");
  expect(ciRerunSpent(w.db, "C", r.c.head)).toBeNull();
  insertEvent(w.db, { actor: "scheduler", now: Date.now() }, { project: "p", target: "C", kind: "note", text: "列车重跑",
    data: { op: TRAIN_RERUN_OP, prHead: r.c.head, run: "https://github.com/x/y/actions/runs/9" } }, false);
  expect(ciRerunSpent(w.db, "C", r.c.head)?.run).toBe("https://github.com/x/y/actions/runs/9");
  await r.bind("重绑");
  await r.passes(4);
  expect(r.effects).toEqual([]);
});

test("[验收线 2] a plain update (no CI claim) revoked before its send writes no settlement", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off", ciClaimUnsent: "on" });
  const c = w.card("C");
  w.ci.defaultCi = "failure";
  await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"]);
  await w.begin("C");
  w.hub.synced.set(c.prRef, w.newSha());
  let revoked = false;
  w.ci.onReceipt = async (args) => {
    if (revoked || args[1] !== "scheduler-merge-step" || !args.includes("updating") || w.phase("C") !== "updating") return;
    revoked = true;
    await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"]);
  };
  await w.pass(); await w.pass();
  expect(revoked).toBe(true);
  expect(w.taskEvents("C").filter((e) => e.data.op === "merge_unsent_cancel").length).toBe(1);
  expect(w.taskEvents("C").filter((e) => e.data.op === CI_CLAIM_UNSENT_OP || e.data.op === "recovery_observe")).toEqual([]);
});

test("[验收线 2] the pure check refuses a proof with the wrong claim seq, head, intent, run or cancellation", async () => {
  const w = world();
  await claimThenRevoke(w, "timeout", "on");
  const events = w.taskEvents("C");
  const claim = events.find((e) => e.data.op === "merge_ci_rerun")!, proof = events.find((e) => e.data.op === CI_CLAIM_UNSENT_OP)!;
  expect(claimSettledUnsent(events, claim)).toBe(true);
  const swap = (p: Partial<LedgerEvent> & { data?: Record<string, unknown> }) =>
    events.map((e) => (e.seq === proof.seq ? { ...e, ...p, data: { ...e.data, ...p.data } } : e));
  for (const bad of [
    { data: { claimSeq: claim.seq - 1 } }, { data: { prHead: "f".repeat(40) } }, { data: { intentId: "other" } },
    { data: { run: "https://github.com/x/y/actions/runs/2" } }, { data: { action: "update" } }, { data: { cancelSeq: proof.seq - 2 } },
    { kind: "note" as const }, { dedupKey: "x" }, { actor: "agent-pm" },
  ]) expect(claimSettledUnsent(swap(bad), claim)).toBe(false);
  expect(claimSettledUnsent(events.filter((e) => e.data.op !== "merge_unsent_cancel"), claim)).toBe(false);
  expect(claimSettledUnsent(events, { ...claim, seq: claim.seq + 1 })).toBe(false);
  // off / observe read the old budget even with a valid proof in the ledger
  for (const mode of ["off", "observe"] as const) {
    writePolicy({ mainCiPause: "on", ciClaimUnsent: mode });
    expect(settledUnsentClaims(w.db, "p", "C").size).toBe(0);
  }
  writePolicy({ mainCiPause: "on", ciClaimUnsent: "on" });
  expect([...settledUnsentClaims(w.db, "p", "C")]).toEqual([claim.seq]);
});

/** The cancel receipt sendEffect would write for a rerun the gate stopped, here submitted through the ordinary step instead. */
const forgedRerunReceipt = (w: MainCiWorld, head: string) => {
  const claim = w.taskEvents("C").findLast((e) => e.data.op === "merge_ci_rerun")!;
  const runId = String(claim.data.run).split("/runs/")[1]!;
  return withCiClaimUnsent(`${MAIN_CI_PAUSE}：主线 CI 修复绑定已撤销，取消重排`, ciClaimUnsentMark("rerun", head, runId));
};

test("[验收线 2][r1 P1] a rerun already sent is never refunded by a receipt carrying the unsent mark", async () => {
  const w = world();
  const r = rig(w, "timeout", "on");
  await r.bind("修 main");
  const intent = await w.begin("C");
  await r.passes(1);
  expect(r.effects).toEqual(["rerun"]);
  await w.step(intent, w.phase("C")!, "unknown", forgedRerunReceipt(w, r.c.head));
  expect(r.ops("merge_unsent_cancel").length).toBe(1);
  await r.bind("重绑");
  await r.passes(6);
  expect(r.effects).toEqual(["rerun"]);
  expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
  expect(ciRerunSpent(w.db, "C", r.c.head)).not.toBeNull();
  expect(r.ops(CI_CLAIM_SEND_OP).length).toBe(1);
});

test("[验收线 2][r1 P1] a forged cancel that lands between claim and send leaves the send step a conflict: nothing sent", async () => {
  const w = world();
  const r = rig(w, "timeout", "on");
  await r.bind("修 main");
  const intent = await w.begin("C");
  let forged = false;
  w.ci.onReceipt = async (args) => {
    if (forged || args[1] !== "scheduler-merge-step" || !r.ops("merge_ci_rerun").length) return;
    forged = true;
    await w.step(intent, w.phase("C")!, "unknown", forgedRerunReceipt(w, r.c.head));
  };
  await r.passes(1);
  expect(forged).toBe(true);
  expect(r.effects).toEqual([]);
  expect(r.ops(CI_CLAIM_SEND_OP)).toEqual([]);
  expect(r.ops(CI_CLAIM_UNSENT_OP).length).toBe(1); // truly unsent: the binding still stands, so the next run sends this head's only rerun
  w.ci.onReceipt = null;
  await r.passes(6);
  expect(r.effects).toEqual(["rerun"]);
  expect(r.ops(CI_CLAIM_SEND_OP).length).toBe(1);
  expect(r.state()).toEqual({ stage: "merge", frozen: false, bounces: 0, fallbacks: 0 });
});

test("[验收线 2] a send step that fails to commit sends nothing and leaves the claim spent", async () => {
  const w = world();
  const r = rig(w, "timeout", "on");
  await r.bind("修 main");
  await w.begin("C");
  let failed = false;
  w.ci.beforeWrite = async (args) => {
    if (!failed && args.some((a) => a.startsWith("CI 恢复发送开始："))) { failed = true; throw new Error("ledger unavailable"); }
  };
  await r.passes(1);
  w.ci.beforeWrite = null;
  expect(failed).toBe(true);
  expect(r.effects).toEqual([]);
  await r.revoke();
  await r.passes(2);
  expect(r.ops(CI_CLAIM_UNSENT_OP)).toEqual([]);
  expect(ciRerunSpent(w.db, "C", r.c.head)).not.toBeNull();
});

test("[验收线 2] the pure check refuses an unjournaled claim and a claim whose send step committed", async () => {
  const w = world();
  await claimThenRevoke(w, "timeout", "on");
  const events = w.taskEvents("C");
  const claim = events.find((e) => e.data.op === "merge_ci_rerun")!;
  expect(claimSettledUnsent(events, claim)).toBe(true);
  expect(claimSettledUnsent(events, { ...claim, data: { ...claim.data, sendJournal: undefined } })).toBe(false);
  const started = { ...claim, seq: 1e9, dedupKey: "x", data: { op: CI_CLAIM_SEND_OP, intentId: claim.data.intentId, claimSeq: claim.seq } };
  expect(claimSettledUnsent([...events, started], claim)).toBe(false);
});
