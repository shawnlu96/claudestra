/**
 * UXPAUSE1 · `ledger card-pause` / `card-resume` on a real temp ledger through the ledger CLI: the write transaction (pending intents
 * cancelled, unclaimed pool order withdrawn, a claimed one kept and its verdict still landing, nothing else touched), stage /
 * manual-merge-request refusals, duplicates, permissions, the cardPause switch and the gate predicate without a shared mode file.
 * The real scheduler pass is tests/card-pause-pass.test.ts; the bridge endpoint tests/card-pause-api.test.ts.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CARD_PAUSE_OP, cardPaused, cardPauseState, configureCardPauseObserver, configureCardPausePolicy, pausedCardIds } from "../src/lib/card-pause.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { saveRawResult } from "../src/lib/pool-review-proof-raw.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerV2SkipTask } from "../src/lib/scheduler-v2-skip.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { B_WORKER, lendSide } from "./pool-review-proof-helpers.js";

type Reply = Record<string, any>;
const cleanups: (() => void)[] = [];
afterEach(() => { configureCardPausePolicy(null); configureCardPauseObserver(null); while (cleanups.length) cleanups.pop()!(); });
const policy = (mode: RecoveryMode) => configureCardPausePolicy((_p, key) => ({ mode: key === "cardPause" ? mode : "observe", manualAfterMs: null, source: "config" }));

function fixture() {
  const f = autoFixture();
  cleanups.push(f.close);
  const cli = (actor: string, ...args: string[]) => f.cli(actor, ...args) as Promise<Reply>;
  return { ...f, cli, pause: (actor = "pm", reason = "PM 核对需求") => cli(actor, "card-pause", "T1", "--reason", reason),
    resume: (actor = "pm") => cli(actor, "card-resume", "T1") };
}

/** Everything the pause must leave alone: stage, round, head, workflow mode / rev, card-scope resources (file locks). */
function untouched(db: Database) {
  return { task: db.query("SELECT stage, round, headSHA, specRev FROM tasks WHERE id = 'T1'").get(),
    workflow: db.query("SELECT mode, rev FROM task_workflows WHERE taskId = 'T1'").get(),
    locks: db.query("SELECT * FROM scheduler_resources WHERE scope != 'intent' ORDER BY resource").all() };
}

