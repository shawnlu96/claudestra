/**
 * MQ1S: an approval covers only the request whose complete binding it approved. An unexpired authorization A naming the request's
 * head, superseded by the ledger (same asker + key) with B naming another head, is not handed to B: B's approval does not lift A's
 * request, whether A was superseded before its deadline, after it (scan or not), across several hops, or A was cancelled / B refused /
 * expired / asked by someone else / on another card. On the real ledger CLI + real schedulerPass + fake GitHub merge
 * (tests/scheduler-merge-reclaim-world.ts); every negative is zero merge calls, no intent and no slot. Positives: B's own request (the
 * card at B's head) and A's own binding re-asked and approved each merge exactly once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { checkAsk } from "../src/lib/ask-bind.js";
import { closeAsk, getAsk } from "../src/lib/ledger-asks.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { answer as answerIn, authorize as authorizeIn, ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", KEY = "merge-current", OTHER = "b".repeat(40);
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const merges = (id: string) => w.hub.calls.filter((c) => c.endsWith(`merge:${id}`)).length;
const authorize = (taskId: string, head: string, o: { fromAgent?: string; key?: string } = {}) =>
  authorizeIn(w, taskId, "manual_merge", { askKey: o.key ?? KEY, params: { task: taskId, head }, fromAgent: o.fromAgent });
const answer = (id: string, button: string) => answerIn(w, id, button);
const overdue = (id: string) => w.db.query("UPDATE asks SET expiresAt = ? WHERE id = ?").run(Date.now() - 1, id);

async function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  writePolicy("on");
  return manualCard(w, "M");
}

/** The request waits for an approval it does not have: no merge call, no intent, no slot, over several passes. */
async function stillWaits(m: { taskId: string; head: string; reviewSeq: number }) {
  const r = await ledgerAs(w, PM, ...requestArgs(m));
  for (let i = 0; i < 3; i++) await w.pass();
  expect([r.ok, r.state, merges("M"), w.intentOf("M"), w.slot()]).toEqual([true, "waiting", 0, null, null]);
  return r;
}

/** The request merges exactly once (more passes after the merge send nothing more). */
async function mergesOnce() {
  for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
  await w.pass();
  expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
}

describe("P1 supersede: B's approval never covers A's request", () => {
  for (const when of ["before-deadline", "after-deadline-unscanned", "after-deadline-scanned"] as const) {
    test(`A (request head) superseded ${when} by B (other head), B approved: zero merge; A re-asked on its own binding merges once`, async () => {
      const m = await setup();
      const a = authorize("M", m.head);
      expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting" }); // A still open
      if (when !== "before-deadline") overdue(a.id);
      if (when === "after-deadline-scanned") closeAsk(w.db, a.id, "expired", "到期扫描", Date.now());
      const b = authorize("M", OTHER);
      answer(b.id, "go");
      const A = getAsk(w.db, a.id)!;
      expect(A.state).toBe(when === "after-deadline-scanned" ? "expired" : "superseded");
      if (when === "before-deadline") expect(A.updatedAt < A.expiresAt).toBe(true); // the pre-deadline gap MQ1 left open
      expect(checkAsk(getAsk(w.db, b.id), a.bind!.paramsHash, "scheduler")).toMatchObject({ ok: false }); // B's approval is not A's
      const r = await stillWaits(m);
      expect(String(r.why)).toContain(a.id);
      answer(authorize("M", m.head).id, "go"); // A's own complete binding, re-asked and approved
      await mergesOnce();
    }, 30_000);
  }

  test("multi-hop A(head) → B(other) → C(third), C approved: zero merge; A → … → A' (own binding) approved merges once", async () => {
    const m = await setup();
    const a = authorize("M", m.head);
    const b = authorize("M", OTHER);
    const c = authorize("M", "c".repeat(40));
    expect([getAsk(w.db, a.id)?.state, getAsk(w.db, b.id)?.state, c.supersedes]).toEqual(["superseded", "superseded", b.id]);
    answer(c.id, "go");
    await stillWaits(m);
    const a2 = authorize("M", m.head); // no open version left: a fresh version of A's decision
    answer(a2.id, "go");
    await mergesOnce();
  }, 30_000);

  test("multi-hop that comes back to A's binding: A → B → A' approved merges once", async () => {
    const m = await setup();
    authorize("M", m.head);
    authorize("M", OTHER);
    const a2 = authorize("M", m.head);
    await stillWaits(m); // A' open
    answer(a2.id, "go");
    await mergesOnce();
  }, 30_000);

  test("A cancelled, then B (other head) approved: zero merge", async () => {
    const m = await setup();
    const a = authorize("M", m.head);
    closeAsk(w.db, a.id, "cancelled", "撤", Date.now());
    answer(authorize("M", OTHER).id, "go");
    await stillWaits(m);
  }, 30_000);

  for (const end of ["refused", "expired"] as const) {
    test(`A superseded by B, B ${end}: zero merge`, async () => {
      const m = await setup();
      authorize("M", m.head);
      const b = authorize("M", OTHER);
      if (end === "refused") answer(b.id, "no");
      else closeAsk(w.db, b.id, "expired", "到期", Date.now());
      await stillWaits(m);
    }, 30_000);
  }

  test("B from another asker or on another card supersedes nothing here and approves nothing for A", async () => {
    const m = await setup();
    w.card("N");
    const a = authorize("M", m.head);
    answer(authorize("M", OTHER, { fromAgent: "agent-other" }).id, "go"); // another identity: A stays open
    answer(authorize("M", m.head, { key: "merge-elsewhere" }).id, "go"); // another key: another decision
    expect(getAsk(w.db, a.id)?.state).toBe("open");
    await stillWaits(m);
    closeAsk(w.db, a.id, "expired", "到期", Date.now());
    const n = authorize("N", m.head); // same asker + key on card N: another card's decision
    answer(n.id, "go");
    await stillWaits(m);
  }, 30_000);
});

describe("positive: B's own legitimate request", () => {
  test("A named another head, superseded before its deadline by B naming the card's head: B approved merges once", async () => {
    const m = await setup();
    const a = authorize("M", OTHER);
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting" });
    const b = authorize("M", m.head);
    expect([getAsk(w.db, a.id)?.state, b.supersedes]).toEqual(["superseded", a.id]);
    answer(b.id, "go");
    await mergesOnce();
  }, 30_000);

  test("multi-hop to B: A(other) → X(third) → B(card head) approved merges once", async () => {
    const m = await setup();
    authorize("M", OTHER);
    authorize("M", "c".repeat(40));
    const b = authorize("M", m.head);
    answer(b.id, "go");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    await mergesOnce();
  }, 30_000);
});
