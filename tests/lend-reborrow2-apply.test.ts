/** REBOR2 canonical write: one order + held projection + evidence per old generation, zero half projection on any failure. */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeLedger, openLedger, listEvents } from "../src/lib/ledger-store.js";
import { cardMoved, getLendOrder, listLendOrders, type OfferInput } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { mustTask } from "../src/lib/ledger-checks.js";
import { captureReborrow2Facts } from "../src/lib/lend-reborrow2-facts.js";
import { prepareReborrow2Context, type Reborrow2Context } from "../src/lib/lend-reborrow2-context.js";
import { applyReborrow2 } from "../src/lib/lend-reborrow2-apply.js";
import { runReborrow2, type Reborrow2CliPort } from "../src/lib/lend-reborrow2-cli.js";
import { classifyReserved } from "../src/lib/lend-reborrow2-marker.js";
import { HELLO_FRESH_MS } from "../src/lib/lend-wire-v2.js";
import type { Reborrow2Remote } from "../src/lib/lend-reborrow2-source.js";
import { absent, at, base, borrowOf, fakeProbe, fp, fp2, now, other, peer, pm, pushed, repo, rows, setupLedger, taskId,
  type EndKind } from "./lend-reborrow2-fixture.js";

let db: Database;
const opened: Database[] = [], dirs: string[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
  closeLedger(":memory:");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const oldBranch = "lend/RB2-abcd", newBranch = "lend/RB2-1234";

function input(c: Reborrow2Context): OfferInput {
  const t = c.facts.target;
  return { taskId, peer: t.peer, repo, family: c.facts.family, pr: c.source.pr?.number ?? null, spec: "Keep original P0/P1",
    borrow: borrowOf(t.peer), write: { fp: t.fp, base: "main", baseSha: base, report: null, reborrow2: c } };
}

const defaultRemotes = (samePeer: boolean): Record<string, Reborrow2Remote | null> =>
  samePeer ? { [oldBranch]: at(oldBranch, pushed) } : { [oldBranch]: absent(oldBranch), [newBranch]: absent(newBranch) };

async function prepared(end: EndKind, samePeer: boolean, remotes = defaultRemotes(samePeer)) {
  const t = samePeer ? { peer, fp } : { peer: other, fp: fp2 };
  const f = captureReborrow2Facts(db, taskId, { ...t, repo, family: "codex" });
  return prepareReborrow2Context(f, fakeProbe(remotes).probe);
}

test.each([["push", true], ["model400", true], ["checkout", true], ["checkout", false]] as [EndKind, boolean][])(
  "%s / same peer %p: successor, held projection and evidence commit together; replay returns it", async (end, same) => {
    ({ db } = setupLedger(end));
    const oldLease = getWriteLease(db, taskId)!, oldRow = db.query("SELECT * FROM lend_orders").get();
    const remotes = same ? { [oldBranch]: end === "checkout" ? absent(oldBranch) : at(oldBranch, pushed) } : undefined;
    const c = await prepared(end, same, remotes);
    const o = applyReborrow2(db, { ...pm, now: now + 1 }, c, input(c), c.facts.target.fp);
    const startHead = end === "checkout" ? base : pushed;
    expect(o).toMatchObject({ peer: same ? peer : other, branch: same ? oldBranch : newBranch, head: startHead, pr: null, base: "main",
      supersedes: c.facts.previous.orderId, status: "pooled" });
    expect(o.reborrow2Basis).toEqual({ ledgerHead: null, previousOrderId: c.facts.previous.orderId, gen: 1, samePeer: same });
    expect(classifyReserved(o.wire.acceptance)).toMatchObject({ kind: "v2", binding: { peer: same ? "same" : "cross", src: oldBranch } });
    expect(o.wire.acceptance.join("\n")).toContain(`在分支 ${o.branch} 上接着改`);
    expect(getWriteLease(db, taskId)).toMatchObject({ state: "held", peer: o.peer, branch: o.branch });
    expect(db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(c.facts.previous.orderId)).toEqual(oldRow as never);
    const ev = listEvents(db, { target: taskId }).filter((e) => (e.data.lend as { op?: string })?.op === "write_reborrow2");
    expect(ev).toHaveLength(1);
    expect((ev[0].data.lend as { previousLease: unknown }).previousLease).toEqual(oldLease);
    expect(listEvents(db, { target: taskId }).some((e) => (e.data.lend as { op?: string })?.op === "reclaim" && e.ts > now)).toBe(false);
    expect(cardMoved(mustTask(db, taskId), o)).toBe(false);
    const before = rows(db);
    expect(applyReborrow2(db, { ...pm, now: now + 2 }, c, input(c), c.facts.target.fp).orderId).toBe(o.orderId);
    expect(rows(db)).toBe(before);
  });

test("a failed evidence append rolls back the order and the held projection", async () => {
  ({ db } = setupLedger("push"));
  const c = await prepared("push", true);
  db.run(`CREATE TRIGGER reject_rb2 BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.lend.op')='write_reborrow2' BEGIN SELECT RAISE(ABORT,'rollback probe'); END`);
  const before = rows(db);
  expect(() => applyReborrow2(db, { ...pm, now: now + 1 }, c, input(c), fp)).toThrow("rollback probe");
  expect(rows(db)).toBe(before);
});

test("two prepared requests on two connections create exactly one successor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb2-")); dirs.push(dir);
  const path = join(dir, "ledger.sqlite");
  ({ db } = setupLedger("push"));
  db.run(`VACUUM INTO '${path}'`);
  const a = openLedger(path), b = new (a.constructor as typeof Database)(path);
  opened.push(a, b);
  b.run("PRAGMA busy_timeout = 5000");
  const prep = async (conn: Database) => prepareReborrow2Context(captureReborrow2Facts(conn, taskId, { peer, fp, repo, family: "codex" }),
    fakeProbe({ [oldBranch]: at(oldBranch, pushed) }).probe);
  const [ca, cb] = [await prep(a), await prep(b)];
  const oa = applyReborrow2(a, { ...pm, now: now + 1 }, ca, input(ca), fp);
  const ob = applyReborrow2(b, { ...pm, now: now + 2 }, cb, input(cb), fp);
  expect(ob.orderId).toBe(oa.orderId);
  expect(listLendOrders(a, taskId).filter((o) => o.supersedes === ca.facts.previous.orderId)).toHaveLength(1);
});

