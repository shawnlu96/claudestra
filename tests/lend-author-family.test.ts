/**
 * FAMW on a real temp ledger: the provider's claim of a lent write / fix order reconciles workflow.authorFamily to the order's
 * family in the claim's own transaction, through the real pool tick, the lend CLI and the production planner. Review claims,
 * stale / repeated claims, same-family orders and non-auto workflows change nothing; a failed reconcile rolls the claim back.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { claimLend, getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getWorkflow, type AuthorFamily } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { AUTHOR_FAMILY_OP, claimAuthorFamily, swapAuthorFamily } from "../src/lib/lend-author-family.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { orderFamily } from "../src/lib/scheduler-placement-plan.js";
import { autoFixture, H1, H2, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15, localPriority: "off" };

async function setup(opts: { writeFamilies?: AuthorFamily[]; workflowFamily?: AuthorFamily } = {}) {
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  const remote: RemotePolicy = { ...REMOTE, ...(opts.writeFamilies ? { writeFamilies: opts.writeFamilies } : {}) };
  const policy = { maxActiveWorkers: 2, remote };
  const borrow: BorrowEntry[] = ["writer", "reviewer"].map((peer) => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 4 }));
  const key = instanceKeySync(join(f.dir, "keys")), spec = join(f.dir, "spec.md");
  writeFileSync(spec, "只修改 src/lib/x.ts；验收测试通过。");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  // Synthetic: a card whose current author is a local Codex session (setWorkflow only takes spec cards).
  if (opts.workflowFamily === "codex") {
    const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
    reg.agents["agent-task-one"] = { ...reg.agents["agent-task-one"], runtime: "codex", transport: "acp" };
    writeFileSync(f.registryPath, JSON.stringify(reg));
    f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
  }
  const lend = { borrow: async () => borrow, schedulerPolicy: () => policy, notifyPm: async () => {}, result: {
    sign: (fields: string[]) => signPurpose(RECEIPT_PURPOSE, fields, key), peerFp: async () => "abcd-ef01-2345-6789",
    remoteHead: async (_repo: string, branch: string) => ({ ok: true as const, head: branch === "main" ? H1 : H2 }),
    reportDir: () => f.dir, writeReport: (path: string, text: string) => writeFileSync(path, text.replace(`head：${H2}`, `head：${H2.slice(0, 12)}`)),
  } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, borrow: async () => borrow, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)) };
  const tick = async () => {
    const result = await schedulerAutoTick(reader.get()!, { p: policy }, deps);
    expect(result.failed).toEqual([]);
    return result.cards[0];
  };
  let seq = 0;
  const hello = (peer: string, claude: number, codex: number) => recordHello(f.db, peer, null, {
    proto: 2, v: 1, boot: peer, seq: ++seq, paused: null,
    slots: { claude: { total: claude, busy: 0 }, codex: { total: codex, busy: 0 } },
    grant: { until: f.tickDeps.now() + 60_000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 },
  }, f.tickDeps.now());
  const orders = () => listLendOrders(f.db, "T1");
  const snapshot = () => autoSnapshot(reader.get()!, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: { remote, borrow } });
  const call = (op: string, peer: string, body: object) => cli("owner", op, "--", peer, JSON.stringify(body));
  const notes = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === AUTHOR_FAMILY_OP);
  const workflow = () => getWorkflow(f.db, "T1")!;
  const borrowOf = (peer: string) => borrow.find((b) => b.peer === peer) ?? null;
  await toBuild(f);
  return { f, reader, remote, borrow, borrowOf, cli, tick, hello, orders, snapshot, call, notes, workflow,
    close() { reader.close(); f.close(); } };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Pool the build order to `writer` (only `family` slots) and return it, still unclaimed. */
async function pooledWrite(p: Setup, family: AuthorFamily) {
  p.hello("writer", family === "claude" ? 1 : 0, family === "codex" ? 1 : 0);
  expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
  const o = p.orders()[0]!;
  expect(o).toMatchObject({ step: "write", peer: "writer", family, status: "pooled" });
  return o;
}

async function deliver(p: Setup, o: { orderId: string; branch: string | null }, family: AuthorFamily) {
  expect(await p.call("lend-write", "writer", { v: 1, orderId: o.orderId, gen: 1, branch: o.branch, pr: 7, session: { id: "remote-author", family },
    deliver: { v: 1, orderId: o.orderId, head: H2, evidence: o.branch, summary: "已完成修改", selfCheck: "自查通过" } })).toMatchObject({ ok: true });
  expect(await p.tick()).toMatchObject({ step: "pool_done" });
  expect(p.f.task().stage).toBe("review");
}

