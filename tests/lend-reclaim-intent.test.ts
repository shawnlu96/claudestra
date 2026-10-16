/**
 * RECLAIMINT1 on a synthetic ledger: a build order pooled through a scheduler intent, claimed, lease expired → order and intent
 * unknown → PM `lend-reclaim`. With `lendReclaimIntent` on and the peer provably left nothing, the intent is cancelled in the
 * reclaim's transaction and the next plan is an intent again; any result, doubt or drift keeps it unknown. Remote reads are fakes.
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getLendOrder, offerLendCore } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { schedulerPoolStep } from "../src/lib/ledger-scheduler-pool.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { BranchProbe, PrProbe, ReclaimIntentProbe } from "../src/lib/lend-reclaim-intent.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { poolOrderId } from "../src/lib/scheduler-pool-facts.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE = { mode: "balance" as const, roles: ["write" as const], poolTimeoutMin: 15, repo: "o/r" };
const BORROW = { peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 3 };
const BRANCH = "lend/T1-abcd";

const setMode = (mode: "on" | "observe" | "off" | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendReclaimIntent: mode } } } }));
afterEach(() => setMode(null));

interface Remote { branch: BranchProbe | (() => Promise<BranchProbe>); pr: PrProbe | (() => Promise<PrProbe>); calls: string[] }

/** A build order at peer mate, pooled by a scheduler intent, claimed and then expired: order and intent are both unknown. */
async function world() {
  const f = autoFixture();
  await toBuild(f);
  // The author family the scheduler offers a build in is the card's own (claude here), so the reclaimed card's local author still fits.
  const snap = () => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now() });
  const planned = planScheduler(snap()) as { kind: string; id: string };
  expect(planned.kind).toBe("intent");
  const id = planned.id, t = f.task();
  const seq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE target = 'T1'").get() as { s: number }).s;
  f.db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt) VALUES (?, 'T1', 'p', 'write', 'dispatch', 'peer:mate', ?, ?, ?, ?, 2, 'pending', '挂池开工', 1, 1)`)
    .run(id, seq, t.rev, t.specRev, t.headSHA);
  const o = offerLendCore(f.db, f.at("scheduler"), { taskId: "T1", peer: "mate", family: "claude", repo: "o/r", pr: null, spec: "规格", borrow: BORROW,
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: H1, report: null } });
  insertEvent(f.db, { ...f.at("scheduler"), dedupKey: `scheduler:${id}:pool` }, { project: "p", target: "T1", kind: "scheduler",
    data: { op: "pool_offer", id, orderId: o.orderId } }, true);
  const remote: Remote = { branch: { state: "absent" }, pr: { state: "none" }, calls: [] };
  const answer = async <T>(v: T | (() => Promise<T>)): Promise<T> => typeof v === "function" ? (v as () => Promise<T>)() : v;
  const reclaimProbe: ReclaimIntentProbe = {
    branch: async (repo, branch) => { remote.calls.push(`branch ${repo} ${branch}`); return answer(remote.branch); },
    prs: async (repo, branch) => { remote.calls.push(`prs ${repo} ${branch}`); return answer(remote.pr); },
  };
  const lend = { borrow: async () => [BORROW], notifyPm: async () => {}, reclaimProbe,
    result: { reportDir: () => f.dir, writeReport: () => {}, sign: () => null, remoteHead: async () => ({ ok: false as const, error: "fake" }) } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend } as never, actor, ...args) as Promise<Record<string, any>>;
  await cli("owner", "lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: o.orderId, worker: "w1" }));
  const step = () => schedulerPoolStep(f.db, f.at("scheduler"), { intentId: id, maxWorkers: 2, remote: REMOTE, borrow: [BORROW], spec: null, timeoutMs: 15 * 60_000 });
  expect(step().outcome).toBe("claimed");
  f.advance(11 * 60_000);
  await cli("owner", "lend-sweep");
  expect(step().outcome).toBe("unknown");
  const reclaim = (...extra: string[]) => cli("pm", "lend-reclaim", "T1", "--reason", "出借方掉线，核过没有成果", ...extra);
  return { f, id, orderId: o.orderId, remote, cli, reclaim, snap, plan: () => planScheduler(snap()), intent: () => getIntent(f.db, id)!,
    observed: () => f.db.query("SELECT text, data FROM events WHERE kind = 'note' AND json_extract(data, '$.mechanism') = 'lendReclaimIntent'").all() as
      { text: string; data: string }[] };
}
type World = Awaited<ReturnType<typeof world>>;

test("[验收线 1] claimed → lease expired → unknown → PM reclaim (on) → intent cancelled with full receipt → next pass plans a new intent", async () => {
  const w = await world();
  try {
    expect(w.plan()).toMatchObject({ kind: "wait", code: "unknown_effect" });
    setMode("on");
    const r = await w.reclaim();
    expect(r).toMatchObject({ ok: true, task: "T1", peer: "mate", cancelled: w.orderId, intent: { status: "settled", intentId: w.id } });
    expect(w.remote.calls.sort()).toEqual([`branch o/r ${BRANCH}`, `prs o/r ${BRANCH}`]);
    const i = w.intent();
    expect(i.status).toBe("cancelled");
    const reclaimSeq = w.f.db.query("SELECT seq FROM events WHERE json_extract(data, '$.lend.op') = 'reclaim'").get() as { seq: number };
    for (const part of [`收回事件 #${reclaimSeq.seq}`, w.orderId, "第 1 代租约", `分支 ${BRANCH} origin 上不存在`, "PR（含已关闭）", "台账无交付 / 回执"]) {
      expect(i.receipt).toContain(part);
    }
    const settle = w.f.db.query("SELECT actor, data FROM events WHERE dedupKey = ?").get(`scheduler:${w.id}:cancelled`) as { actor: string; data: string };
    expect(settle.actor).toBe("pm");
    expect(JSON.parse(settle.data)).toMatchObject({ op: "settle", from: "unknown", to: "cancelled", manual: true });
    expect(w.plan()).toMatchObject({ kind: "intent", node: "write", action: "dispatch" });
  } finally { w.f.close(); }
});

