/**
 * POOLRV1 shared fixture: a real lending side B — its journal, lend-tools take_review / submit_verdict under a verified identity,
 * a synthetic instance key in a temp dir — answering A's real lend CLI. A's result deps keep the received text under a temp dir and
 * return B's key as the pin. Nothing reads this machine's keys or state.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { saveRawResult } from "../src/lib/pool-review-proof-raw.js";
import { REVIEW_TICKET_PURPOSE } from "../src/lib/pool-review-proof-ticket.js";

export const B_WORKER = "agent-lend-0123456789";

/** A's lend result deps: reports, receipt key, raw archive dir and the pin (B's key, pinned long before any claim). */
export function aResultDeps(dir: string, pinned: { publicKey: string; pinnedAt: string } | null) {
  const reports = join(dir, "reports");
  mkdirSync(reports, { recursive: true });
  const key = instanceKeySync(mkdtempSync(join(dir, "a-key-")));
  const rawDir = join(dir, "lend-raw");
  return {
    rawDir,
    result: {
      reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      saveRaw: (text: string) => saveRawResult(rawDir, text), pinnedKey: async () => pinned,
    },
  };
}

type Claimed = { order: Record<string, unknown>; text: string; lease: { gen: number } };
type Send = (body: Record<string, unknown>) => Promise<Record<string, any>>;

/** B: one journal and key; answer() runs an A claim response through take_review (unless skipped) and submit_verdict (caller family codex unless overridden), sending to A via `send`. */
export function lendSide(dir: string, aName = "home") {
  const key = instanceKeySync(mkdtempSync(join(dir, "b-key-")))!;
  const db = openLendJournal(":memory:");
  const pinned = { publicKey: key.publicKey, pinnedAt: new Date(0).toISOString() };
  type AnswerOpts = { take?: boolean; takeFamily?: string | null; submitFamily?: string | null };
  async function answer(claim: Claimed, verdict: { verdict: string; findings?: object[]; report?: string }, send: Send, o: AnswerOpts = {}) {
    const orderId = String(claim.order.orderId);
    const work = mkdtempSync(join(dir, "b-work-"));
    writeFileSync(join(work, "report.md"), verdict.report ?? "## 结论");
    recordAsked(db, { orderId, peer: aName, fp: null, family: "codex", preview: {} }, 1);
    advance(db, orderId, "asked", "claimed", { wire: { order: claim.order, text: claim.text }, leaseGen: claim.lease.gen }, 1);
    advance(db, orderId, "claimed", "cloned", { dir: work }, 1);
    advance(db, orderId, "cloned", "started", { agent: B_WORKER, sessionId: "b-sess-1" }, 1);
    const who = (family: string | null | undefined) =>
      ({ agent: B_WORKER, sessionId: "b-sess-1", family: family === undefined ? "codex" : family, verified: true });
    const sent: Record<string, unknown>[] = [];
    const deps = {
      db, log: () => {}, now: () => 2, signTicket: (f: string[]) => signPurpose(REVIEW_TICKET_PURPOSE, f, key),
      call: async (_peer: string, _op: string, body: Record<string, unknown>) => {
        sent.push(body);
        const r = await send(body);
        return { status: r.ok ? 200 : 400, body: r };
      },
    };
    if (o.take !== false) await routeLendTool("take_review", who(o.takeFamily), {}, deps as never);
    const findings = verdict.findings ?? [];
    const count = (s: string) => findings.filter((f) => (f as { severity: string }).severity === s).length;
    const r = await routeLendTool("submit_verdict", who(o.submitFamily), { v: 1, orderId, head: claim.order.head, verdict: verdict.verdict, p0: count("P0"), p1: count("P1"),
      p2: count("P2"), findings, reportPath: "report.md" }, deps as never);
    return { r, sent };
  }
  return { key, db, pinned, answer };
}
