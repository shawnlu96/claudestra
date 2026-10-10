/** S2F test world: a synthetic ledger + S2C fake center behind the real S2T transport, the scheduler wiring with the production
 * lease adapter, and fake worker / ensure ports for the daemon's pass entry (schedulerV2Pass). Local feature id = center id. */
import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { PassOpts } from "../src/lib/scheduler-pass.js";
import { withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import { sharedLedgerV2Bridge } from "../src/bridge/shared-ledger-v2-wiring.js";
import { initSchedulerV2, schedulerV2Pass, schedulerV2Wiring } from "../src/lib/scheduler-v2-wiring.js";
import { V2_COMMAND_NAMES, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import type { WorkerSession } from "../src/lib/worker-session.js";
import { ACTORS, approvedAsk, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

export const P = "s2-drill-e2e", F = "feature-exec";
const cleanups: (() => void)[] = [];
/** Each test file registers this before and after every test (hooks in an imported module bind only to its first importer).
 *  The daemon's pass entry starts the process's single wiring lazily, so another file may have left one running. */
export async function resetWorld(): Promise<void> {
  await schedulerV2Wiring()?.stop();
  sharedLedgerV2Bridge()?.stop();
  while (cleanups.length) cleanups.pop()!();
}

const all = (a: V2Actor): V2Actor => ({ ...a, actions: [...V2_COMMAND_NAMES] });

export async function world() {
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

  const requests: string[] = [], responses: string[] = [];
  const centerFetch = k.center.fetch((r) => r.headers.get("authorization")?.includes("owner-bearer") ? owner : null);
  const wiring = new Stage2Wiring({ dir, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    const body = r.method === "POST" ? await r.clone().text() : "";
    requests.push(`${r.method} ${new URL(r.url).pathname} ${body ? (JSON.parse(body) as { type?: string }).type ?? "" : ""}`.trim());
    const res = await centerFetch(r);
    if (r.method === "POST" && !res.ok) responses.push(`${requests.at(-1)} → ${res.status} ${await res.clone().text()}`);
    return res;
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
  return { k, owner, member, db, dir, w, wiring, requests, responses, ensured, sent, real, pass, deps, config, opts };
}

export async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10); }
}
export const fixture = (type: string) => structuredClone(V2_COMMAND_FIXTURES.find((c) => c.type === type)!.valid.payload) as Record<string, unknown>;
export const commands = (requests: string[]) => requests.filter((r) => r.startsWith("POST ")).map((r) => r.split(" ").pop());

/** Member card T (owner sets it auto) and control card C (no workflow), both created only in the center. */
export async function memberCards(s: Awaited<ReturnType<typeof world>>) {
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
export const intentsOf = (db: Database, taskId: string) =>
  db.query("SELECT id, action, status FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(taskId) as { id: string; action: string; status: string }[];

