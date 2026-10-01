import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getWorkflow, type AuthorFamily } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { type RemotePolicy } from "../src/lib/scheduler-config.js";
import { orderFamily, remoteWork } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { autoFixture, H1, H2, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15, localPriority: "off" };

/** The daemon reads a query_only connection; every mutation runs through the real manager CLI on the writable one. */
async function setup(writeFamilies?: AuthorFamily[]) {
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  const remote: RemotePolicy = { ...REMOTE, ...(writeFamilies ? { writeFamilies } : {}) };
  const policy = { maxActiveWorkers: 2, remote };
  const borrow: BorrowEntry[] = ["writer", "reviewer"].map((peer) => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 4 }));
  const key = instanceKeySync(join(f.dir, "keys")), spec = join(f.dir, "spec.md");
  writeFileSync(spec, "只修改 src/lib/x.ts；验收测试通过。");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const lend = { borrow: async () => borrow, schedulerPolicy: () => policy, notifyPm: async () => {}, result: {
    sign: (fields: string[]) => signPurpose(RECEIPT_PURPOSE, fields, key), peerFp: async () => "abcd-ef01-2345-6789",
    remoteHead: async (_repo: string, branch: string) => ({ ok: true as const, head: branch === "main" ? H1 : H2 }),
    // Keep the fixture report transferable: the order carries its full head in a separate field.
    reportDir: () => f.dir, writeReport: (path: string, text: string) => writeFileSync(path, text.replace(`head：${H2}`, `head：${H2.slice(0, 12)}`)),
  } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args);
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
  await toBuild(f);
  return { f, reader, remote, borrow, cli, deps, tick, hello, orders, snapshot, call,
    close() { reader.close(); f.close(); } };
}

async function deliverRemote(p: Awaited<ReturnType<typeof setup>>, family: AuthorFamily) {
  expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
  const o = p.orders()[0];
  expect(o.family).toBe(family);
  expect(await p.call("lend-claim", o.peer, { v: 1, orderId: o.orderId, worker: "author" })).toMatchObject({ ok: true });
  const payload = { v: 1, orderId: o.orderId, gen: 1, branch: o.branch, pr: 7, session: { id: "remote-author", family },
    deliver: { v: 1, orderId: o.orderId, head: H2, evidence: o.branch, summary: "已完成修改", selfCheck: "自查通过" } };
  expect(await p.call("lend-write", o.peer, payload)).toMatchObject({ ok: true });
  expect(await p.tick()).toMatchObject({ step: "pool_done" });
  expect(p.f.task().stage).toBe("review");
}

describe("daemon → CLI → actual lend order", () => {
  test.each([undefined, ["claude", "codex"]].map((families) => [families as AuthorFamily[] | undefined]))("preferences survive the pool CLI: %j", async (families) => {
    const p = await setup(families ? [...families] : undefined);
    try {
      p.hello("writer", 2, 2);
      const family = families ? "claude" : "codex";
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining(`的 ${family} worker`) });
      expect(p.orders()).toMatchObject([{ family, step: "write", status: "pooled" }]);
      expect(p.f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
    } finally { p.close(); }
  });
  test("Claude full falls back to Codex through CLI, even with a local Claude author", async () => {
    const p = await setup(["claude", "codex"]);
    try {
      p.hello("writer", 0, 2);
      await deliverRemote(p, "codex");
      expect(getWorkflow(p.f.db, "T1")?.authorFamily).toBe("claude");
      expect(p.snapshot().workflow?.authorFamily).toBe("codex");
      p.hello("reviewer", 1, 0);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders().at(-1)).toMatchObject({ step: "review", peer: "reviewer", family: "claude" });
    } finally { p.close(); }
  });
  test.each(["claude", "codex"] as const)("%s author gets a cross-family review, then a fix in its original family", async (family) => {
    const p = await setup([family]);
    try {
      p.hello("writer", 1, 1);
      await deliverRemote(p, family);
      const cross = family === "claude" ? "codex" : "claude";
      p.remote.writeFamilies = [cross];
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      const review = p.orders().at(-1)!;
      expect(review).toMatchObject({ step: "review", family: cross });
      expect(await p.call("lend-claim", review.peer, { v: 1, orderId: review.orderId, worker: "reviewer" })).toMatchObject({ ok: true });
      const finding = { findingId: "edge-case", family: "logic", severity: "P1", basis: "acceptance:1", probe: "empty input", description: "handle empty input" };
      expect(await p.call("lend-write", review.peer, { v: 1, orderId: review.orderId, gen: 1, report: "P1: handle empty input",
        session: { id: "review-session", family: cross },
        verdict: { v: 1, orderId: review.orderId, head: H2, verdict: "changes", p0: 0, p1: 1, p2: 0, findings: [finding], reportPath: "report.md" },
      })).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_done" });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      p.hello("writer", family === "claude" ? 0 : 2, family === "codex" ? 0 : 2);
      const full = p.snapshot();
      expect(remoteWork(full, Number.MAX_SAFE_INTEGER, "fix")).toHaveProperty("wait");
      expect(orderFamily(full, "writer", "fix")).toBeNull();
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      p.hello("writer", 1, 1);
      const ready = p.snapshot();
      expect(remoteWork(ready, Number.MAX_SAFE_INTEGER, "fix")).toMatchObject({ peer: "writer", reason: expect.stringContaining(`的 ${family} worker`) });
      expect(orderFamily(ready, "writer", "fix")).toBe(family);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders()).toHaveLength(3);
      expect(p.orders().at(-1)).toMatchObject({ step: "fix", status: "pooled", peer: "writer", family, head: H2, branch: p.orders()[0].branch });
      expect(p.orders().at(-1)?.text).toContain("P1: handle empty input");
      expect(p.f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
    } finally { p.close(); }
  });
  test("start_node filters the same write families before pinning a peer", async () => {
    const p = await setup();
    try {
      p.hello("writer", 1, 0);
      const io = { policy: () => ({ remote: p.remote, maxWorkers: 2 }), borrow: async () => p.borrow,
        originRepo: async () => "o/r", now: p.f.tickDeps.now };
      const q = { project: "p", repoDir: p.f.dir, fileGlobs: ["src/lib/y.ts"], want: "auto" as const };
      expect(await startPlacement(p.reader.get()!, io, q)).toMatchObject({ where: "refused" });
      p.remote.writeFamilies = ["claude", "codex"];
      expect(await startPlacement(p.reader.get()!, io, q)).toMatchObject({ where: "peer", peer: "writer" });
    } finally { p.close(); }
  });
});