function intent(db: Database, id: string, status: string) {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, 'T1', 'p', 'write', 'dispatch', 0, 1, 1, 2, ?, 'test', 0, 0)`).run(id, status);
}
const statusOf = (db: Database, id: string) => (db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(id) as { status: string }).status;

describe("[验收线 2] the pause write transaction", () => {
  test("pending intents are cancelled, submitted / done ones kept; stage / round / head / workflow rev / file locks unchanged", async () => {
    policy("on");
    const f = fixture();
    await toBuild(f);
    intent(f.db, "i-pend", "pending"); intent(f.db, "i-sub", "submitted"); intent(f.db, "i-done", "done");
    const lock = f.db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T1', ?, 1, ?)");
    lock.run("file:src/lib/x.ts", "i-sub", "card");
    lock.run("slot:x", "i-pend", "intent");
    const before = untouched(f.db);
    const r = await f.pause();
    expect(r).toMatchObject({ ok: true, duplicate: false, cancelledIntents: ["i-pend"], state: { paused: true, actor: "pm", reason: "PM 核对需求" } });
    expect([statusOf(f.db, "i-pend"), statusOf(f.db, "i-sub"), statusOf(f.db, "i-done")]).toEqual(["cancelled", "submitted", "done"]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE intentId = 'i-pend'").get()).toEqual({ n: 0 });
    expect(untouched(f.db)).toEqual(before);
    const ev = listEvents(f.db, { project: "p", target: "T1" }).at(-1)!;
    expect(ev).toMatchObject({ kind: "decision", actor: "pm", text: "PM 核对需求", data: { op: CARD_PAUSE_OP, stage: "build", cancelledIntents: ["i-pend"] } });
    expect(await f.resume()).toMatchObject({ ok: true, duplicate: false, state: { paused: false } });
    expect(untouched(f.db)).toEqual(before);
  });

  const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
  /** scheduler-pool.test.ts's pooled card: delivered for review, no local reviewer slot, one borrow peer. */
  async function pooled() {
    const f = fixture();
    const spec = join(f.dir, "T1.md");
    writeFileSync(spec, "规格：只改 src/lib/x.ts");
    f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
    const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
    const reports = join(f.dir, "reports");
    mkdirSync(reports);
    const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
    const b = lendSide(f.dir);
    const lend = { borrow: async () => borrow, notifyPm: async () => {},
      result: { reportDir: () => reports, writeReport: (p: string, body: string) => writeFileSync(p, body), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
        saveRaw: (text: string) => saveRawResult(join(f.dir, "lend-raw"), text), pinnedKey: async () => b.pinned } };
    const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Reply>;
    const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
    const tick = async () => (await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } }, deps)).cards[0];
    const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
    const answer = async (orderId: string) => {
      const claimed = await peer("claim", { v: 1, orderId, worker: B_WORKER });
      return (await b.answer(claimed as never, { verdict: "pass" }, (body) => peer("write", body))).r;
    };
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    expect(await tick()).toMatchObject({ step: "pool_pooled" });
    return { f, cli, tick, peer, answer, orders: () => listLendOrders(f.db, "T1") };
  }

  test("an unclaimed pool order is withdrawn with its pending intent", async () => {
    policy("on");
    const p = await pooled();
    const [o] = p.orders();
    const before = untouched(p.f.db);
    expect(await p.cli("pm", "card-pause", "T1", "--reason", "先停一下")).toMatchObject({ ok: true, poolOrders: { withdrawn: [o!.orderId] } });
    expect(p.orders()[0]).toMatchObject({ status: "cancelled", reason: expect.stringContaining("卡暂停") });
    expect(p.f.intents().at(-1)).toMatchObject({ recipient: "peer:mate", status: "cancelled" });
    expect(untouched(p.f.db)).toEqual(before);
    expect(await p.peer("claim", { v: 1, orderId: o!.orderId, worker: B_WORKER })).toMatchObject({ ok: false });
  });

  test("a claimed order is kept; the peer's verdict still lands while the card is paused", async () => {
    policy("on");
    const p = await pooled();
    const [o] = p.orders();
    expect((await p.peer("claim", { v: 1, orderId: o!.orderId, worker: B_WORKER })).ok).toBe(true);
    expect(await p.cli("pm", "card-pause", "T1", "--reason", "先停一下")).toMatchObject({ ok: true, poolOrders: { withdrawn: [] } });
    expect(p.orders()[0]!.status).toBe("claimed");
    expect(p.f.intents().at(-1)).toMatchObject({ recipient: "peer:mate", status: "submitted" });
    expect(await p.answer(o!.orderId)).toMatchObject({ ok: true });
    expect(listEvents(p.f.db, { project: "p", target: "T1" }).some((e) => e.kind === "review" && e.data.verdict === "pass")).toBe(true);
    expect(cardPauseState(p.f.db, "T1")?.paused).toBe(true);
  });
});

describe("[验收线 4] stage and request refusals, duplicates", () => {
  for (const stage of ["merge", "live", "verified", "blocked", "done", "cancelled"]) {
    test(`${stage}: refused with the reason, nothing written`, async () => {
      policy("on");
      const f = fixture();
      f.db.query("UPDATE tasks SET stage = ? WHERE id = 'T1'").run(stage);
      const n = listEvents(f.db, { project: "p" }).length;
      expect(await f.pause()).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining(`在 ${stage} 阶段，不能暂停`) });
      expect(listEvents(f.db, { project: "p" })).toHaveLength(n);
    });
  }

  test("an open manual merge request refuses; revoked, it no longer does", async () => {
    policy("on");
    const f = fixture();
    f.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'T1'").run();
    const req = f.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (1, 'pm', 'p', 'T1', 'decision', '人工合并', ?) RETURNING seq`)
      .get(JSON.stringify({ op: "manual_merge_request", head: H1, specRev: 1, round: 1, review: {} })) as { seq: number };
    expect(await f.pause()).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining(`未结的人工合并请求 #${req.seq}`) });
    f.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (2, 'pm', 'p', 'T1', 'decision', '撤回', ?)`)
      .run(JSON.stringify({ op: "manual_merge_revoke", request: req.seq }));
    expect(await f.pause()).toMatchObject({ ok: true, duplicate: false });
  });

  test("spec / restate / build / review / fix pause; a second pause and a second resume are duplicates, not errors", async () => {
    policy("on");
    const f = fixture();
    for (const stage of ["spec", "restate", "build", "review", "fix"]) {
      f.db.query("UPDATE tasks SET stage = ? WHERE id = 'T1'").run(stage);
      expect(await f.pause()).toMatchObject({ ok: true, duplicate: false });
      const n = listEvents(f.db, { project: "p" }).length;
      expect(await f.pause()).toMatchObject({ ok: true, duplicate: true, state: { paused: true } });
      expect(await f.resume()).toMatchObject({ ok: true, duplicate: false });
      expect(await f.resume()).toMatchObject({ ok: true, duplicate: true });
      expect(listEvents(f.db, { project: "p" })).toHaveLength(n + 1);
    }
  });

  test("only owner / project PM / master: the executor and the dispatcher are refused", async () => {
    policy("on");
    const f = fixture();
    expect(await f.pause("agent-task-one")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.pause("owner")).toMatchObject({ ok: true, state: { actor: "owner" } });
    expect(await f.resume("agent-task-one")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("pm", "card-pause", "T1")).toMatchObject({ ok: false, code: "invalid" }); // --reason is required
    expect(await f.resume("master")).toMatchObject({ ok: true, duplicate: false });
  });
});

describe("[验收线 5] the cardPause switch and the predicate", () => {
  test("off refuses a pause but still lets an old pause be resumed", async () => {
    policy("on");
    const f = fixture();
    expect((await f.pause()).ok).toBe(true);
    policy("off");
    expect(cardPaused(f.db, "T1", "hook")).toBe(false);
    expect(await f.resume()).toMatchObject({ ok: true, duplicate: false });
    expect(await f.pause()).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("开关（cardPause）关着") });
  });

  test("observe records the pause but holds nothing; on holds — with no shared mode file next to the ledger", async () => {
    const f = fixture();
    expect(existsSync(join(dirname(f.db.filename), "shared-ledger-modes.json"))).toBe(false);
    policy("observe");
    expect(await f.pause()).toMatchObject({ ok: true, state: { paused: true } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).at(-1)!.data).toMatchObject({ op: CARD_PAUSE_OP, mode: "observe" });
    expect([cardPaused(f.db, "T1", "hook"), schedulerV2SkipTask(f.db, "T1")]).toEqual([false, false]);
    policy("on");
    expect([cardPaused(f.db, "T1", "hook"), schedulerV2SkipTask(f.db, "T1")]).toEqual([true, true]);
    expect([...pausedCardIds(f.db)]).toEqual(["T1"]);
    await f.resume();
    expect([cardPaused(f.db, "T1", "hook"), schedulerV2SkipTask(f.db, "T1")]).toEqual([false, false]);
    expect([...pausedCardIds(f.db)]).toEqual([]);
  });

  test("the default (no policy file entry) is observe", async () => {
    const f = fixture();
    expect(await f.pause()).toMatchObject({ ok: true });
    expect(listEvents(f.db, { project: "p", target: "T1" }).at(-1)!.data.mode).toBe("observe");
    expect(cardPaused(f.db, "T1", "hook")).toBe(false);
  });

  test("observe: the hook layer hands one would-be hold per card + pause + action to the observer; a new pause is a new note", async () => {
    policy("observe");
    const f = fixture();
    const seen: string[] = [];
    configureCardPauseObserver(async (taskId, actionKey) => { seen.push(`${taskId} ${actionKey}`); return { ok: true }; });
    const first = await f.pause();
    for (let i = 0; i < 3; i++) expect(schedulerV2SkipTask(f.db, "T1")).toBe(false);
    cardPaused(f.db, "T1", "pace");
    await f.resume();
    expect(schedulerV2SkipTask(f.db, "T1")).toBe(false);
    const second = await f.pause();
    schedulerV2SkipTask(f.db, "T1");
    expect(seen).toEqual([`T1 pause.${first.state.seq}.hook`, `T1 pause.${first.state.seq}.pace`, `T1 pause.${second.state.seq}.hook`]);
  });
});
