/**
 * dispatch-recovery-MANEX1 · 池单这一路：人工合并队列与自动门同一豁免谓词（poolExemptVerdict）加同一张池审查回执（poolReviewRefusal）。
 * 真实池单链（同 ledger-pool-refusal-gate.test.ts）：池审查在 HedeMacBook-Pro（codex）被 cyber 拒 → 池单 epoch → 规划器按它重挂给
 * peer-b 的 claude（与作者同家族，单原文带豁免）→ peer-b 签票据交 pass → 卡进 merge → PM 接管为 manual → 真实 manual-merge-request
 * （只受理）。缺票据、旧订单（被拒的那张）、epoch 伪 actor、批准撤销 / 挂起都拒且不写请求。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { failureReason } from "../src/lib/lend-health.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { REVIEW_TICKET_PURPOSE } from "../src/lib/pool-review-proof-ticket.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { exemptVerdict } from "../src/lib/scheduler-review-swap.js";
import { requestAt, requestRefusal, reviewRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { aResultDeps, B_WORKER } from "./pool-review-proof-helpers.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const HE = "HedeMacBook-Pro", PB = "peer-b", PM = "pm";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

/** Lender B answering its claimed order through the real lend tools (signed review ticket). */
function lendSide(dir: string) {
  const key = instanceKeySync(mkdtempSync(join(dir, "b-key-")))!;
  const db = openLendJournal(":memory:");
  const pinned = { publicKey: key.publicKey, pinnedAt: new Date(0).toISOString() };
  async function answer(claim: { order: Record<string, unknown>; text: string; lease: { gen: number } }, send: (b: Record<string, unknown>) => Promise<Record<string, any>>) {
    const orderId = String(claim.order.orderId), work = mkdtempSync(join(dir, "b-work-"));
    writeFileSync(join(work, "report.md"), "## 结论");
    recordAsked(db, { orderId, peer: "home", fp: null, family: "claude", preview: {} }, 1);
    advance(db, orderId, "asked", "claimed", { wire: { order: claim.order, text: claim.text }, leaseGen: claim.lease.gen }, 1);
    advance(db, orderId, "claimed", "cloned", { dir: work }, 1);
    advance(db, orderId, "cloned", "started", { agent: B_WORKER, sessionId: "b-sess-1" }, 1);
    const who = { agent: B_WORKER, sessionId: "b-sess-1", family: "claude-code", verified: true };
    const deps = { db, log: () => {}, now: () => 2, signTicket: (f: string[]) => signPurpose(REVIEW_TICKET_PURPOSE, f, key),
      call: async (_p: string, _op: string, body: Record<string, unknown>) => { const r = await send(body); return { status: r.ok ? 200 : 400, body: r }; } };
    await routeLendTool("take_review", who, {}, deps as never);
    return routeLendTool("submit_verdict", who, { v: 1, orderId, head: claim.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" }, deps as never);
  }
  return { pinned, answer };
}

const hello = (f: ReturnType<typeof autoFixture>, peer: string, codex: number, claude: number) => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: "b",
  seq: 1, paused: null, slots: { codex: { total: codex, busy: 0 }, claude: { total: claude, busy: 0 } },
  grant: { until: Date.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());

async function poolExemptManual() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  cleanup.push(() => { f.close(); errors.mockRestore(); });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7', branch = 'feat/t1' WHERE id = 'T1'", [spec]);
  hello(f, HE, 2, 0);
  hello(f, PB, 0, 2);
  const borrow: BorrowEntry[] = [HE, PB].map((peer) => ({ peer, projects: ["p"], roles: ["review"], maxOpen: 2 }));
  const shared = ["ledger.sqlite", "recovery-policy.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); };
  unlink(); cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  writeFileSync(shared[1], JSON.stringify({ projects: { p: { keys: { modelOutcome: "on" } } } }));
  const ownerAnswer = (button: string, at: number) => {
    const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
    answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true, via: "web_card", at, final: true });
  };
  ownerAnswer("policy_refusal_rule_go", 2000);
  const b = lendSide(f.dir);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, ...aResultDeps(f.dir, b.pinned) };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend } as never, actor, ...args) as Promise<Record<string, any>>;
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: { mode: "balance", roles: ["review"], poolTimeoutMin: 15 } } },
      { ...f.tickDeps, manager: (...a) => cli("scheduler", ...a.slice(1)), borrow: async () => borrow } as AutoTickDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (name: string, ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", name, JSON.stringify(body));
  const orders = () => listLendOrders(f.db, "T1");
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect(await tick()).toMatchObject({ step: "pool_pooled" });
  expect((await peer(HE, "claim", { v: 1, orderId: orders()[0].orderId, worker: "w1" })).ok).toBe(true);
  await tick();
  expect((await peer(HE, "lease", { v: 1, orderId: orders()[0].orderId, gen: 1, action: "release", reason: "stopped",
    detail: failureReason({ kind: "error", askId: "a", message: CYBER }), failure: { class: "provider_policy", sessionId: "thr-1", failedAt: 5_000 } })).ok).toBe(true);
  expect(await tick()).toMatchObject({ step: "pool_refusal" });
  expect(await tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining(PB) });
  const second = orders()[1];
  expect(second).toMatchObject({ peer: PB, family: "claude" });
  const claimed = await peer(PB, "claim", { v: 1, orderId: second.orderId, worker: B_WORKER });
  expect(claimed.ok).toBe(true);
  expect(await b.answer(claimed as never, (body) => peer(PB, "write", body))).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow(); // the auto gate, before the takeover
  expect(await f.cli("owner", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--template", "code",
    "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工合并", "--reason", "PM 接管，人工合并")).toMatchObject({ ok: true });

  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const reviewEv = () => events().findLast((e) => e.kind === "review")!;
  const requests = () => events().filter((e) => e.data.op === "manual_merge_request");
  const request = () => f.cli(PM, "manual-merge-request", "T1", "--head", H1, "--spec-rev", String(f.task().specRev), "--round", String(f.task().round),
    "--review-seq", String(reviewEv().seq), "--reason", "人工审过，排队合并") as Promise<Record<string, unknown>>;
  const gates = () => {
    const r = currentReviewFacts(f.task(), events(), () => true);
    if (r.kind !== "facts") throw new Error("no facts");
    const fa = r.facts, ev = reviewEv();
    return { auto: exemptVerdict(f.db, f.task(), fa), manual: reviewRefusal(f.db, f.task(), events(), { requestedBy: PM,
      review: { seq: fa.eventSeq, actor: ev.actor, reviewer: fa.reviewer, sessionId: fa.reviewerSessionId, family: fa.reviewerFamily, reportPath: fa.reportPath, verdict: fa.verdict } }) };
  };
  const refused = async (why: RegExp) => {
    const before = requests().length, r = await request();
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toMatch(why);
    expect(requests().length).toBe(before);
  };
  /** Fault injection on this private fixture only: the append-only trigger is lifted to rewrite one field. */
  const patch = (seq: number, sql: string, ...args: (string | number)[]) => {
    const guards = f.db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events' AND sql LIKE '%UPDATE%'").all() as { name: string; sql: string }[];
    for (const g of guards) f.db.run(`DROP TRIGGER ${g.name}`);
    f.db.run(`UPDATE events SET ${sql} WHERE seq = ?`, [...args, seq]);
  };
  const epoch = events().find((e) => e.data.op === "pool_refusal_epoch")!;
  return { f, spec, epoch, second, first: orders()[0], reviewEv, requests, request, gates, refused, patch, ownerAnswer };
}

