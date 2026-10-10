/** POOLRV1 r1: the review ticket's pure parts (src/lib/pool-review-proof-ticket.ts); the signed flow is in lend-tools / pool-review-proof tests. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { issueReviewTicket, logicalSha, parseReviewTicket, REVIEW_TICKET_PURPOSE, ticketProblem } from "../src/lib/pool-review-proof-ticket.js";

const KEY = instanceKeySync(mkdtempSync(join(tmpdir(), "poolrv-ticket-")))!;
const sign = (f: string[]) => signPurpose(REVIEW_TICKET_PURPOSE, f, KEY);
const take = { orderId: "o:1", gen: 3, agent: "agent-lend-1", session: "s-1", at: 10 };
const base = { v: 1 as const, orderId: "o:1", gen: 3, taskId: "T1", head: "a".repeat(40), specRev: 2, round: 1, family: "codex", worker: "agent-lend-1",
  session: "s-1", payloadSha: "b".repeat(64), take };

describe("review ticket", () => {
  test("the logical digest ignores key order and the ticket itself", () => {
    expect(logicalSha({ a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(logicalSha({ b: { c: [1, { e: 3, d: 2 }] }, a: 1, ticket: { x: 1 } }));
    expect(logicalSha({ a: 1 })).not.toBe(logicalSha({ a: 2 }));
  });

  test("issued only when the take fact matches the binding; strict parse round-trips and refuses extra / missing fields", () => {
    for (const bad of [{ ...take, gen: 4 }, { ...take, session: "s-2" }, { ...take, agent: "agent-lend-2" }, { ...take, orderId: "o:2" }]) {
      expect(issueReviewTicket({ ...base, take: bad }, sign)).toBeNull();
    }
    expect(issueReviewTicket(base, () => null)).toBeNull();
    const t = issueReviewTicket(base, sign)!;
    expect(parseReviewTicket(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(parseReviewTicket({ ...t, via: "submit_verdict" })).toBeNull();
    const { sig: _s, ...noSig } = t;
    expect(parseReviewTicket(noSig)).toBeNull();
    expect(parseReviewTicket({ ...t, take: { ...take, extra: 1 } })).toBeNull();
    expect(parseReviewTicket({ ...t, session: "a\nb" })).toBeNull();
    const want = { orderId: "o:1", gen: 3, taskId: "T1", head: "a".repeat(40), specRev: 2, round: 1, family: "codex", worker: "agent-lend-1",
      session: "s-1", payloadSha: "b".repeat(64) };
    expect(ticketProblem(t, want, KEY.publicKey)).toBeNull();
    expect(ticketProblem(t, { ...want, gen: 4 }, KEY.publicKey)).toContain("gen");
    expect(ticketProblem(t, { ...want, family: "claude" }, KEY.publicKey)).toContain("family");
    expect(ticketProblem({ ...t, sig: t.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) }, want, KEY.publicKey)).toBe("票据签名不对");
  });

  test("lend-wire: the ticket is optional and strict; a malformed one refuses the whole request", () => {
    const t = issueReviewTicket(base, sign)!;
    const body = { v: 1, orderId: "o:1", gen: 3, report: "r", session: { id: "s-1", family: "codex" },
      verdict: { v: 1, orderId: "o:1", head: "a".repeat(40), verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" } };
    expect(parseLendRequest("result", body)).toMatchObject({ ok: true, value: { orderId: "o:1" } });
    expect((parseLendRequest("result", body) as { value: object }).value).not.toHaveProperty("ticket");
    expect(parseLendRequest("result", { ...body, ticket: t })).toMatchObject({ ok: true, value: { ticket: t } });
    expect(parseLendRequest("result", { ...body, ticket: { ...t, via: "mcp" } })).toMatchObject({ ok: false, error: expect.stringContaining("ticket") });
    expect(parseLendRequest("result", { ...body, ticket: null })).toMatchObject({ ok: false });
  });
});