const kept: [string, (w: World) => void, string][] = [
  ["branch pushed", (w) => { w.remote.branch = { state: "present", head: "3".repeat(40) }; }, "分支已推到 origin"],
  ["a closed PR", (w) => { w.remote.pr = { state: "exists", numbers: [41] }; }, "#41"],
  ["a delivery on the order", (w) => { w.f.db.run("UPDATE lend_orders SET resultSha = 'x' WHERE orderId = ?", [w.orderId]); }, "已有交付"],
  ["a peer receipt", (w) => { insertEvent(w.f.db, w.f.at("lend"), { project: "p", target: "T1", kind: "note", text: "出借：mate 报 stopped",
    data: { lend: { orderId: w.orderId, peer: "mate", op: "release", reason: "stopped", gen: 1 } } }, false); }, "对方回执"],
  ["branch query failed", (w) => { w.remote.branch = { state: "unknown", why: "git ls-remote 失败（exit 128）" }; }, "分支查询不确定"],
  ["PR query timed out", (w) => { w.remote.pr = { state: "unknown", why: "gh pr list 超时" }; }, "PR 查询不确定"],
  ["branch probe throws", (w) => { w.remote.branch = async () => { throw new Error("no network"); }; }, "查询出错：no network"],
  ["PR query fails with multi-line stderr", (w) => { w.remote.pr = { state: "unknown", why: "gh pr list 失败\n\tHTTP 502\u2028" }; }, "gh pr list 失败 HTTP 502"],
];
for (const [name, arrange, why] of kept) {
  test(`[验收线 ${name.includes("query") || name.includes("throws") ? 3 : 2}] ${name}: the intent stays unknown, the reclaim itself succeeds and says why`, async () => {
    const w = await world();
    try {
      setMode("on"); arrange(w);
      const r = await w.reclaim();
      expect(r).toMatchObject({ ok: true, cancelled: w.orderId, intent: { status: "kept_unknown", intentId: w.id } });
      expect(r.intent.reason).toContain(why);
      expect(getLendOrder(w.f.db, w.orderId)?.status).toBe("cancelled");
      expect(getWriteLease(w.f.db, "T1")?.state).toBe("ended");
      expect(w.intent().status).toBe("unknown");
      expect(w.plan()).toMatchObject({ kind: "wait", code: "unknown_effect" });
    } finally { w.f.close(); }
  });
}