describe("a write claim makes the order's family the card's author family", () => {
  for (const [from, to] of [["claude", "codex"], ["codex", "claude"]] as const) {
    test(`${from} card, pool picks a ${to} writer: claim and family land together; the review goes across from ${to}`, async () => {
      const p = await setup({ writeFamilies: [to], workflowFamily: from });
      try {
        const o = await pooledWrite(p, to);
        const before = p.workflow();
        expect(before.authorFamily).toBe(from);
        expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
        expect(p.workflow()).toMatchObject({ authorFamily: to, rev: before.rev + 1, mode: "auto" });
        const [note] = p.notes();
        expect(p.notes()).toHaveLength(1);
        expect(note!.data).toMatchObject({ orderId: o.orderId, peer: "writer", step: "write", family: to, previousFamily: from, workflowRev: before.rev + 1 });
        expect(note!.dedupKey).toBe(`lend-author-family:${o.orderId}`);
        // Same transaction: the claim event and the family note sit next to each other.
        const claim = listEvents(p.f.db, { project: "p", target: "T1" }).findLast((e) => (e.data.lend as { op?: string } | undefined)?.op === "claim")!;
        expect(Math.abs(claim.seq - note!.seq)).toBeLessThanOrEqual(2);

        await deliver(p, o, to);
        expect(remoteHeadFamily(p.f.db, p.f.task())).toBe(to);
        expect(p.snapshot().workflow?.authorFamily).toBe(to);
        p.hello("reviewer", from === "claude" ? 1 : 0, from === "codex" ? 1 : 0);
        expect(orderFamily(p.snapshot(), "reviewer", "review")).toBe(from);
        expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
        const review = p.orders().at(-1)!;
        expect(review).toMatchObject({ step: "review", peer: "reviewer", family: from });
        // The review claim is an ordinary review order: the author family stays the writer's.
        expect(await p.call("lend-claim", "reviewer", { v: 1, orderId: review.orderId, worker: "rv" })).toMatchObject({ ok: true });
        expect(p.workflow().authorFamily).toBe(to);
        expect(p.notes()).toHaveLength(1);
      } finally { p.close(); }
    });
  }

  test("same family: no write, no note, workflow rev unchanged", async () => {
    const p = await setup({ writeFamilies: ["claude"] });
    try {
      const o = await pooledWrite(p, "claude");
      const before = p.workflow();
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
      expect(p.workflow()).toEqual(before);
      expect(p.notes()).toEqual([]);
    } finally { p.close(); }
  });

  test("a repeated claim and a second process see the claimed order: one change, one note", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    const other = new Database(join(p.f.dir, "ledger.sqlite"));
    try {
      other.run("PRAGMA busy_timeout = 5000");
      const o = await pooledWrite(p, "codex");
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
      const after = p.workflow();
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
      const again = claimLend(other, { actor: "owner", now: p.f.tickDeps.now() }, "writer", { v: 1, orderId: o.orderId, worker: "w1" }, p.borrowOf);
      expect(again).toMatchObject({ order: expect.anything() });
      expect(p.workflow()).toEqual(after);
      expect(p.notes()).toHaveLength(1);
    } finally { other.close(); p.close(); }
  });

  test("a stale claim (card moved) is cancelled and leaves the family alone", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      p.f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'"); // synthetic: the spec moved on under the pooled order
      const before = p.workflow();
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: false, current: { lend: "cancelled" } });
      expect(getLendOrder(p.f.db, o.orderId)!.status).toBe("cancelled");
      expect(p.workflow()).toEqual(before);
      expect(p.notes()).toEqual([]);
      // A late claim on the cancelled order is refused and changes nothing either.
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: false });
      expect(p.workflow()).toEqual(before);
    } finally { p.close(); }
  });

  for (const mode of ["manual", "observe"] as const) {
    test(`a ${mode} workflow: the claim goes through, the family is not touched`, async () => {
      const p = await setup({ writeFamilies: ["codex"] });
      try {
        const o = await pooledWrite(p, "codex");
        p.f.db.run("UPDATE task_workflows SET mode = ? WHERE taskId = 'T1'", [mode]);
        const before = p.workflow();
        expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
        expect(getLendOrder(p.f.db, o.orderId)!.status).toBe("claimed");
        expect(p.workflow()).toEqual(before);
        expect(p.notes()).toEqual([]);
      } finally { p.close(); }
    });
  }
});

