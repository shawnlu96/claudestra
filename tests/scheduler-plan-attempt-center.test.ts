/**
 * S2F7 over the daemon's real pass entry (S2C fake center + S2Q): a central dispatch intent cancelled on the degraded path
 * (nothing retained) counts toward the next attempt, so the next round plans a fresh key instead of replaying the cancelled one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getTask } from "../src/lib/ledger-store.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { clearRetainedPlans } from "../src/lib/shared-ledger-v2-plan-retain.js";
import { commands, F, memberCards, until, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

const reset = async () => { await resetWorld(); clearRetainedPlans(); };
beforeEach(reset);
afterEach(reset);

type World = Awaited<ReturnType<typeof world>>;
const dispatches = (db: Database, taskId: string) =>
  db.query("SELECT id, status, recipient FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch' ORDER BY eventSeq").all(taskId) as
    { id: string; status: string; recipient: string | null }[];
const decide = (s: World, T: string) => planScheduler(observeSnapshot(s.db, getTask(s.db, T)!, { registry: [], maxWorkers: 2, now: Date.now() }));

async function ready(s: World) {
  const { T } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  s.db.query(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["src/x.ts"]')) WHERE id = ?`).run(T);
  return T;
}
/** `t68:s<since>:r<round>:restate:a<n>` → [the key up to `a`, n]. */
const split = (id: string): [string, number] => {
  const m = /^(t68:s\d+:r\d+:restate:a)(\d+)$/.exec(id);
  expect(m).not.toBeNull();
  return [m![1]!, Number(m![2])];
};
/** Every proposal is lost between S2Q's intent.create and the projection that lands it while `lose` is on. */
function loseProposals(s: World) {
  const state = { lose: true };
  const snapshot = s.wiring.snapshot.bind(s.wiring);
  s.wiring.snapshot = (...args) => { if (state.lose) clearRetainedPlans(); return snapshot(...args); };
  return state;
}

test("[验收线 1] a central dispatch cancelled on the degraded path is re-planned as a1, then a2, each written through S2Q", async () => {
  const s = await world(), T = await ready(s);
  loseProposals(s);
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  const [first] = dispatches(s.db, T);
  expect(first).toMatchObject({ status: "cancelled", recipient: null });
  const [prefix, a] = split(first!.id);
  // The next round's decision is a fresh key, not the cancelled one.
  expect(decide(s, T)).toMatchObject({ kind: "intent", action: "dispatch", id: `${prefix}${a + 1}` });
  for (const step of [1, 2]) {
    const before = s.requests.length;
    expect(await s.pass()).toEqual({ ran: true, failed: [] });
    expect(commands(s.requests.slice(before))).toEqual(["intent.create", "intent.cancel"]);
    expect(dispatches(s.db, T).map((d) => [d.id, d.status])).toEqual(
      Array.from({ length: step + 1 }, (_, k) => [`${prefix}${a + k}`, "cancelled"]));
  }
  expect(decide(s, T)).toMatchObject({ kind: "intent", action: "dispatch", id: `${prefix}${a + 3}` });
});

test("[验收线 1] after a cancelled central attempt the next proposal survives and lands claimed under the a1 key", async () => {
  const s = await world(), T = await ready(s), lost = loseProposals(s);
  await s.pass();
  lost.lose = false;
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  const sent = commands(s.requests.slice(before));
  expect(sent).toContain("intent.create");
  expect(sent).not.toContain("intent.cancel");
  const rows = dispatches(s.db, T);
  expect(rows).toHaveLength(2);
  const [prefix, a] = split(rows[0]!.id);
  expect(rows[1]).toMatchObject({ id: `${prefix}${a + 1}`, status: "submitted", recipient: "w-author" });
});
