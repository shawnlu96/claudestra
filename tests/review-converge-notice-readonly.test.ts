/**
 * state-protection-F2: the auto tick reads a query_only LedgerReader; a failed follow-up's PM notice is recorded through
 * `ledger scheduler-converge-notice`, so the next tick stays quiet and nothing writes to the read-only connection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { convergeFollowUp } from "../src/lib/review-converge-followup.js";
import { followUpFailureNotice } from "../src/lib/review-converge-notice.js";
import { convergeNoticeKey } from "../src/lib/review-converge-notice-write.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { createTask } from "../src/lib/ledger-write.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const NOTICE = "后续节点未建立";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

/** A real downgrade whose follow-up failed (T1 sits in no DAG), written by the production convergeFollowUp on the writer. */
function setup() {
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); });
  writeFileSync(join(f.dir, "report.md"), "F1: 降级发现\n");
  f.db.transaction(() => convergeFollowUp(f.db, { actor: "scheduler", now: 2000 }, f.task(), {
    round: 2, head: H1, reportPath: join(f.dir, "report.md"), items: [{ findingId: "F1", family: "other", probe: "src/y.ts:1", why: "no_basis" }],
  }, f.dir, () => true))();
  const downgrade = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "review_downgrade")!;
  expect(typeof downgrade.data.followUpFailure).toBe("string");
  const ro = reader.get()!;
  expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
  const told = () => f.notices.filter((n) => n.includes(NOTICE));
  return { f, ro, downgrade, told, key: convergeNoticeKey("T1", downgrade.seq) };
}

describe("failed follow-up notice on the read-only scheduler connection", () => {
  test("two auto ticks over the same downgrade: one notice, one informed record via the CLI, no readonly write", async () => {
    const { f, ro, downgrade, told, key } = setup();
    const errors: string[] = [];
    for (let i = 0; i < 2; i++) errors.push(...(await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed.map((x) => x.error));
    expect({ notices: told().length, readonlyErrors: errors.filter((e) => /readonly/.test(e)) }).toEqual({ notices: 1, readonlyErrors: [] });
    const rec = getEventByDedup(f.db, key)!;
    expect(rec).toMatchObject({ actor: "scheduler", kind: "scheduler", target: "T1", text: told()[0],
      data: { op: "review_followup_failed", downgradeSeq: downgrade.seq, informed: true } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_followup_failed")).toHaveLength(1);
  });

  test("a failed send records nothing; a failed record keeps it pending with backoff; lost lease stops the pass", async () => {
    const { f, ro, downgrade, told, key } = setup();
    const offline = { ...f.tickDeps, notifyPm: async () => { throw new Error("bridge down"); } };
    await followUpFailureNotice(ro, f.task(), offline);
    expect(getEventByDedup(f.db, key)).toBeNull();
    const calls: string[][] = [];
    const broken = { ...f.tickDeps, manager: async (...a: string[]) => { calls.push(a); return { ok: false, code: "busy", error: "库忙" }; } };
    await followUpFailureNotice(ro, f.task(), broken);
    await followUpFailureNotice(ro, f.task(), broken); // inside the backoff: no second notice, no second write
    expect(told()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(getEventByDedup(f.db, key)).toBeNull();
    f.advance(120_000);
    await followUpFailureNotice(ro, f.task(), f.tickDeps); // backoff over: retried, now recorded
    expect(told()).toHaveLength(2);
    expect(getEventByDedup(f.db, key)?.data.downgradeSeq).toBe(downgrade.seq);
    await followUpFailureNotice(ro, f.task(), f.tickDeps);
    expect(told()).toHaveLength(2);

    const g = setup();
    const lost = { ...g.f.tickDeps, manager: async () => ({ ok: false, code: "lease-lost", error: "失租" }) };
    await expect(followUpFailureNotice(g.ro, g.f.task(), lost)).rejects.toBeInstanceOf(SchedulerStopped);
    expect(getEventByDedup(g.f.db, g.key)).toBeNull();
  });

  test("the CLI only takes the scheduler, this card's own failed downgrade at its round/head, and replays idempotently", async () => {
    const { f, downgrade, key } = setup();
    const args = (task: string, seq: number, round = 2, head = H1) =>
      ["scheduler-converge-notice", task, "--downgrade-seq", String(seq), "--round", String(round), "--head", head];
    expect(await f.cli("pm", ...args("T1", downgrade.seq))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("agent-task-one", ...args("T1", downgrade.seq))).toMatchObject({ ok: false, code: "forbidden" });
    createTask(f.db, { actor: "owner", now: 3000 }, { project: "p", id: "T2", title: "other", kind: "code" });
    expect(await f.cli("scheduler", ...args("T2", downgrade.seq))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq - 1))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq, 3))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq, 2, "2".repeat(40)))).toMatchObject({ ok: false, code: "conflict" });
    const lease = await f.cliWith({ assertLease: () => { throw new SchedulerLeaseLost("gone"); } },
      "scheduler", ...args("T1", downgrade.seq));
    expect(lease).toMatchObject({ ok: false, code: "lease-lost" });
    expect(getEventByDedup(f.db, key)).toBeNull();
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq))).toMatchObject({ ok: true, duplicate: false });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq))).toMatchObject({ ok: true, duplicate: true });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_followup_failed")).toHaveLength(1);
  });
});