describe("locally disabled cross-family review waits automatically", () => {
  for (const mode of ["balance", "overflow"] as const) {
    test.each(["claude", "codex"] as const)(`${mode}: %s author can use a legacy peer only for Codex review`, async (family) => {
      const p = await setup([family]);
      try {
        p.hello("writer", 1, 1);
        await deliverRemote(p, family);
        p.remote.mode = mode;
        p.remote.roles = ["review"];
        delete p.remote.repo;
        if (mode === "overflow") p.remote.reviewFirst = ["old"];
        p.borrow.splice(0, p.borrow.length, { peer: "old", projects: ["p"], roles: ["review"], maxOpen: 1 });
        expect(p.snapshot().pool?.peers).toMatchObject([{ peer: "old", open: 0, maxOpen: 1, v2: null }]);
        if (family === "claude") {
          expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: "peer:old" });
          expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
          expect(p.orders().at(-1)).toMatchObject({ peer: "old", family: "codex", step: "review" });
          expect(p.f.notices).toEqual([]);
          expect(p.f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
          return;
        }
        expect(planScheduler(p.snapshot())).toMatchObject({ kind: "wait", code: "placement" });
        expect(await p.tick()).toMatchObject({ step: "waiting" });
        p.reader.close();
        await p.tick();
        await p.tick();
        expect(p.orders()).toHaveLength(1);
        expect(p.f.notices).toHaveLength(1);
        expect(p.f.notices[0]).toContain("跨家族 peer");
        expect(getWorkflow(p.f.db, "T1")?.mode).toBe("auto");
        expect(p.f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
        p.hello("old", 0, 1);
        expect(await p.tick()).toMatchObject({ step: "waiting" });
        expect(p.f.notices).toHaveLength(1);
        p.hello("old", 1, 0);
        expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
        expect(p.orders().at(-1)).toMatchObject({ peer: "old", family: "claude", step: "review" });
      } finally { p.close(); }
    });
  }
  test("scheduler may record this notice, while commands outside the service allowlist remain forbidden", async () => {
    const p = await setup();
    try {
      p.hello("writer", 0, 1);
      await deliverRemote(p, "codex");
      const args = ["scheduler-family-wait", "T1", "--rev", String(p.f.task().rev), "--phase", "pending", "--text", "等待跨家族 peer"];
      expect(await p.cli("scheduler", ...args)).toMatchObject({ ok: true });
      expect(await p.cli("scheduler", ...args)).toMatchObject({ ok: true, duplicate: true });
      expect(await p.cli("scheduler", "task-set", "T1", "--title", "should not change"))
        .toMatchObject({ ok: false, code: "forbidden", error: "调度服务身份只能运行调度专用命令" });
      expect(p.f.task().title).toBe("auto");
    } finally { p.close(); }
  });
  test("wait + inform once, including after reopening the read-only scheduler connection; resumes on a Claude slot", async () => {
    const p = await setup();
    try {
      p.hello("writer", 0, 2);
      await deliverRemote(p, "codex");
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(p.f.notices).toHaveLength(1);
      expect(p.f.notices[0]).toContain("跨家族 peer");
      p.reader.close();
      await p.tick();
      await p.tick();
      expect(p.f.notices).toHaveLength(1);
      expect(getWorkflow(p.f.db, "T1")?.mode).toBe("auto");
      expect(p.f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
      const notes = listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "family_wait_sent");
      expect(notes).toHaveLength(1);
      p.hello("reviewer", 1, 0);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.orders().at(-1)).toMatchObject({ peer: "reviewer", family: "claude", step: "review" });
    } finally { p.close(); }
  });
  test("failed notification retries; an ordinary caller cannot create the sent marker", async () => {
    const p = await setup();
    try {
      p.hello("writer", 0, 2);
      await deliverRemote(p, "codex");
      const notify = p.deps.notifyPm;
      p.deps.notifyPm = async () => { throw new Error("temporary bridge failure"); };
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(p.f.notices).toEqual([]);
      expect(await p.cli("agent-task-one", "scheduler-family-wait", "T1", "--rev", String(p.f.task().rev), "--phase", "sent", "--text", "fake"))
        .toMatchObject({ ok: false, code: "forbidden" });
      p.reader.close();
      p.deps.notifyPm = notify;
      await p.tick(); await p.tick();
      expect(p.f.notices).toHaveLength(1);
    } finally { p.close(); }
  });
});