test("pool exemption: the same-family pool verdict passes the auto predicate and the manual queue; the request is only queued", async () => {
  const s = await poolExemptManual();
  expect(s.reviewEv()).toMatchObject({ actor: `peer:${PB}`, data: { reviewer: `peer:${PB}`, reviewerFamily: "claude" } });
  expect(s.gates()).toEqual({ auto: true, manual: null });
  expect(await s.request()).toMatchObject({ ok: true, duplicate: false });
  expect(s.requests()).toHaveLength(1);
  expect(s.requests()[0].data.review).toMatchObject({ actor: `peer:${PB}`, family: "claude" });
  expect(listEvents(s.f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "manual_merge_claim" || e.data.op === "merge_phase")).toBe(false);
});

test("pool verdict without its signed ticket / receipt: refused even though the epoch chain holds", async () => {
  const s = await poolExemptManual();
  s.f.db.run("UPDATE lend_orders SET receipt = NULL WHERE orderId = ?", [s.second.orderId]);
  expect(s.gates().manual).toMatch(/回执/);
  await s.refused(/回执/);
});

test("the verdict pointed at the refused (old) order: refused", async () => {
  const s = await poolExemptManual();
  s.patch(s.reviewEv().seq, "data = json_set(data, '$.lend.orderId', ?)", s.first.orderId);
  expect(s.gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
  await s.refused(/不是跨模型/);
});

test("an epoch not written by the scheduler (forged actor): refused", async () => {
  const s = await poolExemptManual();
  s.patch(s.epoch.seq, "actor = ?", PM);
  expect(s.gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
  await s.refused(/不是跨模型/);
});

test("approval revoked, or held by the owner on the card: refused", async () => {
  const s = await poolExemptManual();
  s.f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'");
  expect(s.gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
  await s.refused(/不是跨模型|挂起/);
  s.f.db.run("UPDATE tasks SET extra = json_remove(extra, '$.refusalHold') WHERE id = 'T1'");
  expect(s.gates()).toEqual({ auto: true, manual: null });
  s.ownerAnswer("policy_refusal_rule_stop", 3000);
  expect(s.gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
  await s.refused(/不是跨模型/);
});

describe("pool materials: the spec both pool orders carried must still be the spec file now (r2 manex-material-drift)", () => {
  test("spec content changed after the exempt pool verdict: refused, nothing written; the same bytes again pass", async () => {
    const s = await poolExemptManual();
    writeFileSync(s.spec, "规格：只改 src/lib/y.ts\n验收：单测全绿\n");
    expect(s.gates()).toEqual({ auto: true, manual: expect.stringMatching(/池审查单规格.*不一致/) });
    await s.refused(/池审查单规格.*不一致/);
    writeFileSync(s.spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
    expect(s.gates()).toEqual({ auto: true, manual: null });
  });

  test("spec changed after acceptance: the queue's recheck voids the request", async () => {
    const s = await poolExemptManual();
    const r = await s.request();
    expect(r).toMatchObject({ ok: true });
    const req = requestAt(s.f.db, Number(r.request))!;
    expect(requestRefusal(s.f.db, req, Date.now(), true)?.kind ?? null).not.toBe("void");
    writeFileSync(s.spec, "规格：只改 src/lib/y.ts\n验收：单测全绿\n");
    expect(requestRefusal(s.f.db, req, Date.now(), true)).toMatchObject({ kind: "void", why: expect.stringMatching(/池审查单规格.*不一致/) });
  });

  test("spec file gone, or the refused order's frozen spec differs from the exempt order's: refused", async () => {
    const s = await poolExemptManual();
    rmSync(s.spec);
    expect(s.gates().manual).toMatch(/池审查单规格.*读不到/);
    writeFileSync(s.spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
    expect(s.gates().manual).toBeNull();
    s.f.db.run("UPDATE lend_orders SET wire = json_set(wire, '$.inputs[0]', ?) WHERE orderId = ?", ["规格原文（specRev 1）：\n别的规格\n", s.first.orderId]);
    expect(s.gates().manual).toMatch(/被拒池审查单.*不一致/);
    await s.refused(/被拒池审查单.*不一致/);
  });
});
