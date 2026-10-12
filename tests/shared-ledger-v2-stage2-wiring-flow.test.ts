/**
 * S2F acceptance 3 (partial, see the todo below): the composition root over S2C (fake center) + S2T (real signed transport
 * through the center's fetch adapter) + S2P (real projection writer) + S2Q (real ledger commands) + S2G (real executor token).
 * The owner's `workflow.set auto` lands through a projection sync, paceCards selects the card, and the ensure_session plan /
 * claim go through the same S2Q instance both scheduler managers get, under S2G's token, with zero center requests.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { schedulerV2PassManager } from "../src/lib/scheduler-v2-pass.js";
import { withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import { initSchedulerV2, schedulerV2Wiring } from "../src/lib/scheduler-v2-wiring.js";
import { paceCards } from "../src/lib/scheduler-yield.js";
import { V2_COMMAND_NAMES } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import { ACTORS, EXEC_TASK, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const P = "s2-drill-flow", cleanups: (() => void)[] = [];
beforeEach(async () => { await schedulerV2Wiring()?.stop(); }); // see the wiring fixture: a lazily started daemon wiring may linger
afterEach(async () => { await schedulerV2Wiring()?.stop(); while (cleanups.length) cleanups.pop()!(); });

async function flow() {
  const k = kit();
  const owner = { ...ACTORS.owner, actions: [...V2_COMMAND_NAMES] };
  expect(k.post(owner, k.command("workflow.set", { ...EXEC_TASK, template: "code", templateVersion: 1, mode: "auto",
    authorFamily: "codex", fallback: [], authorizationAskId: "ask-exec" })).status).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), "s2f-flow-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f',?,'synthetic','active','owner',1,1)").run(P);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { f: { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: "center", ...V2_FIXTURE_SCOPE, centerFeatureId: "feature-exec", epoch: 1 } } } }), { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: "center", ...V2_FIXTURE_SCOPE, localProjectId: P }]), { mode: 0o600 });
  await writeSharedLedgerCredential({ localSubject: "owner:self", kind: "person", centerId: "center", baseUrl: "https://center.invalid",
    ...V2_FIXTURE_SCOPE, personId: "person", instanceId: "local", bearer: "owner-bearer",
    projects: [{ projectId: V2_FIXTURE_SCOPE.projectId, actions: ["read", "plan"] }] }, dir);
  await writeStage2Release(P, { kind: "drill", askId: "ask-exec", grantedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, dir);
  await writeStage2Switch(P, "on", dir);
  const requests: string[] = [];
  const centerFetch = k.center.fetch((r) => r.headers.get("authorization")?.includes("owner-bearer") ? owner : null);
  const wiring = new Stage2Wiring({ dir, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    requests.push(`${r.method} ${new URL(r.url).pathname}`);
    return centerFetch(r);
  }) as typeof fetch });
  let fence: typeof V2_FIXTURE_FENCE | null = { ...V2_FIXTURE_FENCE };
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ agents: { worker: { runtime: "codex", kind: "worker", status: "active" } } }));
  const w = initSchedulerV2({ wiring, db: () => db, instanceId: () => "local", registryPath,
    leases: { current: (featureId) => featureId === "f" && fence ? { ...fence } : null, stop: async () => {} } });
  const real: string[][] = [];
  const manager = w.wrapManager(async (...args) => { real.push(args); return { ok: true }; });
  return { k, db, dir, w, wiring, manager, real, requests, setFence: (f: typeof fence) => { fence = f; } };
}

const TASK = EXEC_TASK.taskId;
const planArgs = (db: import("bun:sqlite").Database, id: string) => {
  const t = getTask(db, TASK)!, seq = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
  return ["ledger", "scheduler-plan", TASK, "--id", id, "--rev", String(t.rev), "--workflow-rev", "2", "--seq", String(seq),
    "--node", "write", "--action", "ensure_session", "--reason", "cold start", "--resources", "task:s1"];
};

test("projection sync lands the owner's auto workflow; paceCards selects the card; local action under S2G with zero center requests", async () => {
  const s = await flow();
  expect(s.w.route(TASK)).toBe("local"); // not projected yet: no local card
  await s.w.sync(P, "f");
  expect(s.requests.every((r) => r.startsWith("GET "))).toBe(true); // sync only reads the center
  expect(getTask(s.db, TASK)).toMatchObject({ featureId: "f" });
  expect(s.w.route(TASK)).toBe("central");
  expect(paceCards(s.db, { [P]: {} }, "auto").map((c) => c.taskId)).toEqual([TASK]);

  const before = s.requests.length;
  expect(await s.manager(...planArgs(s.db, "ensure-1"))).toMatchObject({ ok: true });
  expect(await s.manager("ledger", "scheduler-settle", "ensure-1", "--from", "pending", "--to", "submitted", "--receipt", "claim"))
    .toMatchObject({ ok: true, intent: { status: "submitted" } });
  expect(s.requests.length).toBe(before); // home-local action: no center request
  expect(s.real).toHaveLength(0); // never the real manager
  const events = s.db.query("SELECT data FROM events WHERE kind='scheduler' ORDER BY seq").all() as { data: string }[];
  for (const e of events) expect(JSON.parse(e.data).fence).toMatchObject({ ...V2_FIXTURE_FENCE, leaseId: expect.stringMatching(/^lease-/) });
  expect(s.db.query("SELECT intentId FROM scheduler_resources WHERE intentId='ensure-1'").all()).toHaveLength(1);

  // A projection sync between ticks keeps the local action intent and its lock (S2P retention), no FK error.
  s.k.center.advance(1);
  await s.w.sync(P, "f");
  expect(getIntent(s.db, "ensure-1")).toMatchObject({ status: "submitted" });
  expect(s.db.query("SELECT intentId FROM scheduler_resources WHERE intentId='ensure-1'").all()).toHaveLength(1);

  // Both scheduler managers are wrapped by the same S2Q port: the pass manager and the auto-tick manager refuse the same way.
  const passed: string[][] = [], spy = async (...a: string[]) => { passed.push(a); return { ok: true }; };
  s.setFence(null);
  expect(await schedulerV2PassManager(spy)(...planArgs(s.db, "ensure-2"))).toEqual({ ok: false, code: "lease_lost" });
  const deps = withSchedulerV2Intents({ manager: spy } as never);
  expect(await deps.manager(...planArgs(s.db, "ensure-3"))).toEqual({ ok: false, code: "lease_lost" });
  expect(passed).toHaveLength(0);
});

// r1 s2f-executor-bind-fence-shape: S2G stamps leaseId on the claim fence; S2Q must still bind under the same term.
test("real S2G scope: ensure_session → settle submitted → session-bind answers ok, then settle done", async () => {
  const s = await flow();
  await s.w.sync(P, "f");
  expect(await s.manager(...planArgs(s.db, "ensure-1"))).toMatchObject({ ok: true });
  expect(await s.manager("ledger", "scheduler-settle", "ensure-1", "--from", "pending", "--to", "submitted", "--receipt", "claim"))
    .toMatchObject({ ok: true });
  expect(await s.manager("ledger", "scheduler-session-bind", TASK, "--role", "author", "--intent", "ensure-1", "--agent", "worker",
    "--session", "sess-1", "--family", "codex", "--transport", "tmux")).toMatchObject({ ok: true });
  expect(await s.manager("ledger", "scheduler-settle", "ensure-1", "--from", "submitted", "--to", "done", "--receipt", "bound"))
    .toMatchObject({ ok: true, intent: { status: "done" } });
  expect(s.real).toHaveLength(0);
});

test("lease lost: a central card's local action writes nothing", async () => {
  const s = await flow();
  await s.w.sync(P, "f");
  s.setFence(null);
  const seq = (s.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
  expect(await s.manager(...planArgs(s.db, "ensure-1"))).toEqual({ ok: false, code: "lease_lost" });
  expect((s.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s).toBe(seq);
});
