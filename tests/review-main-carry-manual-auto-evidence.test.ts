/**
 * MAINP2 审查 r1 policy-drift / missing-chain：auto 沿用回执带完整链，写事务内核链并现读 mainCarry；真实临时 SQLite。
 * 接进 scheduler-merge-step 的端到端（只读 reader + 真实 CLI 子进程）随热点接线批准后补在 review-main-carry-manual-auto.test.ts。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { autoCarryEvidence, carryChainOf, MAX_AUTO_HOPS, carryChainSuffix, type CarryHop, type ReviewProof } from "../src/lib/review-main-carry-manual-auto.js";
import { carryReceipt, parseCarryReceipt } from "../src/lib/scheduler-merge.js";
import type { ReviewFacts } from "../src/lib/scheduler-review.js";

const h = (n: number) => n.toString(16).padStart(40, "0");
const OLD = h(1), D = "d".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "mainp2-auto-ev-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
afterAll(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "a" });
createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T2", title: "T2", kind: "code", agent: "a" });
for (const id of ["T1", "T2"]) setWorkflow(db, { actor: "owner", now: 4 }, { taskId: id, taskRev: getTask(db, id)!.rev, template: "code", templateVersion: 2,
  mode: "manual", authorFamily: "claude", fallback: "人工", reason: "pm_takeover: 测试" });
db.query("UPDATE tasks SET stage='merge', round=1, headSHA=? WHERE id='T1'").run(OLD);
const reviewSeq = insertEvent(db, { actor: "rv", now: 2 }, { project: "p", target: "T1", kind: "review", text: "",
  data: { round: 1, head: OLD, verdict: "pass", reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false).seq;
db.query("UPDATE tasks SET stage='merge', round=1, headSHA=? WHERE id='T2'").run(OLD);
/** stands in for scheduler-merge.ts mergeReviewProof: T1's PASS holds, T2 has none */
const proof: ReviewProof = (_db, t) => {
  if (t.id !== "T1") throw new Error("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
  return { eventSeq: reviewSeq } as ReviewFacts;
};

/** n hops from OLD: heads 1000+i, main parents 2000+i */
const chainOf = (n: number): CarryHop[] => Array.from({ length: n }, (_, i) => ({ previousHead: i ? h(1000 + i - 1) : OLD, head: h(1000 + i), mainParent: h(2000 + i) }));
const evOf = (c: CarryHop[]) => ({ oldHead: OLD, newHead: c.at(-1)!.head, mainParent: c.at(-1)!.mainParent });
const raw = (c: CarryHop[]) => carryChainOf(carryReceipt({ ...evOf(c), mainHead: h(3000), diffHash: D }) + carryChainSuffix(c))!.raw;
const task = (id = "T1") => getTask(db, id)!;

describe("receipt: chain appended after the unchanged base", () => {
  test("round trip; the base still parses as before and fits the 600-char receipt check; no chain = no suffix", () => {
    const c = chainOf(MAX_AUTO_HOPS), base = carryReceipt({ ...evOf(c), mainHead: h(3000), diffHash: D });
    const split = carryChainOf(base + carryChainSuffix(c))!;
    expect(split.base).toBe(base);
    expect(parseCarryReceipt(split.base)).toMatchObject({ oldHead: OLD, newHead: c.at(-1)!.head });
    expect(split.base.length).toBeLessThanOrEqual(600);
    expect(carryChainSuffix(undefined)).toBe("");
    expect(carryChainOf(base)).toBeNull();
  });
});

describe("autoCarryEvidence inside the write transaction", () => {
  test("2 hops under on: full chain, hop count and the source PASS seq", () => {
    const c = chainOf(2);
    expect(autoCarryEvidence(db, task(), evOf(c), raw(c), proof, () => 16)).toEqual({ chain: c, hops: 2, sourceReviewSeq: reviewSeq, mainCarry: "on" });
    expect(autoCarryEvidence(db, task(), evOf(chainOf(1)), raw(chainOf(1)), proof, () => 1)).toMatchObject({ hops: 1, mainCarry: "single" });
    expect(autoCarryEvidence(db, task(), evOf(chainOf(16)), raw(chainOf(16)), proof, () => 16)).toMatchObject({ hops: 16 });
  });
  test("policy read at write time: observe / off (1 hop allowed) refuses a multi-hop carry", () => {
    const c = chainOf(2);
    expect(() => autoCarryEvidence(db, task(), evOf(c), raw(c), proof, () => 1)).toThrow(/mainCarry 策略不是 on/);
  });
  test("missing, malformed, discontinuous, short, overlong or wrong-parent chains and a card without a review refuse", () => {
    const c = chainOf(2), ev = evOf(c);
    const no = (r: string | undefined, why: RegExp, e = ev) => expect(() => autoCarryEvidence(db, task(), e, r, proof, () => 16)).toThrow(why);
    no(undefined, /缺完整链/);
    no("{", /JSON/);
    no("[]", /1\.\.16/);
    no(JSON.stringify([[OLD, h(1000), "X".repeat(40)]]), /完整小写 SHA/);
    no(JSON.stringify([[OLD, h(1000), h(2000)], [h(999), h(1001), h(2001)]]), /不连续/);
    no(raw(chainOf(1)), /没走到/);
    no(raw(c), /main 父提交/, { ...ev, mainParent: h(2000) });
    const long = chainOf(17);
    no(raw(long), /1\.\.16/, evOf(long));
    expect(() => autoCarryEvidence(db, task("T2"), ev, raw(c), proof, () => 16)).toThrow(/正式来源审查门不成立.*审查通过结论/);
  });
  test("review r2 exempt-drift: the formal review gate is re-run with the card's workflow; its refusal is a conflict, and no workflow refuses", () => {
    const c = chainOf(2), seen: string[] = [];
    const watch: ReviewProof = (d, t, w) => { seen.push(`${t.id}:${t.headSHA}:${w.authorFamily}`); return proof(d, t, w); };
    autoCarryEvidence(db, task(), evOf(c), raw(c), watch, () => 16);
    expect(seen).toEqual([`T1:${OLD}:claude`]);
    const revoked: ReviewProof = () => { throw new Error("审查员与作者同家族且没有 owner 当前有效的豁免"); };
    expect(() => autoCarryEvidence(db, task(), evOf(c), raw(c), revoked, () => 16)).toThrow(/来源 \/ 家族 \/ 豁免已变.*豁免/);
    createTask(db, { actor: "owner", now: 5 }, { project: "p", id: "T3", title: "T3", kind: "code", agent: "a" });
    expect(() => autoCarryEvidence(db, task("T3"), evOf(c), raw(c), proof, () => 16)).toThrow(/没有流程记录/);
  });
});
