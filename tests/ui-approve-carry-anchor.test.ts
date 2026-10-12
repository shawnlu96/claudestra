/**
 * UICARRY2 anchor limits on a real ledger file through recordUiVerdict: the whole carry chain stays within 16 events however
 * many intermediate re-approvals it has, a head repeated on the chain (loop) never anchors, and recursion re-proves each anchor.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { recordUiVerdict } from "../src/lib/ledger-ui-approve.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

const PM = "agent-pm", DIGEST = "a".repeat(64), REVIEW_HEAD = "0".repeat(40);
const head = (i: number) => (i + 1).toString(16).padStart(40, "e");
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function ledger() {
  dir = mkdtempSync(join(tmpdir(), "uicarry2-anchor-"));
  const db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: [PM] });
  createTask(db, { actor: "owner" }, { project: "p", id: "T", title: "screenshots", kind: "code", agent: "author" });
  setWorkflow(db, { actor: "owner" }, { taskId: "T", taskRev: getTask(db, "T")!.rev, template: "ui", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "PM", reason: "pm_takeover" });
  db.query("UPDATE tasks SET stage='review', round=1, specRev=1, headSHA=?, extra=? WHERE id='T'").run(REVIEW_HEAD, JSON.stringify({ screenshotsDigest: DIGEST }));
  insertEvent(db, { actor: PM }, { project: "p", target: "T", kind: "review", text: "pass", data: { round: 1, head: REVIEW_HEAD, verdict: "pass",
    reviewer: "r", reviewerSessionId: "s", reviewerFamily: "codex", path: "/r.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  const approve = (h: string) => recordUiVerdict(db, { actor: PM }, { taskId: "T", verdict: "approve", head: h, digest: DIGEST });
  approve(REVIEW_HEAD);
  db.query("UPDATE tasks SET stage='merge' WHERE id='T'").run();
  let at = REVIEW_HEAD, n = 0;
  /** The scheduler's own update-branch carry with its paired merge_phase (scheduler-merge.ts carryReview's shape). */
  const hop = (to: string) => {
    const intentId = `i${n++}`;
    const c = insertEvent(db, { actor: "scheduler" }, { project: "p", target: "T", kind: "scheduler", text: "carry",
      data: { op: "review_carry", intentId, from: at, to, round: 1, specRev: 1 } }, false);
    insertEvent(db, { actor: "scheduler" }, { project: "p", target: "T", kind: "scheduler", text: "phase",
      data: { op: "merge_phase", intentId, carrySeq: c.seq, to: "await_ci" } }, false);
    db.query("UPDATE tasks SET headSHA=? WHERE id='T'").run(to);
    at = to;
  };
  const count = () => listEvents(db, { project: "p", target: "T" }).length;
  return { db, approve, hop, count };
}

test("16 carries with re-approvals along the way anchor; a 17th is refused, re-approvals do not reset the cap", () => {
  const l = ledger();
  for (let i = 0; i < 16; i++) {
    l.hop(head(i));
    expect(l.approve(head(i)).event.data).toMatchObject({ head: head(i), carriedFrom: i ? head(i - 1) : REVIEW_HEAD });
  }
  l.hop(head(16));
  const before = l.count();
  expect(() => l.approve(head(16))).toThrow("沿用链超过 16 跳");
  expect(l.count()).toBe(before);
});

test("an approval far back on the chain anchors the carry suffix behind it and keeps the prefix apart", () => {
  const l = ledger();
  l.hop(head(0)); l.hop(head(1));
  const first = l.approve(head(1)).event;
  for (let i = 2; i < 6; i++) l.hop(head(i));
  const e = l.approve(head(5)).event;
  const carries = listEvents(l.db, { project: "p", target: "T" }).filter((x) => x.data.op === "review_carry").map((x) => x.seq);
  expect(first.data).toMatchObject({ carriedFrom: REVIEW_HEAD, reviewCarrySeqs: carries.slice(0, 2) });
  expect(e.data).toMatchObject({ carriedFrom: head(1), anchorSeq: first.seq, prefixCarrySeqs: carries.slice(0, 2), reviewCarrySeqs: carries.slice(2) });
});

test("a head repeated on the chain (loop) never anchors", () => {
  const l = ledger();
  l.hop(head(0)); l.approve(head(0));
  l.hop(head(1)); l.hop(head(0)); l.hop(head(2));
  const before = l.count();
  expect(() => l.approve(head(2))).toThrow("重复 head 或循环");
  expect(l.count()).toBe(before);
});

test("a chain looping back to the review head carries nothing", () => {
  const l = ledger();
  l.hop(head(0)); l.approve(head(0)); l.hop(REVIEW_HEAD);
  const before = l.count();
  expect(() => l.approve(REVIEW_HEAD)).toThrow();
  expect(l.count()).toBe(before);
});

test("an approval copied onto a later seq with a forged anchor is refused", () => {
  const l = ledger();
  l.hop(head(0)); const a = l.approve(head(0)).event;
  l.hop(head(1)); const b = l.approve(head(1)).event;
  l.hop(head(2));
  // a PM-signed row claiming head(1) with the anchor pointing at itself's predecessor, written while the card sat on head(2)
  insertEvent(l.db, { actor: PM }, { project: "p", target: "T", kind: "decision", text: "copy", data: { ...b.data, anchorSeq: a.seq } }, false);
  const before = l.count();
  expect(() => l.approve(head(2))).toThrow("不是同一沿用链上可核的中间重新验收");
  expect(l.count()).toBe(before);
});
