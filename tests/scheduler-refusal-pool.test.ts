/**
 * dispatch-recovery-MODELXP1 · 池单策略拒审的识别与计划（纯函数）+ 只读句柄上收台账事实。
 * 审查单首拒 → 撤单、换家族、带豁免、告知一次；写单 / 修复单首拒换作者；豁免单或同步骤已换过的再拒 → manual；额度失败 → 不动。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../src/lib/ledger-write.js";
import { openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { turnFailureDoubt } from "../src/lib/lend-turn-failure.js";
import { EXEMPTION_TEXT } from "../src/lib/scheduler-model-outcome.js";
import { informKey } from "../src/lib/scheduler-model-wiring.js";
import {
  isPoolPolicyRefusal, planPoolRefusal, poolLedgerFacts, poolPlanEventData, poolRefusalKey, POOL_REFUSAL_OP, recognizePoolRefusal, lenderFactsFromReleaseText,
  type LenderFailureFacts, type PlanFacts, type PoolOrderFacts,
} from "../src/lib/scheduler-refusal-pool.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const USAGE = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const HEAD = "a".repeat(40);
const order = (over: Partial<PoolOrderFacts> = {}): PoolOrderFacts => ({ orderId: "lend:T1:s1:r2:a0", taskId: "T1", step: "review", family: "codex",
  peer: "HedeMacBook-Pro", state: "started", head: HEAD, specRev: 1, round: 2, exempt: false, ...over });
const card = { stage: "review", headSHA: HEAD, specRev: 1, round: 2 };
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ mode: "on", order: order(), authorFamily: "claude", security: false,
  confirmed: { kind: "confirmed", refusal: "cyber_policy", message: CYBER },
  placements: [{ machine: "HedeMacBook-Pro", family: "codex", free: true }, { machine: "peer-b", family: "claude", free: true }, { machine: "local", family: "claude", free: true }],
  prior: [], informed: new Set(), ...over });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

/** 出借方的结构化声明（MODELXP2 起由 release 带来；本卡测试里显式标「来源 = 出借方声明」） */
const declared = (over: Partial<LenderFailureFacts> = {}): LenderFailureFacts => ({ source: "lender_declared", category: "provider_policy",
  sessionId: "s-he-1", failedAt: 5_000, doubt: null, message: CYBER, ...over });

test("识别：只认 provider_policy；usage（额度）/ auth / network / other 一律 none", () => {
  expect(isPoolPolicyRefusal(CYBER)).toBe(true);
  expect(isPoolPolicyRefusal(USAGE)).toBe(true);
  for (const category of ["usage", "auth", "network", "other"] as const) {
    expect(recognizePoolRefusal(order(), card, declared({ category, message: "You've hit your usage limit" }))).toEqual({ kind: "none" });
  }
});

test("识别：出借方声明 + 已领单 + 有会话与失败时刻 + head / specRev / 轮次相符 → confirmed，分 cyber / usage_policy", () => {
  expect(recognizePoolRefusal(order(), card, declared())).toEqual({ kind: "confirmed", refusal: "cyber_policy", message: CYBER });
  expect(recognizePoolRefusal(order({ state: "claimed" }), card, declared({ message: USAGE })))
    .toEqual({ kind: "confirmed", refusal: "usage_policy", message: USAGE });
});

test("只有 release 原因文本（来源 = release_text）：最多 suspected，出不了执行计划", () => {
  const text = "worker 回合失败（内容策略拦截；出借方不自动重试、不换家族），没交结论；报错原文只留在出借方本机";
  const f = lenderFactsFromReleaseText(text);
  expect(f).toMatchObject({ source: "release_text", category: "provider_policy", sessionId: null, failedAt: null });
  expect(recognizePoolRefusal(order(), card, f)).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：只有 release 原因文本，没有出借方的结构化声明" });
  // 带上会话 / 时刻也一样：来源不是出借方声明就不确认
  expect(recognizePoolRefusal(order(), card, { ...f, sessionId: "s", failedAt: 1 }).kind).toBe("suspected");
  expect(lenderFactsFromReleaseText("worker 撞了 Codex 额度，没交结论").category).toBe("other");
  expect(recognizePoolRefusal(order(), card, lenderFactsFromReleaseText("worker 撞了 Codex 额度，没交结论"))).toEqual({ kind: "none" });
});