const drift: [string, (w: World) => void, string][] = [
  ["another unsettled intent on the card", (w) => { w.f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq,
    taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt) VALUES ('other', 'T1', 'p', 'build', 'ensure_session', NULL, 1, 1, 1,
    NULL, 2, 'pending', 'x', 1, 1)`); }, "同卡还有未结的调度意图：other"],
  ["lease generation moved", (w) => { w.f.db.run("UPDATE lend_orders SET leaseGen = leaseGen + 1 WHERE orderId = ?", [w.orderId]); }, "租约代数"],
  ["task rev moved", (w) => { w.f.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'"); }, "rev / specRev / round"],
];
for (const [name, mutate, why] of drift) {
  test(`[验收线 4] ${name} between the remote reads and the transaction: reclaim only, the intent stays unknown`, async () => {
    const w = await world();
    try {
      setMode("on");
      w.remote.pr = async () => { mutate(w); return { state: "none" }; }; // lands after the candidate was read, before the transaction
      const r = await w.reclaim();
      expect(r.intent).toMatchObject({ status: "kept_unknown", intentId: w.id });
      expect(r.intent.reason).toContain(why);
      expect(w.intent().status).toBe("unknown");
      expect(getLendOrder(w.f.db, w.orderId)?.status).toBe("cancelled");
    } finally { w.f.close(); }
  });
}

test("[验收线 4] a repeated reclaim settles nothing more; a transaction that fails after the settle leaves intent and reclaim both unwritten", async () => {
  const w = await world();
  try {
    setMode("on");
    w.f.db.run(`CREATE TRIGGER boom AFTER UPDATE OF status ON scheduler_intents WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(await w.reclaim()).toMatchObject({ ok: false, error: "boom" });
    expect(w.intent().status).toBe("unknown");
    expect(getLendOrder(w.f.db, w.orderId)?.status).toBe("unknown");
    expect(getWriteLease(w.f.db, "T1")?.state).toBe("held");
    expect(w.f.db.query("SELECT 1 FROM events WHERE json_extract(data, '$.lend.op') = 'reclaim'").get()).toBeNull();
    w.f.db.run("DROP TRIGGER boom");
    expect((await w.reclaim()).intent.status).toBe("settled");
    const settles = () => w.f.db.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'settle' AND json_extract(data, '$.to') = 'cancelled'").get();
    const before = settles();
    expect(await w.reclaim()).toMatchObject({ ok: false, code: "not_found" });
    expect(settles()).toEqual(before);
    expect(w.intent().status).toBe("cancelled");
  } finally { w.f.close(); }
});

/** Every row the reclaim can touch, in a stable order. */
const dump = (w: World) => JSON.stringify(["events", "scheduler_intents", "lend_orders", "lend_write_leases", "tasks", "scheduler_resources"]
  .map((t) => w.f.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()));

test("[验收线 5] off: no remote read, no extra output field, and the ledger ends byte-for-byte where the pre-feature reclaim leaves it", async () => {
  const a = await world(), b = await world();
  try {
    setMode("off");
    const ra = await a.reclaim();
    expect(Object.keys(ra).sort()).toEqual(["cancelled", "ok", "peer", "task"]);
    expect(a.remote.calls).toEqual([]);
    expect(a.intent().status).toBe("unknown");
    expect(a.observed()).toEqual([]);
    // b runs the same reclaim with the switch read as off at the lib boundary (no preparation at all = the code before this card).
    const { reclaimLend } = await import("../src/lib/ledger-lend.js");
    const at = (a.f.db.query("SELECT ts FROM events WHERE json_extract(data, '$.lend.op') = 'reclaim'").get() as { ts: number }).ts;
    const rb = reclaimLend(b.f.db, { actor: "pm", now: at }, { taskId: "T1", reason: "出借方掉线，核过没有成果", retire: undefined });
    expect(rb).toMatchObject({ intent: null, unpinned: false });
    // elapsedMs = 出借记忆 observe 样本的实测耗时（memory-retrieve-lend.ts），和 ts 一样是时钟读数；它在事件 data 的 JSON 串里，引号带转义
    const strip = (s: string) => s.replace(/"(ts|createdAt|updatedAt)":\d+/g, "\"$1\":0").replace(/\\"elapsedMs\\":\d+/g, "\\\"elapsedMs\\\":0");
    expect(strip(dump(a))).toBe(strip(dump(b)));
  } finally { a.f.close(); b.f.close(); }
});

