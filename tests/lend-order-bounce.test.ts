/**
 * i28-W9b: a lent fix order after a merge bounce carries the same bounceWork package as the local fix (SHAs cut to 12 so the
 * peer gate passes it), and an ordinary P1 fix order is unchanged: the last report inlined, its findings, "fix each one".
 * End to end through a real merge bounce and the pool: tests/scheduler-write-remote.test.ts "a merge bounce of a remote-written card".
 */
import { describe, expect, test } from "bun:test";
import { peerBounceWork, writeOrderWire, type WriteOrderInput } from "../src/lib/ledger-lend-lease.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { OrderRenderError, redactOrderForPeer } from "../src/lib/order-wire-render.js";
import { bounceWork, type MergeBounce } from "../src/lib/scheduler-merge-conflict.js";

const HEAD = "a".repeat(40), MAIN = "c".repeat(40);
const task = { id: "T9", specRev: 2, round: 3 } as LedgerTask;
const P1 = { findingId: "race-1", family: "concurrency", severity: "P1" as const, probe: "two ticks claim the same intent" };
const fix: WriteOrderInput = { orderId: "lend:T9:s2:r3:a0", step: "fix", head: HEAD, branch: "lend/T9-abcd", base: "main", spec: "规格：只改 x",
  report: "# 审查报告\nP1：两个 tick 抢同一个意图", findings: [P1], repo: "o/r", pr: 7 };
const CONFLICT: MergeBounce = { cause: "conflict", prHead: HEAD, mainHead: MAIN, checks: [] };
const CI: MergeBounce = { cause: "ci_fail", prHead: HEAD, mainHead: null, checks: [{ name: "check", link: "https://github.com/o/r/actions/runs/42" }] };

describe("lent fix order after a merge bounce (i28-W9b)", () => {
  test("an ordinary P1 fix is unchanged: report inlined, findings carried, fix each finding", () => {
    const w = writeOrderWire(task, fix);
    expect(w.inputs.some((s) => s.includes("上一轮审查报告原文") && s.includes("两个 tick 抢同一个意图"))).toBe(true);
    expect(w.findings).toEqual([P1]);
    expect(w.acceptance.at(-1)).toBe("逐条修上一轮审查的问题，自查里写明每条怎么修的");
    expect(writeOrderWire(task, { ...fix, bounce: null })).toEqual(w);
  });

  for (const b of [CONFLICT, CI]) {
    test(`${b.cause}: bounceWork's package replaces the report, the findings and the "fix each" line; the peer gate passes it`, () => {
      const w = writeOrderWire(task, { ...fix, bounce: b });
      const pkg = peerBounceWork(b);
      expect(w.inputs).toEqual(expect.arrayContaining(pkg.inputs));
      expect(w.inputs.join("\n")).not.toContain("上一轮审查报告原文");
      expect(w.findings).toEqual([]);
      expect(w.acceptance.slice(2)).toEqual(pkg.acceptance);
      expect(pkg.acceptance).toEqual(bounceWork(b).acceptance); // one implementation: only the SHAs differ from the local package
      expect(pkg.inputs).toEqual(bounceWork(b).inputs.map((s) => s.replaceAll(HEAD, HEAD.slice(0, 12)).replaceAll(MAIN, MAIN.slice(0, 12))));
      expect(() => redactOrderForPeer(w, HEAD)).not.toThrow();
    });
  }

  test("the uncut local package would be refused by the peer gate (why the SHAs are cut)", () => {
    const w = writeOrderWire(task, { ...fix, bounce: CONFLICT });
    const raw = { ...w, inputs: [...w.inputs, ...bounceWork(CONFLICT).inputs] };
    expect(() => redactOrderForPeer(raw, HEAD)).toThrow(OrderRenderError);
  });

  test("a build order ignores a bounce", () => {
    const build = { ...fix, step: "write" as const, report: null, findings: [] };
    expect(writeOrderWire(task, { ...build, bounce: CONFLICT })).toEqual(writeOrderWire(task, build));
  });
});
