/**
 * CONVREPO1 · a convergence intent whose CLI keeps failing goes back to PM. The scheduler-auto-helpers world with the real
 * ledger CLI in-process and an adjustable clock; only `scheduler-convergence` is stubbed (others pass through, some can be refused).
 */
import { expect, test } from "bun:test";
import { repeatedFix } from "./fix-strategy-helpers.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const MIN = 60_000;
type Answer = Record<string, unknown>;

async function stallWorld(mode: RecoveryMode | null = "on") {
  const f = await repeatedFix(), real = f.tickDeps.manager;
  let convergence: Answer = { ok: false, code: "invalid", error: "X" };
  const refuse = new Map<string, Answer[]>();
  f.tickDeps.manager = async (...args) => {
    if (args[1] === "scheduler-convergence") return convergence;
    const queued = refuse.get(args[1])?.shift();
    return queued ?? real(...args);
  };
  if (mode) f.tickDeps.recoveryPolicy = () => ({ mode, manualAfterMs: null, source: "config" });
  const first = await f.tick(); // t0: plans the fix_swap intent and runs it once
  const intent = f.intents().findLast((i) => i.action === "fix_swap")!;
  const base = Math.max(...listEvents(f.db, { project: "p", target: "T1" }).map((e) => e.seq));
  const since = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.seq > base);
  const at = async (minute: number) => { f.advance(t0 + minute * MIN - f.tickDeps.now()); return f.tick(); };
  const t0 = f.tickDeps.now();
  return { f, first, intent, since, at, answer: (a: Answer) => { convergence = a; }, refuse: (cmd: string, a: Answer) => { refuse.set(cmd, [...(refuse.get(cmd) ?? []), a]); } };
}

test("[验收线 5] on: held at t0 / +1 / +5 with nothing written, manual at +10 with one fallback and one notice, silent after", async () => {
  const w = await stallWorld();
  try {
    expect(w.first).toMatchObject({ step: "held", detail: "X" });
    expect(await w.at(1)).toMatchObject({ step: "held" });
    expect(await w.at(5)).toMatchObject({ step: "held" });
    expect(w.since()).toHaveLength(0); expect(w.f.notices).toHaveLength(0);
    expect(await w.at(10)).toMatchObject({ step: "manual" });
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("manual");
    expect(getIntent(w.f.db, w.intent.id)?.status).toBe("cancelled");
    const fallbacks = w.since().filter((e) => e.data.op === "fallback_manual");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].data).toMatchObject({ intentId: w.intent.id, cancelledIntents: [w.intent.id], manualReason: { code: "pm_takeover" } });
    expect(w.f.notices).toHaveLength(1);
    expect(w.f.notices[0]).toContain(w.intent.id);
    expect(w.f.notices[0]).toContain("连续 4 次执行失败（10 分钟）：X");
    expect(w.f.notices[0]).toContain("意图已取消");
    const n = w.since().length;
    await w.at(11); await w.at(12);
    // a manual card gets manualCaseOwnership's own observation note; nothing else may be written
    expect(w.since().slice(n).filter((e) => e.data.mechanism !== "manualCaseOwnership")).toHaveLength(0);
    expect(w.f.notices).toHaveLength(1);
  } finally { w.f.close(); }
});

test("[验收线 6] an ok result in between starts the count over", async () => {
  const w = await stallWorld();
  try {
    await w.at(1);
    w.answer({ ok: true, step: "waiting", detail: "对方没有空闲槽" });
    expect(await w.at(5)).toMatchObject({ step: "waiting" });
    w.answer({ ok: false, code: "invalid", error: "X" });
    expect(await w.at(10)).toMatchObject({ step: "held" });
    expect(await w.at(11)).toMatchObject({ step: "held" });
    expect(await w.at(19)).toMatchObject({ step: "held" }); // third failure of the new run, only 9 minutes in
    expect(await w.at(20)).toMatchObject({ step: "manual" });
    expect(w.f.notices).toEqual([expect.stringContaining("连续 4 次执行失败（10 分钟）")]);
  } finally { w.f.close(); }
});

test("[验收线 6] a re-planned attempt of the same intent keeps counting", async () => {
  const w = await stallWorld();
  try {
    await w.at(1); // a0 has failed twice
    expect(await w.f.cli("scheduler", "scheduler-settle", w.intent.id, "--from", "pending", "--to", "cancelled", "--receipt", "按当前台账重算")).toMatchObject({ ok: true });
    expect(await w.at(10)).toMatchObject({ step: "manual" });
    const next = w.f.intents().findLast((i) => i.action === "fix_swap")!;
    expect(next.id).toBe(`${w.intent.id}:a1`);
    expect(next.status).toBe("cancelled");
    expect(w.f.notices).toEqual([expect.stringContaining(`收敛意图 ${next.id}（fix_swap）连续 3 次执行失败`)]);
  } finally { w.f.close(); }
});

for (const code of ["too_large", "lease-lost"]) {
  test(`[验收线 6] ${code} is not counted`, async () => {
    const w = await stallWorld();
    try {
      w.answer({ ok: false, code, error: `${code} refusal` });
      for (const m of [1, 5, 10, 15, 20]) expect(await w.at(m)).toMatchObject({ step: "held" });
      expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
      expect(w.since().filter((e) => e.data.op === "fallback_manual")).toHaveLength(0);
      expect(w.f.notices.filter((n) => n.includes("退回人工"))).toHaveLength(0);
    } finally { w.f.close(); }
  });
}

