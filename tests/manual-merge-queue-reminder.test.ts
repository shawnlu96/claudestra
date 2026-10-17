/** Reminder exclusions must never cover an owner decision, even from the same creator. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ownerCardPort } from "../src/bridge/manual-deliver-notice.js";
import { ASK_REMINDER_SOURCES, isReminderOwnerAction } from "../src/lib/ask-reminder-sources.js";
import { bindHash } from "../src/lib/ask-bind.js";
import { resultCard } from "../src/lib/center-proposal-inbox.js";
import { closeAsk, getAsk, openAskFull, type NewAsk } from "../src/lib/ledger-asks.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { requestAt, requestRefusal, type ManualRequest } from "../src/lib/manual-merge-queue-facts.js";
import { recordRequest } from "../src/lib/manual-merge-queue.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { manualCard } from "./manual-merge-queue-world.test.js";

let w: ReclaimWorld, req: ManualRequest;
const now = Date.now();
beforeEach(async () => {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
  const m = await manualCard(w, "M");
  const result = recordRequest(w.db, { actor: "agent-pm", now }, {
    taskId: "M", head: m.head, specRev: 1, round: 1, reviewSeq: m.reviewSeq, reason: "审过，排队合并",
  });
  req = requestAt(w.db, result.request.seq)!;
  expect(refusal()).toBeNull();
});
afterEach(() => w?.close());
const refusal = () => requestRefusal(w.db, req, now, false, () => false, () => false);
const ask = (input: Partial<NewAsk> = {}) => openAskFull(w.db, {
  project: "p", taskId: "M", source: "system", kind: "owner_action", title: "提醒", ...input,
}, now - 100).ask;

for (const createdBy of ["system:manual-deliver-notice", "system:priority-stall"]) {
  for (const state of ["cancelled", "open", "expired"] as const) {
    test(`${createdBy} ${state} does not block a reviewed manual request`, () => {
      const a = ask({ createdBy });
      if (state !== "open") closeAsk(w.db, a.id, state, "提醒结束", now - 1);
      expect(refusal()).toBeNull();
    });
  }
  for (const state of ["cancelled", "expired", "open"] as const) {
    test(`authorize from reminder creator ${createdBy}, ${state}, still waits`, () => {
      const a = ask({ createdBy, kind: "authorize" });
      if (state !== "open") closeAsk(w.db, a.id, state, "未批准", now - 1);
      expect(refusal()?.kind).toBe("wait");
    });
  }
  test(`creator ${createdBy} with suffix is not a reminder`, () => {
    const a = ask({ createdBy: `${createdBy}x` });
    closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
    expect(refusal()?.why).toBe(`授权 ${a.id} 未获答复即 cancelled（过期 / 撤销不是批准）：等 owner 在重新问的授权上批准`);
  });
}

test("bridge's actual owner reminder stays in the exact creator inventory and never blocks", () => {
  const port = ownerCardPort(() => w.db, () => {});
  const id = port.openOwnerCard({ project: "p", taskId: "M", title: "等派审", context: "已交付", dedupKey: "mdn:1", prefix: "mdn:" });
  const a = getAsk(w.db, id)!;
  expect(a.kind).toBe("owner_action");
  expect(ASK_REMINDER_SOURCES.includes(a.createdBy ?? "")).toBe(true);
  expect(a.options).toEqual([{ type: "buttons", buttons: [{ id: "mdn_ack", label: "知道了", style: "secondary" }] }]);
  expect(refusal()).toBeNull();
  port.closeOwnerCards("mdn:", "已派审");
  expect(getAsk(w.db, id)?.state).toBe("cancelled");
  expect(refusal()).toBeNull();
});

test("human owner_action cancellation keeps the exact waiting text", () => {
  const a = ask({ source: "human", createdBy: "owner:self" });
  closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
  expect(refusal()).toEqual({ kind: "wait",
    why: `授权 ${a.id} 未获答复即 cancelled（过期 / 撤销不是批准）：等 owner 在重新问的授权上批准` });
});

for (const state of ["expired", "cancelled", "open"] as const) {
  test(`system:scheduler authorize ${state} retains its refusal`, () => {
    const a = ask({ createdBy: "system:scheduler", kind: "authorize" });
    if (state !== "open") closeAsk(w.db, a.id, state, "未批准", now - 1);
    expect(refusal()).toEqual({ kind: "wait", why: state === "open" ? `审批未答：${a.id}`
      : `授权 ${a.id} 未获答复即 ${state}（过期 / 撤销不是批准）：等 owner 在重新问的授权上批准` });
  });
}

test("source alone and fromAgent cannot masquerade as a reminder creator", () => {
  const a = ask({ createdBy: "owner:self", fromAgent: "system:manual-deliver-notice" });
  closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
  expect(refusal()?.kind).toBe("wait");
});

test("transport source does not change exact creator classification; other kinds still block", () => {
  const a = ask({ source: "human", createdBy: "system:manual-deliver-notice" });
  expect(refusal()).toBeNull();
  closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
  const b = ask({ kind: "decide", createdBy: "system:manual-deliver-notice" });
  expect(refusal()).toEqual({ kind: "wait", why: `审批未答：${b.id}` });
});

test("result cards that can hand work to master are not acknowledgement-only reminders", () => {
  const input = resultCard("proposal", "结果", "需要处理");
  expect(isReminderOwnerAction(input)).toBe(false);
  const a = ask({ ...input, project: "p", taskId: "M" });
  expect(refusal()?.kind).toBe("wait");
  closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
  expect(refusal()?.kind).toBe("wait");
});

test("a cancelled real decision still waits alongside an open reminder", () => {
  ask({ createdBy: "system:priority-stall" });
  const binding = { action: "merge", params: { head: req.head }, approve: ["go"] };
  const a = ask({ kind: "authorize", createdBy: "system:scheduler", bind: { ...binding, paramsHash: bindHash(binding, "") } });
  closeAsk(w.db, a.id, "cancelled", "撤销", now - 1);
  expect(refusal()?.why).toContain(`授权 ${a.id} 未获答复即 cancelled`);
});

test("a reminder cannot approve a real decision by superseding its open ask", () => {
  const prior = ask({ createdBy: "owner:self", fromAgent: "agent-pm", askKey: "same-decision" });
  ask({ createdBy: "system:manual-deliver-notice", fromAgent: "agent-pm", askKey: "same-decision" });
  expect(getAsk(w.db, prior.id)?.state).toBe("superseded");
  expect(refusal()?.kind).toBe("wait");
  expect(refusal()?.why).toContain(`授权 ${prior.id} 被取代`);
});
