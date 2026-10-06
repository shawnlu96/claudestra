/**
 * followup-reliability-ASKT 扩围的三条正规结清路径与并发：仲裁 receipt（terminal=true 才收尾，取消确认 terminal=false 不碰提问）、
 * CONV3 换家族撤旧写单（cancelled）、借入方接管（done）；以及结清事务持锁时另一进程开新问——等锁之后被拒，不留 open 行。
 * 全部跑临时文件 SQLite；仲裁 / 收回沿用 fix-strategy 夹具，接管沿用 lend-pr-takeover 的假 gh。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { arbitrationFixture, peerAuthor, remoteProbe, resultDeps, runningOrder, verdictRequest } from "./fix-strategy-remote-helpers.js";
import { getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { claimLend, getLendOrder } from "../src/lib/ledger-lend.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE, writeLendResult } from "../src/lib/ledger-lend-result.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { lendTakeoverStep, type GhAnswer, type TakeoverGh } from "../src/lib/lend-pr-takeover.js";
import type { ResultRequest } from "../src/lib/lend-wire.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { runLedger } from "../src/manager/ledger.js";
import { takeoverDeps } from "../src/manager/ledger-lend-takeover-cmds.js";
import { testChildEnv } from "./test-env.js";

/** 远端 worker 经 lend/ask 开的提问的样子（order-ask.ts openOrderAsk 记的字段） */
const workerAskRow = (db: Database, o: { project: string; taskId: string; orderId: string }, from: string, title = "x") =>
  openAsk(db, { project: o.project, taskId: o.taskId, fromAgent: from, source: "reply", kind: "decide", title, extra: { via: "mcp_ask", orderId: o.orderId } }).id;
const cancels = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'ask_cancel'").get() as { n: number }).n;

describe("仲裁结论（lend-arbiter-result）", () => {
  test("terminal=true 的正式 done 关这一单仲裁 worker 的提问；同一结论重发回原回执、不再关", async () => {
    const { f, p, intent } = await arbitrationFixture();
    try {
      await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
      const o = remoteOrder(f.db, intent.id)!;
      claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
      const mine = workerAskRow(f.db, o, "new-arbiter@Peer");
      const other = workerAskRow(f.db, o, "new-arbiter@Stranger");
      const req = verdictRequest(remoteOrder(f.db, intent.id)!);
      const first = writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps);
      expect(getLendOrder(f.db, o.orderId)!.status).toBe("done");
      expect(getAsk(f.db, mine)).toMatchObject({ state: "cancelled", extra: expect.objectContaining({ settledOrder: { orderId: o.orderId, status: "done", by: "lend", at: expect.any(Number) } }) });
      expect(getAsk(f.db, other)!.state).toBe("open");
      const n = cancels(f.db);
      expect(writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps)).toEqual(first);
      expect(cancels(f.db)).toBe(n);
    } finally { f.close(); }
  });

  test("签不出回执：整笔不入账，提问仍开", async () => {
    const { f, p, intent } = await arbitrationFixture();
    try {
      await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
      const o = remoteOrder(f.db, intent.id)!;
      claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
      const mine = workerAskRow(f.db, o, "new-arbiter@Peer");
      expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", verdictRequest(remoteOrder(f.db, intent.id)!), "same", { ...resultDeps, sign: () => null })).toThrow();
      expect(getLendOrder(f.db, o.orderId)!.status).toBe("claimed");
      expect(getAsk(f.db, mine)!.state).toBe("open");
    } finally { f.close(); }
  });
});

describe("CONV3 换家族撤旧写单（lend-reclaim-scheduler）", () => {
  test("撤成 cancelled 的同一事务关旧 worker 的提问；之后的取消确认（terminal=false）不改成 done、不再碰提问", async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
      const o = { project: "p", taskId: "T1", orderId: "old-running" };
      const mine = workerAskRow(f.db, o, "old-worker@Peer");
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
      expect(getLendOrder(f.db, "old-running")!.status).toBe("cancelled");
      expect(getAsk(f.db, mine)!.extra.settledOrder).toEqual({ orderId: "old-running", status: "cancelled", by: "lend", at: expect.any(Number) });
      const legacy = workerAskRow(f.db, o, "old-worker@Peer", "修复前漏关的一条"); // 只为验证取消确认那条路径不收尾
      const n = cancels(f.db);
      const req: ResultRequest = { v: 1, orderId: "old-running", gen: 1, cancelAck: { clean: true }, report: "exited without publication",
        session: { id: "old-peer-session", family: "claude" }, verdict: { v: 1, orderId: "old-running", head: f.task().headSHA!,
          verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" } };
      writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "clean", resultDeps);
      expect(getLendOrder(f.db, "old-running")!.status).toBe("cancelled");
      expect(getAsk(f.db, legacy)!.state).toBe("open");
      expect(cancels(f.db)).toBe(n);
    } finally { f.close(); }
  });
});