test("a changed request for the same old generation conflicts instead of issuing a second order", async () => {
  ({ db } = setupLedger("checkout"));
  const c = await prepared("checkout", false);
  applyReborrow2(db, { ...pm, now: now + 1 }, c, input(c), fp2);
  db.run("UPDATE lend_orders SET status = 'cancelled' WHERE supersedes IS NOT NULL");
  const before = rows(db);
  await expect(prepared("checkout", true, { [oldBranch]: absent(oldBranch) })).rejects.toThrow();
  expect(rows(db)).toBe(before);
});

test.each(["drift", "ancestry", "unreadable", "fp", "pr-changed"])("source %s refuses before any write", async (bad) => {
  ({ db } = setupLedger("push"));
  if (bad === "pr-changed") db.run("UPDATE tasks SET pr = 'https://github.com/owner/repo/pull/9'");
  const f = captureReborrow2Facts(db, taskId, { peer, fp, repo, family: "codex" });
  const remotes = { [oldBranch]: at(oldBranch, pushed) };
  const fake = fakeProbe(bad === "unreadable" ? {} : remotes, { ancestor: bad === "ancestry" ? false : true, fp: bad === "fp" ? { [peer]: fp2 } : undefined });
  if (bad === "drift") { let n = 0; const r = fake.probe.remote; fake.probe.remote = async (...a) => (++n > 1 ? at(oldBranch, "d".repeat(40)) : r(...a)); }
  const before = rows(db);
  await expect(prepareReborrow2Context(f, fake.probe)).rejects.toThrow("终态接续来源未对账");
  expect(rows(db)).toBe(before);
});

