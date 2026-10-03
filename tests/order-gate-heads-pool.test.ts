/**
 * i28-GATE2 on a real ledger through the scheduler's pool path (same fixture as tests/scheduler-pool.test.ts): a pool order the
 * peer gate refuses leaves one alarm event per card + reason, and a lent review whose previous finding id is aliased gets the
 * original id back on the ledger when peer A answers with the alias.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const SENSITIVE = "credential-store.internal";

async function pooled(specText: string) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, specText);
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const policy = { maxActiveWorkers: 0, remote: REMOTE };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const claim = (orderId: string) => peer("claim", { v: 1, orderId, worker: "w1" });
  const verdict = (orderId: string, h: string, findings: object[] = []) => peer("write", {
    v: 1, orderId, gen: 1, report: "## 结论", session: { id: "sess-1", family: "codex" },
    verdict: { v: 1, orderId, head: h, verdict: findings.length ? "changes" : "pass", p0: 0, p1: findings.length, p2: 0, findings, reportPath: "r.md" },
  });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  return { f, tick, claim, verdict, policy, orders: () => listLendOrders(f.db, "T1") };
}

const alarms = (p: Awaited<ReturnType<typeof pooled>>) => listEvents(p.f.db, { target: "T1" }).filter((e) => e.data.op === "gate_refused");

describe("i28-GATE2 on the pool path", () => {
  test("gate refusal → one alarm event saying what the card waits for; the same refusal again adds no second alarm (acceptance 3)", async () => {
    const p = await pooled(`规格：只改 src/lib/x.ts\n别处粘来的 ${randomBytes(32).toString("hex")}`);
    try {
      const first = await p.tick();
      expect(first.detail).toContain("外发闸");
      expect(p.orders()).toEqual([]);
      expect(alarms(p)).toHaveLength(1);
      expect(alarms(p)[0]).toMatchObject({ kind: "scheduler", actor: "scheduler", text: expect.stringContaining("长十六进制"),
        data: { waiting: expect.stringContaining("等本机执行者接手") } });
      for (let i = 0; i < 4; i++) await p.tick();
      expect(alarms(p)).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("a sensitive previous finding id goes to the re-review as an alias; the peer answers with it → the ledger records the original (acceptance 4b)", async () => {
    const p = await pooled("规格：只改 src/lib/x.ts\n验收：单测全绿");
    try {
      await p.tick();
      const [r1] = p.orders();
      await p.claim(r1!.orderId);
      expect(await p.verdict(r1!.orderId, H1, [{ ...P1, description: "d" }])).toMatchObject({ ok: true });
      // The previous round's id as a local reviewer would have named it (a peer could not send this id itself).
      const peerReview = listEvents(p.f.db, { target: "T1" }).filter((e) => e.kind === "review").at(-1)!;
      insertEvent(p.f.db, { actor: "agent-pm", now: Date.now() }, { project: "p", target: "T1", kind: "review", text: "本机复核",
        data: { ...peerReview.data, findings: [{ ...P1, findingId: SENSITIVE }] } }, true);
      await p.tick();
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      p.policy.maxActiveWorkers = 1;
      expect(await p.tick()).toMatchObject({ step: "sent" });
      await p.f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
      p.policy.maxActiveWorkers = 5;
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      const r2 = p.orders()[1]!;
      expect(r2.wire.findings.map((f) => f.findingId)).toEqual(["F1"]);
      expect(r2.text).not.toContain(SENSITIVE);
      await p.claim(r2.orderId);
      expect(await p.verdict(r2.orderId, H2, [{ ...P1, findingId: "F1", description: "仍未修" }])).toMatchObject({ ok: true });
      const review = listEvents(p.f.db, { target: "T1" }).filter((e) => e.kind === "review").at(-1)!;
      expect((review.data.findings as { findingId: string }[]).map((f) => f.findingId)).toEqual([SENSITIVE]);
    } finally { p.f.close(); }
  });
});