describe("借入方接管（lend-pr-takeover-ledger）", () => {
  test("接管记交付、单子 done 的同一事务关 worker 的提问", async () => {
    const P = "claude-orchestrator", REPO = "shawnlu96/claudestra", BR = "lend/T9-abcd", MIN = 60_000;
    const dir = mkdtempSync(join(tmpdir(), "lend-askt-takeover-")), path = join(dir, "ledger.sqlite");
    const key = instanceKeySync(dir);
    const db = openLedger(path);
    let now = 1_000_000;
    const remote: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
    const remoteHead = async (_r: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" };
    const prevMake = takeoverDeps.make;
    takeoverDeps.make = () => ({ remoteHead });
    try {
      const deps = (actor: string) => ({
        db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
        lend: { borrow: async () => [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }], notifyPm: async () => {},
          result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (fs: string[]) => signPurpose(RECEIPT_PURPOSE, fs, key),
            remoteHead, peerFp: async (peer: string) => (peer === "mate" ? "abcd-ef01-2345-6789" : null) } },
      });
      const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor) as never) as Promise<Record<string, any>>;
      setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
      writeFileSync(join(dir, "T9.md"), "规格：只改 src/lib/x.ts");
      createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec: join(dir, "T9.md"), agent: "agent-dev" } as never);
      db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
      const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
      expect(await run(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId, worker: "agent-lend-0123456789" })], "owner")).toMatchObject({ ok: true });
      const mine = workerAskRow(db, { project: P, taskId: "T9", orderId }, "agent-lend-0123456789@mate");
      remote[BR] = { ok: true, head: "c".repeat(40) };
      const beatOrder = { orderId, gen: 1, phase: "publishing", lastActivityAt: 0, excerpt: "HTTP 502", ended: null };
      const beat = () => beatLend(db, { actor: "owner", now }, "mate", { v: 1, orders: [beatOrder] } as never, new Map());
      for (let i = 0; i < 3; i++) { beat(); now += 3 * MIN; }
      const gh: TakeoverGh = { head: remoteHead, compare: async (): Promise<GhAnswer<string>> => ({ ok: true, value: "ahead" }),
        openPr: async (): Promise<GhAnswer<number | null>> => ({ ok: true, value: null }), createPr: async (): Promise<GhAnswer<number>> => ({ ok: true, value: 377 }) };
      const seen = new Map<string, string>();
      const step = () => lendTakeoverStep(db, { gh, now: () => now, seen, manager: (...a: string[]) => run(a.slice(1), "scheduler") });
      await step();
      expect(getAsk(db, mine)!.state).toBe("open"); // 第一次看到这个 head：等一轮，单子还是 claimed
      await step();
      expect(getLendOrder(db, orderId)!.status).toBe("done");
      expect(getAsk(db, mine)!.extra.settledOrder).toEqual({ orderId, status: "done", by: "lend", at: expect.any(Number) });
    } finally {
      takeoverDeps.make = prevMake;
      closeLedger(path);
    }
  });
});

describe("结清与新问并发（两个进程、同一个库文件）", () => {
  test("结清事务持写锁时另一进程开新问：等到锁后核到已结清，拒绝，不留 open 行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lend-askt-race-")), path = join(dir, "ledger.sqlite");
    const db = openLedger(path);
    try {
      const now = 1_000_000;
      setMeta(db, { actor: "owner", now }, { project: "p", key: "pms", value: ["pm"] });
      createTask(db, { actor: "owner", now }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "agent-dev" } as never);
      db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
        status, worker, leaseGen, leaseUntil, leaseMs, createdBy, createdAt, updatedAt, branch, base)
        VALUES ('lend:T1:s1:r0:a0', 'T1', 'p', 'mate', 'codex', 'write', 1, 0, ?, 'o/r', '{}', '', '', 'claimed', 'w1', 1, 1e13, 10000, 'pm', 1, 1, 'lend/T1-abcd', 'main')`, ["b".repeat(40)]);
      const ready = join(dir, "ready");
      const script = `
        import { openLedger, getTask } from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-store.ts"))};
        import { openAskFull } from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-asks.ts"))};
        import { openOrderAsk } from ${JSON.stringify(join(import.meta.dir, "../src/lib/order-ask.ts"))};
        import { writeFileSync } from "node:fs";
        const db = openLedger(${JSON.stringify(path)});
        const task = getTask(db, "T1");
        writeFileSync(${JSON.stringify(ready)}, "1");
        const r = await openOrderAsk(db, { open: (input, beforeWrite) => openAskFull(db, input, Date.now(), { beforeWrite }),
          notify: async () => ({ handed: true, note: "" }), markHanded: () => {}, record: () => {} },
          { task, orderId: "lend:T1:s1:r0:a0", from: "w1@mate", keyPrefix: "lend-ask:g1" }, { question: "并发的新问", options: [] });
        console.log(JSON.stringify(r));`;
      writeFileSync(join(dir, "child.ts"), script);
      db.run("BEGIN IMMEDIATE"); // 结清事务：拿着写锁
      const child = Bun.spawn([process.execPath, "--no-env-file", join(dir, "child.ts")], {
        env: testChildEnv({ HOME: dir, TMPDIR: dir, CLAUDESTRA_STATE_DIR: join(dir, "state"), CLAUDESTRA_RUNTIME_DIR: join(dir, "rt") }),
        stdout: "pipe", stderr: "pipe",
      });
      const deadline = Date.now() + 3_000;
      while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(20);
      await Bun.sleep(200); // 子进程已在等写锁
      db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = 'lend:T1:s1:r0:a0'");
      db.run("COMMIT");
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ code: "not_held", refused: expect.stringContaining("已结清（cancelled）") });
      expect((db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n).toBe(0);
    } finally { closeLedger(path); }
  });
});