test.each(["deleted", "stale", "revoked", "reboot"])("cross peer: original peer %s after preparation refuses inside the transaction, zero write", async (bad) => {
  ({ db } = setupLedger("checkout"));
  const c = await prepared("checkout", false);
  if (bad === "deleted") db.run("DELETE FROM lend_peers WHERE peer = ?", [peer]);
  if (bad === "stale") db.run("UPDATE lend_peers SET helloAt = ? WHERE peer = ?", [now - HELLO_FRESH_MS, peer]);
  if (bad === "revoked") db.run("UPDATE lend_peers SET grant = NULL WHERE peer = ?", [peer]);
  if (bad === "reboot") db.run("UPDATE lend_peers SET boot = 'mate-reboot' WHERE peer = ?", [peer]);
  const before = rows(db);
  expect(() => applyReborrow2(db, { ...pm, now: now + 1 }, c, input(c), fp2)).toThrow("原提供方");
  expect(rows(db)).toBe(before);
  expect(listLendOrders(db, taskId).filter((o) => o.supersedes)).toHaveLength(0);
});

test("cross peer refuses a new branch that already carries another head", async () => {
  ({ db } = setupLedger("checkout"));
  const g = captureReborrow2Facts(db, taskId, { peer: other, fp: fp2, repo, family: "codex" });
  const remotes = { [oldBranch]: absent(oldBranch), [newBranch]: at(newBranch, "e".repeat(40)) };
  await expect(prepareReborrow2Context(g, fakeProbe(remotes).probe)).rejects.toThrow("新出借分支");
});

test("an unprepared or v1 context and mismatched input are refused inside the transaction", async () => {
  ({ db } = setupLedger("push"));
  const c = await prepared("push", true);
  const forged = structuredClone(c) as Reborrow2Context;
  const before = rows(db);
  expect(() => applyReborrow2(db, pm, forged, { ...input(c), write: { ...input(c).write!, reborrow2: forged } }, fp)).toThrow("未经本次真实来源核验");
  expect(() => applyReborrow2(db, pm, c, { ...input(c), pr: 5 }, fp)).toThrow("不符");
  expect(() => applyReborrow2(db, { ...pm, actor: "agent-worker" }, c, input(c), fp)).toThrow("真实 PM");
  expect(rows(db)).toBe(before);
});

test("a damaged basis (quoted old terminal row changed) makes the order dead (cardMoved), never ordinary", async () => {
  ({ db } = setupLedger("push"));
  const c = await prepared("push", true);
  const o = applyReborrow2(db, { ...pm, now: now + 1 }, c, input(c), fp);
  db.run("UPDATE lend_orders SET updatedAt = updatedAt + 1 WHERE orderId = ?", [c.facts.previous.orderId]); // quoted old terminal row no longer matches
  const read = getLendOrder(db, o.orderId)!;
  expect(read.reborrow2Basis).toBeNull();
  expect(read.reborrowBasis).toBeUndefined();
  expect(cardMoved(mustTask(db, taskId), read)).toBe(true);
});

test("CLI orchestration: dry-run writes nothing, apply issues once, replay is a duplicate", async () => {
  ({ db } = setupLedger("model400"));
  const fake = fakeProbe({ [oldBranch]: at(oldBranch, pushed) });
  const port = (apply: boolean): Reborrow2CliPort => ({ db, actor: pm.actor, now: () => now, ctx: () => ({ ...pm, now: now + 1 }),
    borrow: async () => borrowOf(peer), peerFp: fake.probe.peerFp, probe: fake.probe,
    materials: async (family) => ({ input: { taskId, peer, repo, family, pr: null, spec: "Keep original P0/P1", borrow: borrowOf(peer),
      write: { fp, base: "main", baseSha: base, report: null } } }),
    refresh: async (i) => ({ ...i, borrow: borrowOf(peer) }) });
  const req = (apply: boolean) => ({ taskId, peer, repo, family: "codex" as const, endedOrder: listLendOrders(db, taskId)[0].orderId, apply });
  const before = rows(db);
  expect(await runReborrow2(port(false), req(false))).toMatchObject({ ok: true, dryRun: true, end: "stopped", leaseReason: "派不回去：模型配置 400",
    startHead: pushed, oldHead: pushed, samePeer: true });
  expect(rows(db)).toBe(before);
  const r = await runReborrow2(port(true), req(true));
  expect(r).toMatchObject({ ok: true, head: pushed, peer });
  expect(await runReborrow2(port(true), req(true))).toMatchObject({ ok: true, duplicate: true, orderId: r.orderId });
  await expect(runReborrow2(port(true), { ...req(true), endedOrder: "lend:RB2:s1:r0:a9" })).rejects.toThrow();
});