test("关联不确定就不动：疑点 / 缺会话或时刻 / 已结清 / 未领 / head 不符 → suspected，正文带原因", () => {
  expect(recognizePoolRefusal(order(), card, declared({ doubt: "失败之后会话又开过新回合" })))
    .toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：失败之后会话又开过新回合" });
  for (const over of [{ sessionId: null }, { failedAt: null }, { failedAt: Number.NaN }]) {
    expect(recognizePoolRefusal(order(), card, declared(over))).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：出借方声明缺会话或失败时刻" });
  }
  expect(recognizePoolRefusal(order({ state: "done" }), card, declared())).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：单已结清（done）" });
  expect(recognizePoolRefusal(order({ state: "cancelled" }), card, declared()).kind).toBe("suspected");
  expect(recognizePoolRefusal(order({ state: "pooled" }), card, declared())).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：单不在已领单状态（pooled）" });
  for (const c of [{ ...card, headSHA: "b".repeat(40) }, { ...card, specRev: 2 }, { ...card, round: 3 }, { ...card, stage: "fix" }]) {
    expect(recognizePoolRefusal(order(), c, declared())).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：head / specRev / 轮次和本单不符" });
  }
});

test("初始写单：order.head 是基线、卡在 build 尚无 head → confirmed；过期写单（步骤 / specRev / 轮次变了）仍 suspected", () => {
  const w = order({ step: "write", state: "claimed", round: 0 });
  const build = { stage: "build", headSHA: null, specRev: 1, round: 0 };
  expect(recognizePoolRefusal(w, build, declared())).toEqual({ kind: "confirmed", refusal: "cyber_policy", message: CYBER });
  // 卡后来有了 head（如重借），写单仍从基线起，不因 head 不同而失配
  expect(recognizePoolRefusal(w, { ...build, headSHA: "c".repeat(40) }, declared()).kind).toBe("confirmed");
  for (const c of [{ ...build, stage: "review" }, { ...build, specRev: 2 }, { ...build, round: 1 }]) {
    expect(recognizePoolRefusal(w, c, declared())).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：head / specRev / 轮次和本单不符" });
  }
  // 修复单从卡的 head 起：head 不符仍拦
  expect(recognizePoolRefusal(order({ step: "fix" }), { ...card, stage: "fix", headSHA: "b".repeat(40) }, declared()).kind).toBe("suspected");
});

test("出借方疑点可以直接是 turnFailureDoubt 的结论：老宿主卡没有失败时刻 → suspected", () => {
  const doubt = turnFailureDoubt({ extra: { failure: "error" } } as never, { sessionId: "s1", startedAt: 1 }, () => null);
  expect(recognizePoolRefusal(order(), card, declared({ doubt }))).toEqual({ kind: "suspected", note: "疑似池单拒审，未能确认：卡上没有失败时刻（老宿主）" });
});

test("PMDIR1 r2：审查单首次被拒 → 撤单、epoch、池里另一家族有空位的 peer、带豁免、告知 owner 一次", () => {
  const r = recognizePoolRefusal(order(), card, declared());
  if (r.kind !== "confirmed") throw new Error("应确认");
  const d = planPoolRefusal(facts({ confirmed: r }));
  expect(d).toMatchObject({ kind: "plan", mode: "on", key: poolRefusalKey("lend:T1:s1:r2:a0", "on"), plan: {
    kind: "replace", cancel: "provider_policy_refusal", step: "review", from: { machine: "HedeMacBook-Pro", family: "codex" },
    to: { machine: "peer-b", family: "claude" }, epoch: true, exemption: EXEMPTION_TEXT, crossModel: false, nextReviewFamily: null,
    inform: { key: informKey("T1", "cyber_policy"), first: true } } });
  // 同类拒审第二次：不再告知
  const again = planPoolRefusal(facts({ informed: new Set([informKey("T1", "cyber_policy")]) }));
  expect(again.kind === "plan" && again.plan.inform.first).toBe(false);
});

test("去处：池里没有另一家族空位 → 本机；本机也没有 → 等（to = null）；security 审查只在本机", () => {
  const busyPeer = [{ machine: "peer-b", family: "claude" as const, free: false }, { machine: "local", family: "claude" as const, free: true }];
  expect(planPoolRefusal(facts({ placements: busyPeer }))).toMatchObject({ plan: { to: { machine: "local", family: "claude" } } });
  const none = planPoolRefusal(facts({ placements: [{ machine: "local", family: "claude", free: false }, { machine: "x", family: "codex", free: true }] }));
  expect(none).toMatchObject({ plan: { kind: "replace", to: null } });
  expect(none.kind === "plan" && none.plan.kind === "replace" && none.plan.reason).toContain("等空位");
  expect(planPoolRefusal(facts({ security: true }))).toMatchObject({ plan: { to: { machine: "local", family: "claude" } } });
});

test("写单 / 修复单首次被拒：撤单换另一家族作者，不带豁免、不开 epoch，下一轮审查换家族", () => {
  for (const step of ["write", "fix"] as const) {
    const d = planPoolRefusal(facts({ order: order({ step, family: "codex" }) }));
    expect(d).toMatchObject({ plan: { kind: "replace", step, to: { machine: "peer-b", family: "claude" }, epoch: false, exemption: null, nextReviewFamily: "codex" } });
  }
});

