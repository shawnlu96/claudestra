/** The real local/peer verdict intake persists pitfall before the automatic observer reads it. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { getTask } from "../src/lib/ledger-store.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import type { LendReceipt } from "../src/lib/lend-wire.js";
import { P, verdictFixture, type VerdictFixture } from "./memory-auto-verdict-fixture.ts";
import { testChildEnv } from "./test-env.ts";

/**
 * The shared ":memory:" pollution probe runs in its own `bun test` child: openLedger caches connections by path process-wide,
 * so writing to or closing ":memory:" in this process would hit whichever neighbour file holds it (a missing row proves nothing
 * about who owns the handle). The child is a fresh process, so the polluted handle it creates and closes is provably its own.
 * Mode "legacy" replays the old setup (reopen ":memory:", create task A) and must go red; "fixture" runs the private fixture.
 */
const POLLUTION_CHILD = "MEMORY_VERDICT_POLLUTION_CHILD";
const childMode = process.env[POLLUTION_CHILD];
const childTest = childMode ? test : ((() => {}) as unknown as typeof test);
const parentTest = childMode ? ((() => {}) as unknown as typeof test) : test;

// Every test owns its ledger file, temp dir and generated instance key (see the fixture); nothing rides on ":memory:" or STATE_DIR.
let fx: VerdictFixture | undefined, db: Database;
let run: VerdictFixture["run"], pitfalls: VerdictFixture["pitfalls"], local: VerdictFixture["local"], peerOrder: VerdictFixture["peerOrder"];
beforeEach(() => { fx = verdictFixture(); ({ db, run, pitfalls, local, peerOrder } = fx); });
afterEach(() => { const own = fx; fx = undefined; own?.dispose(); });

parentTest("submit_verdict pitfall survives persisted findings/read path; replay never creates another pitfall", async () => {
  expect(local(true)).toMatchObject({ ok: true, duplicate: false });
  const events = listEvents(db, { project: P, target: "A" });
  expect(events.find((e) => e.kind === "review")!.data.findings).toMatchObject([{ pitfall: true }]);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ pitfall: true }] } });
  await run(); expect(pitfalls()).toHaveLength(1); expect(pitfalls()[0]!.authorRole).toBe("reviewer");
  expect(local(true)).toMatchObject({ ok: true, duplicate: true });
  await run(); expect(pitfalls()).toHaveLength(1);
});

parentTest("local legacy client without pitfall still works; invalid fields stay rejected", async () => {
  expect(local("true")).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local(1)).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local()).toMatchObject({ ok: true }); await run(); expect(pitfalls()).toEqual([]);
});

parentTest("peer result through lend wire/lease/signature intake retains pitfall in stored events; resend is idempotent", async () => {
  const { call, result } = await peerOrder();
  const body = result(true); const first = await call("write", body); expect(first.ok).toBe(true);
  const e = listEvents(db, { project: P, target: "A" }).find((e) => e.kind === "review")!;
  expect(e.data.findings).toMatchObject([{ pitfall: true }]);
  await run(); expect(pitfalls()).toHaveLength(1);
  expect(pitfalls()[0]).toMatchObject({ author: "peer:mate", sources: [{ origin: "ab12", originSeq: e.originSeq }] });
  expect(await call("write", body)).toEqual(first); await run(); expect(pitfalls()).toHaveLength(1);
});

parentTest("peer old client works without optional pitfall; illegal pitfall is rejected before any review event", async () => {
  const { call, result } = await peerOrder();
  expect((await call("write", result("true"))).ok).toBe(false);
  expect(listEvents(db, { project: P }).filter((e) => e.kind === "review")).toEqual([]);
  expect((await call("write", result())).ok).toBe(true); await run(); expect(pitfalls()).toEqual([]);
});

parentTest("legacy persisted pitfall:false reads as an ordinary finding and does not invalidate review facts", () => {
  expect(local(false)).toMatchObject({ ok: true });
  const events = listEvents(db, { project: P, target: "A" }).map((e) => e.kind === "review" ? { ...e, data: { ...e.data,
    findings: (e.data.findings as object[]).map((f) => ({ ...f, pitfall: false })) } } : e);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ family: "widget-tx" }] } });
});