test("[验收线 6] a submitted intent is recorded unknown with the reason before going manual", async () => {
  const w = await stallWorld();
  try {
    expect(await w.f.cli("scheduler", "scheduler-settle", w.intent.id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
    await w.at(1); await w.at(5);
    expect(await w.at(10)).toMatchObject({ step: "manual" });
    const intent = getIntent(w.f.db, w.intent.id)!;
    expect(intent.status).toBe("unknown");
    expect(intent.receipt).toContain("连续 4 次失败");
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("manual");
    expect(w.since().filter((e) => e.data.op === "fallback_manual")).toHaveLength(1);
    expect(w.f.notices).toEqual([expect.stringContaining("意图记为 unknown 待对账")]);
  } finally { w.f.close(); }
});

test("[验收线 6] a refused fallback holds without a notice, and the retry that lands sends exactly one", async () => {
  const w = await stallWorld();
  try {
    w.refuse("scheduler-fallback-manual", { ok: false, code: "busy", error: "ledger busy" });
    await w.at(1); await w.at(5);
    expect(await w.at(10)).toMatchObject({ step: "held" });
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
    expect(w.f.notices).toHaveLength(0);
    expect(await w.at(11)).toMatchObject({ step: "manual" });
    await w.at(12);
    expect(w.f.notices).toHaveLength(1);
    expect(w.f.notices[0]).toContain("连续 5 次执行失败");
  } finally { w.f.close(); }
});

test("[验收线 6] submitted stall retries fallback after a transient refusal", async () => {
  const w = await stallWorld();
  try {
    expect(await w.f.cli("scheduler", "scheduler-settle", w.intent.id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
    w.refuse("scheduler-fallback-manual", { ok: false, code: "busy", error: "ledger busy" });
    await w.at(1); await w.at(5);
    expect(await w.at(10)).toMatchObject({ step: "held" });
    expect(getIntent(w.f.db, w.intent.id)?.status).toBe("unknown");
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
    w.answer({ ok: true, step: "session", detail: "a resumed convergence must not run" });
    expect(await w.at(11)).toMatchObject({ step: "manual" });
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("manual");
    expect(getIntent(w.f.db, w.intent.id)?.status).toBe("unknown");
    const fallbacks = w.since().filter((e) => e.data.op === "fallback_manual");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].data).toMatchObject({ intentId: w.intent.id, manualReason: { code: "pm_takeover" } });
    await w.at(12);
    expect(w.f.notices).toEqual([expect.stringContaining("连续 4 次执行失败（10 分钟）：X。意图记为 unknown 待对账")]);
  } finally { w.f.close(); }
});

test("[验收线 6] an unknown intent this mechanism did not write stays with PM", async () => {
  const w = await stallWorld();
  try {
    expect(await w.f.cli("scheduler", "scheduler-settle", w.intent.id, "--from", "pending", "--to", "unknown", "--receipt", "仲裁发送已认领但无回执，不重复投递")).toMatchObject({ ok: true });
    expect(await w.at(10)).toMatchObject({ step: "held" });
    expect(await w.at(20)).toMatchObject({ step: "held" });
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
    expect(w.since().filter((e) => e.data.op === "fallback_manual")).toHaveLength(0);
    expect(w.f.notices).toHaveLength(0);
  } finally { w.f.close(); }
});

test("[验收线 6] a notice that fails to send is resent next tick and arrives once", async () => {
  const w = await stallWorld();
  try {
    let attempts = 0;
    const deliver = w.f.tickDeps.notifyPm;
    w.f.tickDeps.notifyPm = async (task, text) => { if (++attempts === 1) throw new Error("PM port offline"); return deliver(task, text); };
    await w.at(1); await w.at(5);
    expect(await w.at(10)).toMatchObject({ step: "manual" });
    expect(w.f.notices).toHaveLength(0);
    await w.at(11); await w.at(12);
    expect(attempts).toBe(2);
    expect(w.f.notices).toHaveLength(1);
    expect(w.since().filter((e) => e.data.op === "fallback_manual")).toHaveLength(1);
  } finally { w.f.close(); }
});

test("[PM 审定 2] observe: one notice at the threshold, the card stays auto and the intent pending, no resend", async () => {
  const w = await stallWorld("observe");
  try {
    await w.at(1); await w.at(5);
    expect(await w.at(10)).toMatchObject({ step: "held" });
    expect(w.f.notices).toHaveLength(1);
    expect(w.f.notices[0]).toContain("本会退回人工（observe）");
    expect(w.f.notices[0]).toContain("意图仍是 pending");
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
    expect(getIntent(w.f.db, w.intent.id)?.status).toBe("pending");
    await w.at(11); await w.at(20);
    expect(w.f.notices).toHaveLength(1);
    expect(w.since()).toHaveLength(0);
  } finally { w.f.close(); }
});

test("[PM 审定 2] the default policy (no config) is observe", async () => {
  const w = await stallWorld(null);
  try {
    await w.at(1); await w.at(5); await w.at(10);
    expect(w.f.notices).toEqual([expect.stringContaining("本会退回人工（observe）")]);
    expect(getWorkflow(w.f.db, "T1")?.mode).toBe("auto");
  } finally { w.f.close(); }
});

test("[PM 审定 2] off: no count, no notice, no event", async () => {
  const w = await stallWorld("off");
  try {
    for (const m of [1, 5, 10, 20, 30]) expect(await w.at(m)).toMatchObject({ step: "held", detail: "X" });
    expect(w.f.notices).toHaveLength(0);
    expect(w.since()).toHaveLength(0);
    expect(getIntent(w.f.db, w.intent.id)?.status).toBe("pending");
  } finally { w.f.close(); }
});
