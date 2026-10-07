/**
 * dispatch-recovery-MODELXP2 验收线 6 · 两道合并闸共用一个池单豁免谓词（ledger-pool-refusal-gate.ts）：
 * pool-review-proof.ts（池审查回执）与 scheduler-review-swap.ts exemptVerdict（scheduler-merge mergeReviewProof、review-main-carry-manual
 * reviewGate、merge-ready 三个入口）。豁免成立 → 过；任何一条不满足 → 照旧拒。走一张真实的卡：池审查在 HedeMacBook-Pro（codex）被拒
 * → epoch → 规划器重挂给 peer-b 的 claude（与作者同家族，带豁免）→ peer-b 签票据交 pass。台账 CLI 在进程内跑（闸是同一份代码）。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { poolExemptLapse } from "../src/lib/ledger-pool-refusal-gate.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { failureReason } from "../src/lib/lend-health.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { poolReviewRefusal } from "../src/lib/pool-review-proof.js";
import { reviewGate } from "../src/lib/review-main-carry-manual.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { mkdtempSync } from "node:fs";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { REVIEW_TICKET_PURPOSE } from "../src/lib/pool-review-proof-ticket.js";
import { aResultDeps, B_WORKER } from "./pool-review-proof-helpers.js";

/** 出借方 B（同 pool-review-proof-helpers lendSide，单的家族按派单原文取：豁免单是 claude） */
function lendSideOf(dir: string) {
  const key = instanceKeySync(mkdtempSync(join(dir, "b-key-")))!;
  const db = openLendJournal(":memory:");
  const pinned = { publicKey: key.publicKey, pinnedAt: new Date(0).toISOString() };
  async function answer(claim: { order: Record<string, unknown>; text: string; lease: { gen: number } }, family: "claude" | "codex",
    send: (b: Record<string, unknown>) => Promise<Record<string, any>>) {
    const orderId = String(claim.order.orderId), work = mkdtempSync(join(dir, "b-work-"));
    writeFileSync(join(work, "report.md"), "## 结论");
    recordAsked(db, { orderId, peer: "home", fp: null, family, preview: {} }, 1);
    advance(db, orderId, "asked", "claimed", { wire: { order: claim.order, text: claim.text }, leaseGen: claim.lease.gen }, 1);
    advance(db, orderId, "claimed", "cloned", { dir: work }, 1);
    advance(db, orderId, "cloned", "started", { agent: B_WORKER, sessionId: "b-sess-1" }, 1);
    const who = { agent: B_WORKER, sessionId: "b-sess-1", family: family === "claude" ? "claude-code" : "codex", verified: true }; // 已验证身份报的是 runtime
    const deps = { db, log: () => {}, now: () => 2, signTicket: (f: string[]) => signPurpose(REVIEW_TICKET_PURPOSE, f, key),
      call: async (_p: string, _op: string, body: Record<string, unknown>) => { const r = await send(body); return { status: r.ok ? 200 : 400, body: r }; } };
    await routeLendTool("take_review", who, {}, deps as never);
    return routeLendTool("submit_verdict", who, { v: 1, orderId, head: claim.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [],
      reportPath: "report.md" }, deps as never);
  }
  return { pinned, answer };
}

const CYBER = "This request has been flagged for possible cybersecurity risk";
const HE = "HedeMacBook-Pro", PB = "peer-b";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

const hello = (f: ReturnType<typeof autoFixture>, peer: string, codex: number, claude: number) => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: "b",
  seq: 1, paused: null, slots: { codex: { total: codex, busy: 0 }, claude: { total: claude, busy: 0 } },
  grant: { until: Date.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());

/** 卡走到 merge：池审查被拒 → 换 peer-b claude 豁免审查交 pass */
async function exemptPass() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  cleanup.push(() => { f.close(); errors.mockRestore(); });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  hello(f, HE, 2, 0);
  hello(f, PB, 0, 2);
  const borrow: BorrowEntry[] = [HE, PB].map((peer) => ({ peer, projects: ["p"], roles: ["review"], maxOpen: 2 }));
  const shared = ["ledger.sqlite", "recovery-policy.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); };
  unlink(); cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  writeFileSync(shared[1], JSON.stringify({ projects: { p: { keys: { modelOutcome: "on" } } } }));
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
  const b = lendSideOf(f.dir);
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
  expect(await b.answer(claimed as never, "claude", (body) => peer(PB, "write", body))).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const epoch = events().find((e) => e.data.op === "pool_refusal_epoch")!;
  const task = () => getTask(f.db, "T1")!;
  const facts = () => { const r = currentReviewFacts(task(), events()); if (r.kind !== "facts") throw new Error("no facts"); return r.facts; };
  /** 三处判定：池审查回执、scheduler-merge 入口、main-carry 入口 */
  const gates = () => {
    const wf = getWorkflow(f.db, "T1")!;
    const proof = poolReviewRefusal(f.db, task(), wf, facts());
    let merge: string | null = null, carry: string | null = null;
    try { mergeReviewProof(f.db, task(), wf); } catch (e) { merge = (e as Error).message; }
    try { reviewGate(f.db, task(), Date.now()); } catch (e) { carry = (e as Error).message; }
    return { proof, merge, carry, lapse: poolExemptLapse(f.db, task(), facts()) };
  };
  /** 改一条事件 / 行，跑完还原 */
  const patchEvent = (seq: number, path: string, value: unknown) => {
    // 台账事件只追加（触发器）：反例要改已写的事件，测试里临时摘掉触发器、改完原样装回
    const guards = f.db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events' AND sql LIKE '%UPDATE%'").all() as { name: string; sql: string }[];
    const unguarded = (fn: () => void) => { for (const g of guards) f.db.run(`DROP TRIGGER ${g.name}`); try { fn(); } finally { for (const g of guards) f.db.run(g.sql); } };
    const old = (f.db.query("SELECT data FROM events WHERE seq = ?").get(seq) as { data: string }).data;
    unguarded(() => f.db.run(`UPDATE events SET data = json_set(data, '${path}', json(?)) WHERE seq = ?`, [JSON.stringify(value), seq]));
    return () => unguarded(() => f.db.run("UPDATE events SET data = ? WHERE seq = ?", [old, seq]));
  };
  return { f, epoch, second, gates, patchEvent, approvalId: ask.id };
}