test("[验收线 3] observe with a multi-line probe error records one line and the reclaim still succeeds", async () => {
  const w = await world();
  try {
    setMode("observe");
    w.remote.branch = { state: "unknown", why: "fatal:\n\tAuthentication failed" };
    const r = await w.reclaim();
    expect(r).toMatchObject({ ok: true, intent: { status: "kept_unknown", observed: true } });
    expect(w.observed()[0].text).toContain("分支查询不确定：fatal: Authentication failed");
    expect(JSON.parse(w.observed()[0].data)).toMatchObject({ wouldSettle: false });
  } finally { w.f.close(); }
});

test("[验收线 5] observe: one deduplicated observation naming the intent and its basis; the intent is not touched", async () => {
  const w = await world();
  try {
    setMode("observe");
    const r = await w.reclaim();
    expect(r.intent).toMatchObject({ status: "kept_unknown", intentId: w.id, observed: true });
    expect(w.intent().status).toBe("unknown");
    const rows = w.observed();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain(`结清意图 ${w.id}`);
    expect(JSON.parse(rows[0].data)).toMatchObject({ op: "recovery_observe", actionKey: `${w.orderId}:g1`, orderId: w.orderId, leaseGen: 1, wouldSettle: true });
    const { settleReclaimIntent } = await import("../src/lib/lend-reclaim-intent.js");
    const { prepareReclaimIntent } = await import("../src/lib/lend-reclaim-intent.js");
    w.f.db.run("UPDATE lend_orders SET status = 'unknown' WHERE orderId = ?", [w.orderId]); // replay the same order + generation
    const prep = await prepareReclaimIntent(w.f.db, w.f.task(), { link: poolOrderId, probe: { branch: async () => ({ state: "absent" }), prs: async () => ({ state: "none" }) } });
    const order = getLendOrder(w.f.db, w.orderId)!;
    settleReclaimIntent(w.f.db, w.f.at("pm"), { task: w.f.task(), order, lease: { ...getWriteLease(w.f.db, "T1")!, state: "held" }, prep });
    expect(w.observed()).toHaveLength(1);
  } finally { w.f.close(); }
});

const pin = (w: World, placement: string | null) => {
  const extra: Record<string, unknown> = { ...w.f.task().extra, keep: { nested: [1, "x"] } };
  if (placement !== null) extra.placement = placement;
  w.f.db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [JSON.stringify(extra)]);
  return extra;
};
const rawExtra = (w: World) => (w.f.db.query("SELECT extra FROM tasks WHERE id = 'T1'").get() as { extra: string }).extra;

test("--unpin drops only a placement pinned on the reclaimed peer, keeps every other extra key, whatever the intent switch says", async () => {
  const w = await world();
  try {
    setMode("off");
    const { placement: _, ...rest } = pin(w, "peer:mate");
    expect(await w.reclaim("--unpin")).toMatchObject({ ok: true, unpinned: true });
    expect(w.f.task().extra).toEqual(rest);
  } finally { w.f.close(); }
});

for (const placement of ["peer:other", "local", null] as const) {
  test(`--unpin leaves extra byte-for-byte when the placement is ${placement ?? "absent"}; without --unpin no unpinned field`, async () => {
    const w = await world(), v = await world();
    try {
      pin(w, placement); pin(v, "peer:mate");
      const raw = rawExtra(w), rawV = rawExtra(v);
      expect(await w.reclaim("--unpin")).toMatchObject({ ok: true, unpinned: false });
      expect(rawExtra(w)).toBe(raw);
      const plain = await v.reclaim();
      expect(plain.ok).toBe(true);
      expect("unpinned" in plain).toBe(false);
      expect(rawExtra(v)).toBe(rawV);
    } finally { w.f.close(); v.f.close(); }
  });
}

test("[验收线 3] remote reads that never answer are unknown after the bound, never taken as absent / none", async () => {
  const w = await world();
  try {
    const { prepareReclaimIntent } = await import("../src/lib/lend-reclaim-intent.js");
    const prep = await prepareReclaimIntent(w.f.db, w.f.task(), { link: poolOrderId, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), timeoutMs: 20,
      probe: { branch: () => new Promise(() => {}), prs: () => new Promise(() => {}) } });
    expect(prep).toMatchObject({ mode: "on", candidate: { intentId: w.id, orderId: w.orderId, leaseGen: 1, branch: BRANCH },
      branch: { state: "unknown", why: expect.stringContaining("没回") }, pr: { state: "unknown", why: expect.stringContaining("没回") } });
  } finally { w.f.close(); }
});
