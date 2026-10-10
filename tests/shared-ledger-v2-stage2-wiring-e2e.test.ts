/**
 * S2F acceptance 3 over the daemon's real pass entry: S2C fake center + S2T signed transport + the production lease adapter
 * (no injected leases) + `schedulerV2Pass` → real `schedulerPass` (schedulerAutoTick, mergeTick) with fake worker / ensure ports.
 * A member's `task.new` and the owner's `workflow.set auto` land through the pre-pass projection only.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { PassOpts } from "../src/lib/scheduler-pass.js";
import { withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import { initSchedulerV2, schedulerV2Pass, schedulerV2Wiring } from "../src/lib/scheduler-v2-wiring.js";
import { V2_COMMAND_NAMES, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import type { WorkerSession } from "../src/lib/worker-session.js";
import { ACTORS, approvedAsk, EXEC_TASK, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const P = "s2-drill-e2e", F = "feature-exec", cleanups: (() => void)[] = [];
afterEach(async () => { await schedulerV2Wiring()?.stop(); while (cleanups.length) cleanups.pop()!(); });

const all = (a: V2Actor): V2Actor => ({ ...a, actions: [...V2_COMMAND_NAMES] });

async function world() {
  const k = kit(), owner = all(ACTORS.owner), member = all(ACTORS.member);
  const dir = mkdtempSync(join(tmpdir(), "s2f-e2e-")), path = join(dir, "ledger.sqlite"), db: Database = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('feature-exec',?,'synthetic','active','owner',1,1)").run(P);
  db.query("INSERT INTO meta (project, key, value) VALUES (?, 'pms', '[\"pm\"]')").run(P);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-exec": { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: "center", ...V2_FIXTURE_SCOPE, centerFeatureId: "feature-exec", epoch: 1 } } } }), { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: "center", ...V2_FIXTURE_SCOPE, localProjectId: P }]), { mode: 0o600 });
  await writeSharedLedgerCredential({ localSubject: "owner:self", kind: "person", centerId: "center", baseUrl: "https://center.invalid",
    ...V2_FIXTURE_SCOPE, personId: "person", instanceId: "local", bearer: "owner-bearer",
    projects: [{ projectId: V2_FIXTURE_SCOPE.projectId, actions: ["read", "plan"] }] }, dir);
  await writeStage2Release(P, { kind: "drill", askId: "ask-exec", grantedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, dir);
  await writeStage2Switch(P, "on", dir);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ agents: { "w-author": { runtime: "codex", kind: "worker", status: "active", sessionId: "sess-a" } } }));

  const requests: string[] = [];
  const centerFetch = k.center.fetch((r) => r.headers.get("authorization")?.includes("owner-bearer") ? owner : null);
  const wiring = new Stage2Wiring({ dir, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    const body = r.method === "POST" ? await r.clone().text() : "";
    requests.push(`${r.method} ${new URL(r.url).pathname} ${body ? (JSON.parse(body) as { type?: string }).type ?? "" : ""}`.trim());
    return centerFetch(r);
  }) as typeof fetch });
  const w = initSchedulerV2({ wiring, db: () => db, instanceId: () => "local", registryPath });

  // Fake worker / session ports: the only effects outside the ledger.
  const ensured: string[] = [], sent: string[] = [], real: string[][] = [];
  const worker: WorkerSession = {
    route: "acp", fallbackReason: null,
    ensure: async () => ({ kind: "wait", reason: "n/a" }),
    submit: async (_ref, intentId) => { sent.push(intentId); return { status: "accepted", route: "acp", messageId: `m-${intentId}` } as never; },
    observe: async () => ({ live: "idle" }) as never,
    cancel: async () => ({ ok: true, evidence: "c" }), archive: async () => ({ ok: true, evidence: "a" }),
  };
  const deps = (): AutoTickDeps => withSchedulerV2Intents({
    manager: async (...args) => { real.push(args); return { ok: true }; },
    worker: () => worker,
    ensure: async (task, role, family) => {
      ensured.push(`${task.id}:${role}`);
      return { kind: "ready", created: true, ref: { taskId: task.id, role, agent: "w-author", sessionId: "sess-a", family, transport: "acp" } };
    },
    pinReview: async () => ({ dir }), reviewDirty: async () => null, notifyPm: async () => {}, now: Date.now,
  });
  const config: SchedulerConfig = { enabled: true, autoDispatch: true, pollMs: 1000, projects: {
    [P]: { repoDir: dir, maxActiveWorkers: 2, requiredChecks: ["ci"], mergeTrain: "off" } } };
  const opts: PassOpts = {
    assertOwner: () => {}, maintenance: { path: join(dir, "maintenance"), marker: join(dir, "marker"), request: join(dir, "request") },
    manager: async (...args) => { real.push(args); return { ok: true }; },
    peerPr: async () => ({ failed: [] }), autostart: () => ({ start: async () => [], resume: async () => [] }),
    lockYield: async () => [], retire: async () => [], lifecycle: async () => [], autoDeps: deps,
    external: () => { throw new Error("no merge in this round"); },
  };
  const pass = () => schedulerV2Pass(db, config, opts);
  return { k, owner, member, db, dir, w, requests, ensured, sent, real, pass, deps, config };
}

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10); }
}
const fixture = (type: string) => structuredClone(V2_COMMAND_FIXTURES.find((c) => c.type === type)!.valid.payload) as Record<string, unknown>;
const commands = (requests: string[]) => requests.filter((r) => r.startsWith("POST ")).map((r) => r.split(" ").pop());

/** Member card T (owner sets it auto) and control card C (no workflow), both created only in the center. */
async function memberCards(s: Awaited<ReturnType<typeof world>>) {
  const created = (title: string) => {
    const r = s.k.post(s.member, s.k.command("task.new", { ...fixture("task.new"), featureId: F, itemId: null, title }));
    expect(r.status).toBe(200);
    return (r.body as { result: { entityId: string } }).result.entityId;
  };
  const T = created("member card"), C = created("control card");
  s.k.center.seed({ asks: [approvedAsk("ask-auto", F, T)] });
  expect(s.k.post(s.owner, s.k.command("workflow.set", { taskId: T, expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1,
    template: "code", templateVersion: 2, mode: "auto", authorFamily: "codex", fallback: ["claude"], authorizationAskId: "ask-auto" })).status).toBe(200);
  return { T, C };
}
const intentsOf = (db: Database, taskId: string) =>
  db.query("SELECT id, action, status FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(taskId) as { id: string; action: string; status: string }[];

test("acceptance 3 · pass 1: the pre-pass lands a member's center-only card, S2Q runs ensure → bind → done with 0 center commands", async () => {
  const s = await world();
  const { T, C } = await memberCards(s);
  // The production lease adapter (no injected leases) acquires through the signed transport.
  await until(() => s.w.leases.current(F) !== null);
  expect(commands(s.requests)).toContain("lease.acquire");
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  // Projection reads only; the new card's lease is added under the same term; no intent / result command.
  expect(commands(s.requests.slice(before)).filter((c) => c !== "lease.acquire")).toEqual([]);
  expect(getTask(s.db, T)).toMatchObject({ featureId: F, stage: "spec" });
  expect(s.ensured).toEqual([`${T}:author`]);
  expect(intentsOf(s.db, T)).toEqual([{ id: expect.any(String), action: "ensure_session", status: "done" }]);
  expect(s.db.query("SELECT agent, state FROM scheduler_sessions WHERE taskId = ?").all(T)).toEqual([{ agent: "w-author", state: "active" }]);
  // Every scheduler event of the card was written under S2G's executor token (fence with leaseId), none outside it.
  const events = s.db.query("SELECT data FROM events WHERE target = ? AND kind = 'scheduler'").all(T) as { data: string }[];
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) expect(JSON.parse(e.data).fence).toMatchObject({ bootId: s.w.leases.current(F)!.bootId, leaseId: expect.any(String) });
  expect(s.real).toHaveLength(0);
  expect(intentsOf(s.db, C)).toEqual([]);
});

