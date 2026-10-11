/**
 * S2F4 over the daemon's real pass entry (S2F world: S2C fake center + S2T transport + production lease adapter + S2Q): a
 * dispatch planned through the real central path lands with the home's recipient and its original proposal, so the driver
 * claims it instead of cancelling it, and a replay of the same key compares against the home decision.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { clearRetainedPlans, retainedPlanCount, type RetainedPlan } from "../src/lib/shared-ledger-v2-plan-retain.js";
import { commands, F, memberCards, until, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

const reset = async () => { await resetWorld(); clearRetainedPlans(); };
beforeEach(reset);
afterEach(reset);

type World = Awaited<ReturnType<typeof world>>;
type Row = { id: string; status: string; recipient: string | null; reason: string; causalSeq: number };
const dispatches = (db: Database, taskId: string) =>
  db.query("SELECT id, status, recipient, reason, causalSeq FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch' ORDER BY eventSeq").all(taskId) as Row[];
const planEvents = (db: Database, taskId: string) =>
  (db.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND json_extract(data, '$.op') = 'center-plan'").get(taskId) as { n: number }).n;

/** Pass 1 binds the author session; the card then has everything the planner needs for a dispatch on the next pass. */
async function ready(s: World) {
  const { T } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  s.db.query(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["src/x.ts"]')) WHERE id = ?`).run(T);
  return T;
}
const replayArgs = (taskId: string, p: RetainedPlan, patch: Partial<RetainedPlan> = {}) => {
  const q = { ...p, ...patch };
  return ["ledger", "scheduler-plan", taskId, "--id", q.id, "--rev", String(q.taskRev), "--workflow-rev", String(q.workflowRev), "--seq", String(q.causalSeq),
    "--node", q.node, "--action", q.action, "--recipient", q.recipient!, "--reason", q.reason, "--resources", q.resources.join(",")];
};

test("[验收线 1] [验收线 8] a dispatch planned through the real S2Q central path lands with the session's agent as recipient and is claimed, not cancelled", async () => {
  const s = await world(), T = await ready(s), before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  const sent = commands(s.requests.slice(before));
  expect(sent).toContain("intent.create");
  // The driver agreed with the intent and claimed it (S2I's intent.check); the old code cancelled it here (intent.cancel).
  expect(sent).toContain("intent.check");
  expect(sent).not.toContain("intent.cancel");
  const [row] = dispatches(s.db, T);
  expect(row).toMatchObject({ recipient: "w-author", status: "submitted" });
  expect(JSON.stringify(dispatches(s.db, T))).not.toContain("意图收件人与 session 不一致");
  // The proposal event sits under the projection actor in the same projection; the entry is released after the commit.
  const event = getEventByDedup(s.db, `scheduler:${row!.id}`)!;
  expect(event).toMatchObject({ actor: "shared-ledger-v2-projection", kind: "scheduler", target: T });
  expect(event.data).toMatchObject({ op: "center-plan", plan: { id: row!.id, taskId: T, node: "restate", action: "dispatch", recipient: "w-author" } });
  expect(retainedPlanCount()).toBe(0);
  expect(s.responses).toEqual([]);
});

test("[验收线 3] replaying the same key and decision is a duplicate although the center's reason / causalSeq differ; another decision is dedup_mismatch", async () => {
  const s = await world(), T = await ready(s);
  await s.pass();
  const [row] = dispatches(s.db, T), plan = getEventByDedup(s.db, `scheduler:${row!.id}`)!.data.plan as RetainedPlan;
  // Home keys, sorted and unique: the slot / card locks stay local and still belong to the decision; no center structure key.
  expect(plan.resources).toEqual([...new Set(plan.resources)].sort());
  expect(plan.resources).toContain("src/x.ts");
  expect(plan.resources.every((r) => typeof r === "string" && !r.startsWith("{") && !r.startsWith("["))).toBe(true);
  expect([row!.reason, row!.causalSeq]).not.toEqual([plan.reason, plan.causalSeq]);
  const manager = s.w.wrapManager(async () => ({ ok: false, code: "passthrough" }));
  const before = s.requests.length;
  expect(await manager(...replayArgs(T, plan))).toMatchObject({ ok: true, duplicate: true, intent: { id: row!.id, recipient: "w-author" } });
  for (const patch of [{ reason: `${plan.reason}!` }, { recipient: "someone-else" }, { causalSeq: plan.causalSeq + 1 }, { node: "write" },
    { resources: [...plan.resources, "src/y.ts"] }] as Partial<RetainedPlan>[]) {
    expect(await manager(...replayArgs(T, plan, patch))).toEqual({ ok: false, code: "dedup_mismatch" });
  }
  // A replay is answered from the ledger: no center request, no second plan event.
  expect(commands(s.requests.slice(before))).toEqual([]);
  expect(planEvents(s.db, T)).toBe(1);
});

test("[验收线 4] nothing retained (restart): null recipient, no plan event, one intent.cancel, later passes do not throw", async () => {
  const s = await world(), T = await ready(s);
  // The proposal is lost between S2Q's intent.create and the projection that lands it.
  const snapshot = s.wiring.snapshot.bind(s.wiring);
  s.wiring.snapshot = (...args) => { clearRetainedPlans(); return snapshot(...args); };
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(commands(s.requests.slice(before))).toEqual(["intent.create", "intent.cancel"]);
  expect(dispatches(s.db, T)).toEqual([{ id: expect.any(String), status: "cancelled", recipient: null, reason: expect.stringContaining("未投递"), causalSeq: expect.any(Number) }]);
  expect(planEvents(s.db, T)).toBe(0);
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(commands(s.requests.slice(before)).filter((c) => c === "intent.cancel")).toHaveLength(1);
});

test("[验收线 4] nothing retained and the center refuses the cancel: the intent stays pending, nothing throws", async () => {
  const s = await world(), T = await ready(s);
  const snapshot = s.wiring.snapshot.bind(s.wiring), clientFor = s.wiring.clientFor.bind(s.wiring);
  s.wiring.snapshot = (...args) => { clearRetainedPlans(); return snapshot(...args); };
  s.wiring.clientFor = (who, project) => {
    const client = clientFor(who, project);
    return client && Object.assign(Object.create(client) as typeof client, { command: async (command: { type: string }) => {
      if (command.type === "intent.cancel") throw Object.assign(new Error("center down"), { code: "unavailable" });
      return client.command(command as never);
    } });
  };
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(dispatches(s.db, T)).toMatchObject([{ status: "pending", recipient: null }]);
  expect(planEvents(s.db, T)).toBe(0);
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(dispatches(s.db, T)).toMatchObject([{ status: "pending", recipient: null }]);
});
