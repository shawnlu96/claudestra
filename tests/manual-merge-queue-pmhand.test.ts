/**
 * PMHAND1 11b on the real ledger CLI + MQ1 world: a hold lets through a later manual-merge-request of whoever set it (manual merge
 * queue and the unified queue facts alike); another PM's request, an earlier request, or a PM under an owner hold still waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { manualTurn } from "../src/lib/manual-merge-queue.js";
import { mergeQueueFacts, type QueueFactsPorts } from "../src/lib/merge-queue-facts.js";
import { handbackSamplesDue, recordHandbackSample } from "../src/lib/pm-handback-sample.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", PM2 = "agent-pm2", DISP = "agent-disp";
const PORTS: QueueFactsPorts = { handoff: () => false, skip: () => false, repo: () => null };
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, PM2, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  writePolicy("on");
}
const hold = (id: string, actor: string) => insertEvent(w.db, { actor, now: Date.now() }, { project: "p", target: id, kind: "scheduler", text: "",
  data: { op: "workflow", mode: "manual", hold: `${actor} 先留人工` } }, false).seq;
const of = (id: string) => mergeQueueFacts(w.db, "p", Date.now(), PORTS).find((e) => e.taskId === id)!;

describe("[验收线 4] a hold is lifted only by its own setter's later request", () => {
  test("PM A holds, A requests: queued and ready in both queues, one hold_lift sample", async () => {
    setup();
    const m = await manualCard(w, "M");
    hold("M", PM);
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).not.toBe("none");
    expect(of("M")).toMatchObject({ source: "manual", state: "ready" });
    const due = handbackSamplesDue(w.db, "p");
    expect(due.map((s) => [s.type, s.taskId, s.head])).toEqual([["hold_lift", "M", m.head]]);
    expect(recordHandbackSample(w.db, due[0]!, Date.now())).toBe(true);
    expect(recordHandbackSample(w.db, due[0]!, Date.now())).toBe(false); // card + head + type dedup
    expect(handbackSamplesDue(w.db, "p")).toEqual([]);
  });

  test("PM B's request under A's hold, and a PM's request under an owner hold, still wait owner_hold", async () => {
    setup();
    const b = await manualCard(w, "B");
    hold("B", PM);
    expect(await ledgerAs(w, PM2, ...requestArgs(b))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/留在人工/) });
    expect(of("B")).toMatchObject({ state: "blocked", reason: { code: "owner_hold" } });
    const o = await manualCard(w, "O");
    hold("O", "owner");
    expect(await ledgerAs(w, PM, ...requestArgs(o))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/留在人工/) });
    expect(of("O")).toMatchObject({ state: "blocked", reason: { code: "owner_hold" } });
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("none");
    expect(handbackSamplesDue(w.db, "p")).toEqual([]);
  });

  test("a request filed before the hold does not lift it, even by the same PM", async () => {
    setup();
    const e = await manualCard(w, "E");
    expect(await ledgerAs(w, PM, ...requestArgs(e))).toMatchObject({ ok: true, state: "queued" });
    hold("E", PM);
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("none");
    expect(of("E")).toMatchObject({ reason: { code: "owner_hold" } });
  });
});
