/**
 * dispatch-recovery-MODEL after a lender wrote the head: the workflow still says Claude authored the card, the head is
 * Codex's (done remote write order), and the real tick binds a Claude reviewer. When that reviewer fails, recovery must
 * stay cross-model against the actual author — never a Codex reviewer for a Codex-written head.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { recordModelOutcome, type RecoveryPolicyPort } from "../src/lib/scheduler-model-outcome.js";
import { autoFixture, H2, toBuild } from "./scheduler-auto-helpers.js";

const BRANCH = "lend/T1-abcd";
const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null });

describe("dispatch-recovery-MODEL reviewer recovery after a remote write (real tick)", () => {
  test("Codex lender wrote the head: the failed Claude reviewer goes to an authorized Claude, never the Codex listed first", async () => {
    const f = autoFixture({ reviewerRuntime: "claude-code" });
    try {
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      delete reg.agents["agent-rv-t1"].transport;
      writeFileSync(f.registryPath, JSON.stringify(reg));
      const spec = join(f.dir, "T1.md");
      writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
      f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
      const reports = join(f.dir, "reports");
      mkdirSync(reports);
      const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
      const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
      const policy = { maxActiveWorkers: 2, remote: { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" } as RemotePolicy };
      const remote: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
      const lend = {
        borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
        result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
          peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async (_repo: string, branch: string) => remote[branch] ?? { ok: false as const, error: "没有这个分支" } },
      };
      const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
      const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
      const tick = async () => {
        const r = await schedulerAutoTick(f.db, { p: policy }, deps);
        if (r.failed.length) throw new Error(JSON.stringify(r.failed));
        return r.cards[0];
      };
      let seq = 0;
      const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, paused: null,
        slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
        grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
      const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
      await toBuild(f);

      hello();
      expect(await tick()).toMatchObject({ step: "pool_pooled" });
      const [order] = listLendOrders(f.db, "T1");
      expect(await lendCall("lend-claim", { v: 1, orderId: order.orderId, worker: "w1" })).toMatchObject({ ok: true });
      remote[BRANCH] = { ok: true, head: H2 };
      expect(await lendCall("lend-write", { v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-1", family: "codex" },
        deliver: { v: 1, orderId: order.orderId, head: H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
      expect(await tick()).toMatchObject({ step: "pool_done" });
      hello();
      await tick(); // reviewer session: Claude, across from the lender's Codex
      expect(f.ensured.at(-1)).toEqual({ role: "reviewer", family: "claude" });
      await tick(); // review order
      const review = f.intents().findLast((i) => i.action === "review")!;
      expect(review).toMatchObject({ recipient: "agent-rv-t1" });
      expect(getWorkflow(f.db, "T1")?.authorFamily).toBe("claude");
      expect(remoteHeadFamily(f.db, f.task())).toBe("codex");

      const failed = { agent: "agent-rv-t1", family: "claude" as const, machine: "local" };
      const signal = { failure: { kind: "error" as const, message: "ECONNRESET" } };
      const r = recordModelOutcome(f.db, f.at("scheduler"), { intentId: review.id, signal, failed, ended: true,
        authorized: [{ family: "codex", machine: "backup" }, { family: "claude", machine: "backup" }] }, on);
      expect(r).toMatchObject({ kind: "recorded", cls: "host", plan: { kind: "redispatch", to: { family: "claude", machine: "backup" } } });

      // Only Codex left to place on: no cross-model place against the Codex head, so manual, not a same-family review.
      const g = recordModelOutcome(f.db, f.at("scheduler"), { intentId: review.id, signal, failed, ended: true,
        authorized: [{ family: "codex", machine: "backup" }] }, () => ({ mode: "observe", manualAfterMs: null }));
      expect(g).toMatchObject({ mode: "observe", plan: { kind: "manual", code: "model_recovery_manual" } });
    } finally { f.close(); }
  });
});