const refusedEverywhere = (g: ReturnType<Awaited<ReturnType<typeof exemptPass>>["gates"]>) => {
  expect(g.lapse).not.toBeNull();
  expect(g.proof).toContain("审查家族 claude 与实际作者家族相同");
  expect(g.merge).toBeTruthy();
  expect(g.carry).toBeTruthy();
};

test("池单豁免成立：池审查回执、scheduler-merge、main-carry 三处都放行（同家族 claude 审查 claude 作者）", async () => {
  const s = await exemptPass();
  expect(s.gates()).toEqual({ proof: null, merge: null, carry: null, lapse: null });
});

test("反例：epoch 属于别的 head / specRev / round → 照旧拒", async () => {
  const s = await exemptPass();
  for (const [path, v] of [["$.head", "b".repeat(40)], ["$.specRev", 9], ["$.round", 7]] as const) {
    const undo = s.patchEvent(s.epoch.seq, path, v);
    const g = s.gates();
    refusedEverywhere(g);
    expect(g.lapse).toMatch(/窗口/);
    undo();
  }
  expect(s.gates().lapse).toBeNull();
});

test("反例：toFamily ≠ 本单家族 / 去处 peer 不是本单 → 照旧拒", async () => {
  const s = await exemptPass();
  for (const [path, v] of [["$.toFamily", "codex"], ["$.to", { machine: "other-peer", family: "claude" }]] as const) {
    const undo = s.patchEvent(s.epoch.seq, path, v);
    refusedEverywhere(s.gates());
    undo();
  }
});

test("反例：单不是在 epoch 之后按它挂出的（意图早于 epoch / 意图理由不带 epoch 号）→ 照旧拒", async () => {
  const s = await exemptPass();
  const intent = s.f.db.query("SELECT id, causalSeq, reason FROM scheduler_intents WHERE recipient = ? ORDER BY eventSeq DESC LIMIT 1").get(`peer:${PB}`) as
    { id: string; causalSeq: number; reason: string };
  s.f.db.run("UPDATE scheduler_intents SET causalSeq = ? WHERE id = ?", [s.epoch.seq - 1, intent.id]);
  refusedEverywhere(s.gates());
  s.f.db.run("UPDATE scheduler_intents SET causalSeq = ?, reason = ? WHERE id = ?", [intent.causalSeq, "挂池：普通审查", intent.id]);
  refusedEverywhere(s.gates());
  s.f.db.run("UPDATE scheduler_intents SET reason = ? WHERE id = ?", [intent.reason, intent.id]);
  expect(s.gates().lapse).toBeNull();
});

test("反例：没有豁免文本 / 单原文没带它 / 批准已撤销 → 照旧拒", async () => {
  const s = await exemptPass();
  const undo = s.patchEvent(s.epoch.seq, "$.exemption", "");
  refusedEverywhere(s.gates());
  undo();
  const text = s.second.text;
  s.f.db.run("UPDATE lend_orders SET text = ? WHERE orderId = ?", [text.replaceAll("跨模型审查豁免", "审查"), s.second.orderId]);
  refusedEverywhere(s.gates());
  s.f.db.run("UPDATE lend_orders SET text = ? WHERE orderId = ?", [text, s.second.orderId]);
  expect(s.gates().lapse).toBeNull();
  // owner 后来撤销规矩（更晚的回答不是批准按钮）
  const revoke = openAsk(s.f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 2999);
  answerAsk(s.f.db, revoke.id, { choices: ["[button:policy_refusal_rule_stop]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 3000, final: true });
  const g = s.gates();
  refusedEverywhere(g);
  expect(g.lapse).toMatch(/批准/);
});

test("反例：结论本身不对（会话不是绑这张单的）/ 没有 epoch 的同家族单 → 照旧拒「审查家族与作者相同」", async () => {
  const s = await exemptPass();
  const review = listEvents(s.f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!;
  const undoSession = s.patchEvent(review.seq, "$.reviewerSessionId", `lend:${PB}:other-order`);
  const bad = s.gates();
  expect(bad.lapse).toMatch(/结论/);
  expect([bad.proof, bad.merge, bad.carry].every(Boolean)).toBe(true);
  undoSession();
  const undo = s.patchEvent(s.epoch.seq, "$.op", "something_else");
  const g = s.gates();
  refusedEverywhere(g);
  expect(g.lapse).toMatch(/没有池单拒审 epoch/);
  undo();
  expect(s.gates()).toEqual({ proof: null, merge: null, carry: null, lapse: null });
});