test("豁免单再被拒 → manual（model_safety_hold），通知 PM，不再换、不同模型重试", () => {
  const d = planPoolRefusal(facts({ order: order({ orderId: "lend:T1:s1:r2:a1", family: "claude", peer: "peer-b", exempt: true }) }));
  expect(d).toMatchObject({ kind: "plan", plan: { kind: "manual", code: "model_safety_hold", notifyPm: true } });
  // 写单在本窗口已换过一次家族，新作者也被拒 → manual
  const w = planPoolRefusal(facts({ order: order({ orderId: "lend:T1:s1:r2:a1", step: "write", family: "claude" }),
    prior: [{ seq: 9, orderId: "lend:T1:s1:r2:a0", step: "write", family: "codex", plan: "replace" }] }));
  expect(w).toMatchObject({ plan: { kind: "manual" } });
  // review 首拒换过家族 → 审查交 changes 进 fix（同窗口）→ 修复单首拒：不是第二次，照样换作者
  const fixFirst = planPoolRefusal(facts({ order: order({ orderId: "fix-first", step: "fix", family: "claude" }),
    placements: [{ machine: "peer-b", family: "codex", free: true }],
    prior: [{ seq: 9, orderId: "review-old", step: "review", family: "codex", plan: "replace" }] }));
  expect(fixFirst).toMatchObject({ plan: { kind: "replace", step: "fix", to: { machine: "peer-b", family: "codex" }, nextReviewFamily: "claude" } });
  // 修复单自己换过一次后新作者再拒 → manual
  const fixAgain = planPoolRefusal(facts({ order: order({ orderId: "fix-second", step: "fix", family: "codex" }),
    prior: [{ seq: 9, orderId: "review-old", step: "review", family: "codex", plan: "replace" },
      { seq: 12, orderId: "fix-first", step: "fix", family: "claude", plan: "replace" }] }));
  expect(fixAgain).toMatchObject({ plan: { kind: "manual" } });
  // 同一单的重放不算第二次
  const replay = planPoolRefusal(facts({ prior: [{ seq: 9, orderId: "lend:T1:s1:r2:a0", step: "review", family: "codex", plan: "replace" }] }));
  expect(replay).toMatchObject({ plan: { kind: "replace" } });
});

test("开关：observe 只给计划（键按 observe），off 什么都不做", () => {
  expect(planPoolRefusal(facts({ mode: "off" }))).toEqual({ kind: "off" });
  expect(planPoolRefusal(facts({ mode: "observe" }))).toMatchObject({ kind: "plan", mode: "observe", key: poolRefusalKey("lend:T1:s1:r2:a0", "observe") });
});

test("只读台账：本窗口的计划记录与已告知键从只读句柄读出，别的窗口 / observe 记录不计", () => {
  const dir = mkdtempSync(join(tmpdir(), "modelxp1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "pool", kind: "code", agent: "agent-task-one", extra: {} });
  const d = planPoolRefusal(facts());
  if (d.kind !== "plan") throw new Error("unreachable");
  const put = (dedupKey: string, data: Record<string, unknown>) =>
    insertEvent(db, { actor: "scheduler", now: 5, dedupKey }, { project: "p", target: "T1", kind: "note", text: "x", data }, true);
  put(d.key, poolPlanEventData(d, order(), CYBER));
  put("old-window", { ...poolPlanEventData(d, order(), CYBER), round: 1 });
  put("observe", { ...poolPlanEventData({ ...d, mode: "observe" }, order({ orderId: "o2" }), CYBER) });
  put(informKey("T1", "cyber_policy"), { op: "refusal_owner_inform" });
  db.close();
  const reader = new LedgerReader(path);
  cleanup.push(() => reader.close());
  const ro = reader.get()!;
  const got = poolLedgerFacts(ro, "p", order({ orderId: "lend:T1:s1:r2:a1", family: "claude", exempt: false }), "on");
  expect(got.prior).toEqual([{ seq: expect.any(Number), orderId: "lend:T1:s1:r2:a0", step: "review", family: "codex", plan: "replace" }]);
  expect([...got.informed]).toEqual([informKey("T1", "cyber_policy")]);
  expect(POOL_REFUSAL_OP).toBe("pool_refusal_plan");
  // 新作者 / 新审查员再被拒：本窗口已换过 → manual，且不再告知 owner
  const next = planPoolRefusal(facts({ order: order({ orderId: "lend:T1:s1:r2:a1", family: "claude", peer: "peer-b" }), ...got }));
  expect(next).toMatchObject({ plan: { kind: "manual", inform: { first: false } } });
});
