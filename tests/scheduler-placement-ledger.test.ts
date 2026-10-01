/**
 * i28-W5 slot pool on a real ledger, through the scheduler tick and the ledger CLI: a v2 peer (fresh hello, valid grant)
 * takes a review even with local room when it runs fewer orders; an unclaimed order is withdrawn and the round tries the
 * next peer, then local; a claim that beats the withdrawal is kept; offline / expired / revoked / wrong-repo / wrong-family
 * peers never get the order and the round goes local; a card pinned to a peer never gets a local work order.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { Grant } from "../src/lib/lend-wire-v2.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const MIN = 60_000;
const BORROW: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 2 }, { peer: "b", projects: ["p"], roles: ["review"], maxOpen: 2 }];

async function ready(opts: { maxWorkers?: number; borrow?: BorrowEntry[] } = {}) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow = opts.borrow ?? BORROW;
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const policy: { maxActiveWorkers: number; remote: RemotePolicy } = { maxActiveWorkers: opts.maxWorkers ?? 2, remote: REMOTE };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  /** A lender's hello as of now; the scheduler sees it fresh until HELLO_FRESH_MS passes. */
  const hello = (peer: string, grant: Partial<Grant> | null = {}, slots = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }) =>
    recordHello(f.db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: ++seq, slots, paused: null,
      grant: grant && { until: f.tickDeps.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50, ...grant } }, f.tickDeps.now());
  const claim = (peer: string, orderId: string) => cli("owner", "lend-claim", "--", peer, JSON.stringify({ v: 1, orderId, worker: "w1" }));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  return { f, cli, tick, hello, claim, policy, orders: () => listLendOrders(f.db, "T1") };
}

describe("i28-W5 balance on a real ledger", () => {
  test("local has room: a tie goes to the first v2 peer (peers before this machine), and the plan says why", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("挂给 mate 的 codex worker") });
      const plan = listEvents(p.f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "scheduler" && e.data.op === "plan");
      expect(plan?.text).toContain("在跑：mate 0 / b 0 / 本机 0；选最少，平手按 复审回上次的 peer > peer 先于本机 > 借入顺序");
      expect(p.orders()).toMatchObject([{ status: "pooled", peer: "mate", family: "codex" }]);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders()).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("unclaimed on one peer → withdrawn, the round tries the next peer once, then local", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      await p.tick();
      p.f.advance(16 * MIN);
      p.hello("mate");
      p.hello("b");
      expect(await p.tick()).toMatchObject({ step: "pool_timeout" });
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("挂给 b ") });
      p.f.advance(16 * MIN);
      p.hello("mate");
      p.hello("b");
      expect(await p.tick()).toMatchObject({ step: "pool_timeout" });
      expect(await p.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
      expect(p.orders().map((o) => [o.peer, o.status]).sort()).toEqual([["b", "cancelled"], ["mate", "cancelled"]]);
    } finally { p.f.close(); }
  });

  test("a v2 peer that never acks the push: the sweep withdraws it, the intent comes back and the next peer gets the round", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      await p.tick();
      p.f.advance(3 * MIN);
      p.hello("mate");
      p.hello("b");
      expect(await p.cli("owner", "lend-sweep")).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_returned" });
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("挂给 b ") });
      expect(p.orders().filter((o) => o.status === "pooled").map((o) => o.peer)).toEqual(["b"]);
    } finally { p.f.close(); }
  });

  test("a claim that beats the scheduler's timeout keeps its order and nothing is placed twice", async () => {
    const p = await ready();
    try {
      p.policy.remote = { ...REMOTE, poolTimeoutMin: 1 };
      p.hello("mate");
      await p.tick();
      const [o] = p.orders();
      p.f.advance(MIN + 30_000);
      expect(await p.claim("mate", o.orderId)).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_claimed" });
      expect(await p.tick()).toMatchObject({ step: expect.stringMatching(/^pool_/) });
      expect(p.orders()).toHaveLength(1);
      expect(p.f.notices).toEqual([]);
    } finally { p.f.close(); }
  });

  const refused: [string, (p: Awaited<ReturnType<typeof ready>>) => void][] = [
    ["offline (hello too old)", (p) => { p.hello("mate"); p.f.advance(10 * MIN); }],
    ["grant expired", (p) => p.hello("mate", { until: p.f.tickDeps.now() + 1 })],
    ["grant revoked", (p) => p.hello("mate", null)],
    ["grant without this repo", (p) => p.hello("mate", { repos: ["o/other"] })],
    ["grant without review", (p) => p.hello("mate", { roles: ["write"] })],
    ["only a same-family (claude) slot free", (p) => p.hello("mate", {}, { codex: { total: 1, busy: 1 }, claude: { total: 2, busy: 0 } })],
  ];
  for (const [name, setup] of refused) {
    test(`${name}: no order to the peer, the round goes local even with no local worker`, async () => {
      const p = await ready({ maxWorkers: 0, borrow: [BORROW[0]] });
      try {
        setup(p);
        p.f.advance(1);
        expect(await p.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
        expect(p.orders()).toEqual([]);
      } finally { p.f.close(); }
    });
  }
});

describe("pinned card", () => {
  test("a card pinned to a peer never gets a local author session or work order; it waits with the reason", async () => {
    const f = autoFixture();
    try {
      f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate') WHERE id = 'T1'`);
      const r = await f.tick();
      expect(JSON.stringify(r)).toContain("固定放在 peer:mate");
      expect(f.ensured).toEqual([]);
      expect(f.sent).toEqual([]);
      expect(f.intents()).toEqual([]);
    } finally { f.close(); }
  });
});