/** Full peer chain on one fixture; the receipt must be signed by that fixture's own generated key. */
async function peerChain(x: VerdictFixture) {
  const { call, result } = await x.peerOrder();
  const first = await call("write", result(true)); expect(first.ok).toBe(true);
  const r = first.receipt as LendReceipt;
  expect(r.key).toBe(x.key.publicKey);
  expect(verifyPurpose(x.key.publicKey, RECEIPT_PURPOSE, [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig)).toBe(true);
  await x.run(); expect(x.pitfalls()).toHaveLength(1);
  return r;
}

childTest("pollution child: a neighbour left task A in the shared :memory: ledger", async () => {
  const shared = openLedger(":memory:");
  try {
    createTask(shared, { actor: "owner" }, { project: P, id: "A", title: "left open by a neighbour", kind: "code" });
    if (childMode === "legacy") {
      const legacy = openLedger(":memory:");
      setMeta(legacy, { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm"] });
      createTask(legacy, { actor: "owner" }, { project: P, id: "A", title: "Atomic revision writes", kind: "code" });
    }
    expect(childMode).toBe("fixture");
    expect(getTask(db, "A")!.title).toBe("Atomic revision writes");
    await peerChain(fx!);
    expect(getTask(shared, "A")!.title).toBe("left open by a neighbour");
  } finally {
    closeLedger(":memory:");
  }
});

async function pollutionChild(mode: "legacy" | "fixture") {
  const root = mkdtempSync(join(tmpdir(), "memory-verdict-child-"));
  try {
    const [home, state, runtime, tmp] = ["home", "state", "runtime", "tmp"].map((d) => { const p = join(root, d); mkdirSync(p); return p; });
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
      env: testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime, [POLLUTION_CHILD]: mode }) });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, log: out + err };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

parentTest("isolation probe (child process): legacy setup on a polluted :memory: goes red; the private fixture stays green", async () => {
  const [legacy, fixture] = await Promise.all([pollutionChild("legacy"), pollutionChild("fixture")]);
  // The parent must see the child's own assertion failure and run count, not just "the process ran".
  expect(legacy.code).not.toBe(0);
  expect(legacy.log).toContain("任务 A 已存在");
  expect(legacy.log).toMatch(/\b0 pass\b/); expect(legacy.log).toMatch(/\b1 fail\b/);
  expect(legacy.log).toMatch(/Ran 1 test across 1 file/);
  expect(fixture.code).toBe(0);
  expect(fixture.log).toMatch(/\b1 pass\b/); expect(fixture.log).toMatch(/\b0 fail\b/);
  expect(fixture.log).toMatch(/Ran 1 test across 1 file/);
  expect(fixture.log).not.toMatch(/\b\d+ (skip|todo)\b/);
});

parentTest("isolation probe: a corrupted neighbour key does not leak into this fixture", async () => {
  const neighbour = verdictFixture();
  const neighbourKey = neighbour.key.publicKey;
  writeFileSync(join(neighbour.root, "identity", "instance-key.pem"), "not a pem");
  neighbour.dispose();
  expect(fx!.key.publicKey).not.toBe(neighbourKey);
  expect(getTask(db, "A")!.title).toBe("Atomic revision writes");
  await peerChain(fx!);
});

parentTest("isolation probe: two fixtures run the peer chain in parallel; disposing one leaves the other intact", async () => {
  const other = verdictFixture();
  try {
    const [mine, theirs] = await Promise.all([peerChain(fx!), peerChain(other)]);
    expect(mine.key).not.toBe(theirs.key);
    expect(other.ledgerPath).not.toBe(fx!.ledgerPath);
    other.dispose();
    expect(existsSync(other.root)).toBe(false);
    expect(() => other.db.query("SELECT 1").get()).toThrow();
    await run(); expect(pitfalls()).toHaveLength(1);
    expect(listEvents(db, { project: P, target: "A" }).filter((e) => e.kind === "review")).toHaveLength(1);
  } finally {
    other.dispose();
  }
});

parentTest("isolation probe: a setup failure after resources exist closes the ledger, removes the temp root and rethrows", () => {
  let root = "", seeded: Database | undefined;
  expect(() => verdictFixture({ seed: (d, r) => { seeded = d; root = r; throw new Error("seed boom"); } })).toThrow("seed boom");
  expect(root).not.toBe("");
  expect(existsSync(root)).toBe(false);
  expect(() => seeded!.query("SELECT 1").get()).toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
});

parentTest("isolation probe: setup and cleanup both failing keep the original setup error alongside the cleanup error", () => {
  let root = "", seeded: Database | undefined, close: (() => void) | undefined;
  let caught: unknown;
  try {
    verdictFixture({ seed: (d, r) => {
      seeded = d; root = r; close = d.close.bind(d);
      d.close = () => { throw new Error("cleanup boom"); };
      throw new Error("seed boom");
    } });
  } catch (e) { caught = e; } finally {
    if (seeded && close) { seeded.close = close; closeLedger(join(root, "ledger.sqlite")); }
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const [setupError, cleanupError] = (caught as AggregateError).errors;
  expect((caught as AggregateError).cause).toBe(setupError);
  expect((setupError as Error).message).toBe("seed boom");
  expect(cleanupError).toBeInstanceOf(AggregateError);
  expect((cleanupError as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["cleanup boom"]);
  expect(existsSync(root)).toBe(false);
  expect(() => seeded!.query("SELECT 1").get()).toThrow();
});