test("acceptance 3 · pass 2: dispatch becomes a center intent through S2Q (planData) and lands back through the projection", async () => {
  const s = await world();
  const { T, C } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  // Test-only fixture (PM 04:5x): the card's home-only fileGlobs, standing in for S2F3's future source; not a pass write.
  s.db.query(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["src/x.ts"]')) WHERE id = ?`).run(T);
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(commands(s.requests.slice(before))).toContain("intent.create");
  const center = [...s.k.center.rows().intents.values()].filter((i) => i.taskId === T);
  expect(center.map((i) => [i.action, i.resources])).toEqual([["dispatch",
    [{ ...V2_FIXTURE_SCOPE, repository: "team/repository", kind: "file", path: "src/x.ts" }]]]);
  // The projection keys the local row by the center's operationId = the home plan id; the ensure intent / session survive.
  expect(intentsOf(s.db, T).map((i) => [i.id, i.action])).toEqual([[expect.any(String), "ensure_session"], [center[0]!.operationId, "dispatch"]]);
  expect(s.db.query("SELECT state FROM scheduler_sessions WHERE taskId = ?").all(T)).toEqual([{ state: "active" }]);
  expect(s.real).toHaveLength(0);
  expect(intentsOf(s.db, C)).toEqual([]);
  expect([...s.k.center.rows().intents.values()].filter((i) => i.taskId === C)).toEqual([]);
});

test("planner origin: a card whose only task events are absent projections still escalates task_origin", async () => {
  const s = await world();
  const { T } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  const { planScheduler } = await import("../src/lib/scheduler-plan.js");
  const { observeSnapshot } = await import("../src/lib/scheduler-snapshot.js");
  const snapshot = observeSnapshot(s.db, getTask(s.db, T)!, { registry: [], maxWorkers: 2, now: Date.now() });
  expect(planScheduler(snapshot)).not.toMatchObject({ code: "task_origin" });
  // Events are append-only: the absent-only card is the same snapshot with every task event marked absent.
  const absentOnly = { ...snapshot, events: snapshot.events.map((e) => e.kind === "task" ? { ...e, data: { ...e.data, absent: true } } : e) };
  expect(planScheduler(absentOnly)).toMatchObject({ code: "task_origin" });
});