describe("a failed reconcile rolls the claim back: never claimed with the old family", () => {
  const refusedClaim = async (p: Setup, orderId: string) => {
    const before = p.workflow();
    const claims = () => listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => (e.data.lend as { op?: string } | undefined)?.op === "claim").length;
    const n = claims();
    expect(await p.call("lend-claim", "writer", { v: 1, orderId, worker: "w1" })).toMatchObject({ ok: false });
    expect(getLendOrder(p.f.db, orderId)).toMatchObject({ status: "pooled", worker: null, leaseGen: 0 });
    expect(p.workflow()).toEqual(before);
    expect(claims()).toBe(n);
    expect(p.f.db.query("SELECT executor FROM task_steps WHERE taskId = 'T1' AND executorKind = 'peer'").all()).toEqual([]);
  };

  test("the workflow write fails inside the transaction (CAS / storage)", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      p.f.db.run("CREATE TRIGGER famw_fail BEFORE UPDATE OF authorFamily ON task_workflows BEGIN SELECT RAISE(ABORT, 'famw: write failed'); END");
      await refusedClaim(p, o.orderId);
      p.f.db.run("DROP TRIGGER famw_fail");
      // Once storage is healthy the same order claims normally, exactly once.
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
      expect(p.workflow().authorFamily).toBe("codex");
      expect(p.notes()).toHaveLength(1);
    } finally { p.close(); }
  });

  test("this order was already reconciled (dedup present): refused, nothing written twice", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      appendEvent(p.f.db, { actor: "owner", dedupKey: `lend-author-family:${o.orderId}` }, { project: "p", target: "T1", kind: "note", text: "synthetic" });
      expect(p.f.db.query("SELECT 1 FROM events WHERE dedupKey = ?").get(`lend-author-family:${o.orderId}`)).toBeTruthy();
      await refusedClaim(p, o.orderId);
    } finally { p.close(); }
  });

  test("the workflow's family cannot be read: refused", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      p.f.db.run("PRAGMA ignore_check_constraints = ON");
      p.f.db.run("UPDATE task_workflows SET authorFamily = 'gpt' WHERE taskId = 'T1'");
      await refusedClaim(p, o.orderId);
    } finally { p.close(); }
  });

  test("a scheduler-cut order whose workflow row is gone: family unreadable, refused (no claim, no step, no note)", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      p.f.db.run("DELETE FROM task_workflows WHERE taskId = 'T1'");
      await refusedClaim(p, o.orderId);
      expect(p.notes()).toEqual([]);
    } finally { p.close(); }
  });

  test("a card the scheduler drove keeps refusing even if the order was not cut by the scheduler", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      p.f.db.run("DELETE FROM task_workflows WHERE taskId = 'T1'");
      const order = { ...getLendOrder(p.f.db, o.orderId)!, createdBy: "owner" };
      expect(() => claimAuthorFamily(p.f.db, { actor: "owner" }, order)).toThrow(/流程记录读不到/);
    } finally { p.close(); }
  });
});

describe("a legacy manual card that never had a workflow keeps claiming as before", () => {
  test("no workflow, not scheduler-cut, no scheduler events: no-op", () => {
    const f = autoFixture();
    try {
      f.db.run("DELETE FROM task_workflows WHERE taskId = 'T1'");
      const scheduler = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "scheduler" && e.actor === "scheduler");
      expect(scheduler).toEqual([]);
      const order = { orderId: "lend:T1:s1:r0:a0", taskId: "T1", project: "p", peer: "writer", family: "codex", step: "write", round: 0, specRev: 1, createdBy: "owner" };
      expect(() => claimAuthorFamily(f.db, { actor: "owner" }, order)).not.toThrow();
      expect(getWorkflow(f.db, "T1")).toBeNull();
      expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === AUTHOR_FAMILY_OP)).toEqual([]);
    } finally { f.close(); }
  });
});

describe("swapAuthorFamily: the FAM1a epoch must still name the real author", () => {
  const swap = (toFamily: unknown) => ({ seq: 1, kind: "scheduler", data: { op: "reviewer_swap", toFamily } }) as unknown as LedgerEvent;
  test("current family matches the epoch → that family; a later change makes the epoch stale; unreadable is refused", async () => {
    const p = await setup();
    try {
      const task = p.f.task();
      expect(swapAuthorFamily(p.f.db, task, p.workflow(), swap("claude"))).toBe("claude");
      expect(() => swapAuthorFamily(p.f.db, task, p.workflow(), swap("codex"))).toThrow(/旧 epoch 作废/);
      expect(() => swapAuthorFamily(p.f.db, task, null, swap("claude"))).toThrow(/读不到/);
      expect(swapAuthorFamily(p.f.db, task, { ...p.workflow(), authorFamily: "codex" }, swap(undefined))).toBe("codex");
    } finally { p.close(); }
  });

  test("after a Codex claim and delivery the remote head and the stored family agree with the epoch", async () => {
    const p = await setup({ writeFamilies: ["codex"] });
    try {
      const o = await pooledWrite(p, "codex");
      expect(await p.call("lend-claim", "writer", { v: 1, orderId: o.orderId, worker: "w1" })).toMatchObject({ ok: true });
      await deliver(p, o, "codex");
      expect(swapAuthorFamily(p.f.db, p.f.task(), p.workflow(), swap("codex"))).toBe("codex");
      expect(() => swapAuthorFamily(p.f.db, p.f.task(), p.workflow(), swap("claude"))).toThrow(/旧 epoch 作废/);
    } finally { p.close(); }
  });
});
