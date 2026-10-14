/** X15 e2e world: one S2C fake center served on a 127.0.0.1 port, three isolated instances (本机 = home + owner, peer A = member,
 * peer B = executor), each with its own temp dir, mode file, signed S2T transport, X7 exec gate / client, X7 local outbox, read
 * cache and X8 journal. Merges run a fake `gh` from the drill's own bin dir; nothing reaches GitHub, a production bridge or the
 * production state directory. The center implementation lives in the private repo: `task.deliver` / `task.review` and the X9
 * home-proxy admission of `lend.claim` / `lend.result` below are center semantics the fake center does not model yet (test fixture
 * only, not a center reference).
 * This file holds no test; the e2e files import it (the wiring-world precedent).
 */
import { expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSchedulerCentral, type SchedulerCentralOutcome } from "../src/lib/scheduler-central.js";
import { parseSchedulerCentralContext, type SchedulerCentralContext, type SchedulerCentralObservation } from "../src/lib/scheduler-central-context.js";
import { SchedulerCentralJournal, type SchedulerCentralJournalEntry } from "../src/lib/scheduler-central-journal.js";
import { SharedLedgerCache } from "../src/lib/shared-ledger-cache.js";
import {
  fail, parseCommand, v2ObjectDigest, V2_COMMAND_NAMES, type V2Actor, type V2Command, type V2CommandName, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { SharedLedgerExecClient } from "../src/lib/shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "../src/lib/shared-ledger-exec-gate.js";
import { SharedLedgerExecLocal } from "../src/lib/shared-ledger-exec-local.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { createStage2Transport, type Stage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { COMMAND_HANDLERS, type CommandContext, type CommandHandlers } from "./helpers/shared-ledger-v2-fake-center-commands.js";
import { executionAt, must, requireLease } from "./helpers/shared-ledger-v2-fake-center-state.js";
import { ACTORS, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

export const F = "feature-exec", REPO = "team/repository", PR = 7;
/** H0 = the base head the write order starts from, H1 = peer B's delivery, MERGED = the merge commit fake gh reports. */
export const H0 = "b".repeat(40), H1 = "c".repeat(40), MERGED = "d".repeat(40), D = "a".repeat(64);
export const RESOURCE = [{ ...V2_FIXTURE_SCOPE, repository: REPO, kind: "file", path: "src/example.ts" }];
export const LABELS = { local: "本机", "peer-a": "peer A", "peer-b": "peer B" } as const;
export type InstanceId = keyof typeof LABELS;

/** X9 home proxy: the order's home, as that order's scoped lend service, submits for the executor its claim / result names; the
 * executor-side rules then apply unchanged. Any other actor goes through the fake center's own handler as before. */
function viaHome<K extends "lend.claim" | "lend.result">(type: K, of: (c: CommandContext<K>) => { orderId: string; executorInstanceId: string }) {
  return (ctx: CommandContext<K>) => {
    const p = of(ctx), a = ctx.actor, order = must(ctx.state.orders.get(p.orderId));
    const proxied = a.kind === "service" && a.serviceId === "lend" && a.orderId === order.orderId && a.instanceId === order.homeInstanceId
      && a.actions.includes(type);
    return (COMMAND_HANDLERS[type] as (c: CommandContext<K>) => ReturnType<NonNullable<CommandHandlers[K]>>)(
      proxied ? { ...ctx, actor: { ...a, instanceId: p.executorInstanceId } } : ctx);
  };
}

/** Minimal delivery / review semantics: home only, live lease, the order the step rode on is settled at the same head. */
export const E2E_HANDLERS: CommandHandlers = {
  "lend.claim": viaHome("lend.claim", c => c.command.payload.claim),
  "lend.result": viaHome("lend.result", c => c.command.payload.result),
  "task.deliver": ctx => {
    const p = ctx.command.payload, task = executionAt(ctx, p);
    requireLease(ctx.state, p.taskId, ctx.command, ctx.now);
    if (!["build", "fix"].includes(task.stage) || p.round !== task.round) fail("conflict");
    const order = p.orderId === null ? null : must(ctx.state.orders.get(p.orderId));
    if (order && (order.status !== "done" || order.taskId !== task.id || order.leaseGen !== p.leaseGen)) fail("stale_order");
    const next = { ...task, stage: "review" as const, head: p.head, rev: task.rev + 1, updatedAt: ctx.now,
      delivery: { orderId: p.orderId, summary: p.summary, artifactIds: p.artifactIds } };
    ctx.state.tasks.set(task.id, next);
    return { entityId: task.id, rev: next.rev, specRev: next.specRev };
  },
  "task.review": ctx => {
    const p = ctx.command.payload, task = executionAt(ctx, p);
    requireLease(ctx.state, p.taskId, ctx.command, ctx.now);
    if (task.stage !== "review" || task.head !== p.head || p.round !== task.round) fail("conflict");
    const order = p.orderId === null ? null : must(ctx.state.orders.get(p.orderId));
    if (order && (order.status !== "done" || order.head !== p.head || order.leaseGen !== p.leaseGen)) fail("stale_order");
    const next = { ...task, stage: p.verdict === "pass" ? "merge" as const : "fix" as const, rev: task.rev + 1, updatedAt: ctx.now,
      review: { verdict: p.verdict, reviewedHead: p.head, reportArtifactId: p.reportArtifactId } };
    ctx.state.tasks.set(task.id, next);
    return { entityId: task.id, rev: next.rev, specRev: next.specRev };
  },
};

const roots: string[] = [];
const servers: { stop(): void }[] = [];
/** Each e2e file registers this in afterEach: stops every center port and removes every drill root. */
export function cleanupWorlds(): void {
  for (const s of servers.splice(0)) s.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

const pair = generateKeyPairSync("ed25519");
const KEY = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const bearer = (id: InstanceId) => `x15-${id}-bearer-0123456789`;
/** What a separate process on that instance needs to open its own signed transport (it generates its own instance key). */
export const connectionOf = (w: { center: { baseUrl: string } }, id: InstanceId, actor: V2Actor) => ({ centerId: "center",
  baseUrl: w.center.baseUrl, teamId: "team", personId: actor.personId, instanceId: actor.instanceId, bearer: bearer(id) });
const CENTER_ACTORS: Record<string, V2Actor> = { [bearer("local")]: ACTORS.owner, [bearer("peer-a")]: ACTORS.member, [bearer("peer-b")]: ACTORS.executor };
/** 本机's order-scoped lend service (what the bridge's lend API signs as for one order): its own bearer, the home's instance key. */
export function lendServiceTransport(w: { center: { baseUrl: string } }, orderId: string) {
  const actor: V2Actor = { kind: "service", personId: ACTORS.owner.personId, instanceId: "local", serviceId: "lend",
    representedPersonId: ACTORS.owner.personId, orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] };
  const token = `x15-local-lend-${orderId}-0123456789`;
  CENTER_ACTORS[token] = actor;
  const transport = createStage2Transport({ key: KEY, projectId: "project", connection: { centerId: "center", baseUrl: w.center.baseUrl,
    teamId: "team", personId: actor.personId, instanceId: actor.instanceId, bearer: token } });
  return { actor, transport };
}

/** The center behind a real local port. A lost response (commit, then no answer) reaches the caller as a 502, which the
 * transport classifies like any network loss (unavailable); `down()` closes the port so connections are refused outright. */
function serveCenter(k: ReturnType<typeof kit>) {
  const handler = k.center.fetch(r => CENTER_ACTORS[(r.headers.get("authorization") ?? "").replace(/^Bearer /, "")] ?? null);
  const fetch = async (r: Request) => {
    try { return await handler(r); } catch (e) { if (e instanceof TypeError) return new Response(null, { status: 502 }); throw e; }
  };
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  const port = server.port;
  const ctl = {
    baseUrl: `http://127.0.0.1:${port}`, up: true,
    down() { server.stop(true); ctl.up = false; },
    restore() { server = Bun.serve({ hostname: "127.0.0.1", port, fetch }); ctl.up = true; },
    stop() { if (ctl.up) server.stop(true); ctl.up = false; },
  };
  servers.push(ctl);
  return ctl;
}

type FeatureView = Awaited<ReturnType<Stage2Transport["snapshot"]>>;
function instance(root: string, id: InstanceId, actor: V2Actor, role: "owner" | "member", baseUrl: string, now: () => number) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const transport = createStage2Transport({ key: KEY, projectId: "project", connection: { centerId: "center", baseUrl,
    teamId: "team", personId: actor.personId, instanceId: actor.instanceId, bearer: bearer(id) } });
  const identity: ExecIdentity = { centerId: "center", teamId: "team", projectId: "project", projectRole: role,
    registeredPersonId: actor.personId, registeredInstanceId: actor.instanceId, actor: { ...actor, actions: [...V2_COMMAND_NAMES] } };
  let view: FeatureView | null = null, n = 0;
  const bootId = "boot-local";
  const fence = () => ({ serviceGeneration: view?.serviceGeneration ?? 1, epoch: view?.feature.epoch ?? 1, bootId });
  const gate = new SharedLedgerExecGate({ modeDirectory: dir, identity: () => identity,
    context: () => ({ feature: must(view?.feature), fence: fence(), orderId: null }) });
  const cache = new SharedLedgerCache<FeatureView>();
  let ticket = cache.select({ centerId: "center", teamId: "team", personId: actor.personId, projectId: "project" });
  const inst = {
    id, label: LABELS[id], dir, actor, transport, identity, fence,
    client: new SharedLedgerExecClient(gate, transport.exec, now),
    outbox: new SharedLedgerExecLocal(join(dir, "exec-local"), identity, "project", now),
    journal: new SchedulerCentralJournal(join(dir, "central-journal")),
    cache,
    /** Online snapshot into the read cache; returns the cache entry so the caller sees `rollback` (sequence went back). */
    async refresh() {
      view = await transport.snapshot(F);
      cache.store(ticket, view, view.serverSeq, now());
      return cache.read(now())!;
    },
    /** A detected regression is handled by dropping the cache and taking a whole fresh snapshot (never spliced). */
    rebuild() { cache.invalidate(ticket); ticket = cache.select({ centerId: "center", teamId: "team", personId: actor.personId, projectId: "project" }); },
    view: () => must(view),
    cmd<K extends V2CommandName>(type: K, payload: Record<string, unknown>, requestId = `${id}-${++n}`) {
      return parseCommand({ ...V2_FIXTURE_SCOPE, ...fence(), requestId, type, payload }) as Extract<V2Command, { type: K }>;
    },
    /** Through the X7 client: receipt lookup first, then one send; success only on a matching center receipt. */
    send: (c: V2Command): Promise<V2Receipt> => inst.client.command(c),
    /** Executor-side order commands go straight over the signed transport (peer B is never the home). */
    raw: (c: V2Command): Promise<V2Receipt> => transport.call("commands", {}, c),
    receipt: (c: V2Command) => transport.receipt({ requestId: c.requestId, operationId: null, commandDigest: v2ObjectDigest(c) }),
  };
  return inst;
}
export type Instance = ReturnType<typeof instance>;

export async function world() {
  const root = mkdtempSync(join(tmpdir(), "x15-e2e-"));
  roots.push(root);
  const k = kit({ handlers: E2E_HANDLERS }), center = serveCenter(k), now = () => k.center.time;
  const local = instance(root, "local", ACTORS.owner, "owner", center.baseUrl, now);
  const peerA = instance(root, "peer-a", ACTORS.member, "member", center.baseUrl, now);
  const peerB = instance(root, "peer-b", ACTORS.executor, "member", center.baseUrl, now);
  for (const i of [local, peerA, peerB]) {
    await writeSharedLedgerMode(F, { authorityMode: "execution", sharedPlanning: true,
      centerExecution: { centerId: "center", ...V2_FIXTURE_SCOPE, centerFeatureId: F, epoch: 1 } }, i.dir);
    await i.refresh();
  }
  // Fake gh on the drill's own PATH: records every call; `pr view` answers merged at MERGED.
  const bin = join(root, "bin"), ghLog = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && echo '{"state":"MERGED","mergeCommit":"${MERGED}"}'\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const ghEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog };
  const gh = async (...args: string[]) => {
    const p = Bun.spawn(["gh", ...args], { env: ghEnv, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  };
  const ghCalls = () => existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean) : [];
  /** Center commands answered so far, as "type status" (status "dropped" = committed, answer lost). */
  const served = (from = 0) => k.center.log.slice(from).filter(e => e.command).map(e => `${e.command} ${e.status}`);
  const task = (id: string) => must(k.center.rows().tasks.get(id));
  return { root, k, center, local, peerA, peerB, gh, ghEnv, ghCalls, served, task, all: [local, peerA, peerB] };
}
export type World = Awaited<ReturnType<typeof world>>;

/** The task's current versions as an X1 / X5 payload prefix. */
export function versions(w: World, taskId: string) {
  const t = w.task(taskId), wf = must(w.k.center.rows().workflows.get(taskId));
  return { taskId, expectedRev: t.rev, expectedSpecRev: t.specRev, expectedWorkflowRev: wf.rev };
}
export const bindFor = (w: World, taskId: string, head: string, actions: string[] = ["merge"]) => {
  const t = w.task(taskId), wf = must(w.k.center.rows().workflows.get(taskId));
  return { ...(V2_DTO_FIXTURES.ask.valid as { bind: Record<string, unknown> }).bind, taskId, featureId: F, taskRev: t.rev,
    specRev: t.specRev, workflowRev: wf.rev, head, actions, homeInstanceId: "local", expiresAt: 100_000 };
};

/** A card already reviewed at H1 and waiting for the owner's merge, seeded straight into the center (the loop file walks the full
 * path there); 本机 holds its lease. */
export async function mergeReady(w: World, taskId = "task-merge") {
  const t = V2_DTO_FIXTURES.task.valid as Record<string, unknown>, wf = V2_DTO_FIXTURES.workflow.valid as Record<string, unknown>;
  w.k.center.seed({ tasks: [{ ...t, id: taskId, featureId: F, itemId: null, stage: "merge", head: H1, pr: PR,
    review: { verdict: "pass", reviewedHead: H1, reportArtifactId: "artifact-review" } }], workflows: [{ ...wf, taskId }] });
  await lease(w, taskId);
  return taskId;
}

/** 本机 (home) takes the card's center lease; every lease-bound command below runs inside it. */
export async function lease(w: World, taskId: string) {
  return w.local.send(w.local.cmd("lease.acquire", { ...versions(w, taskId), homeInstanceId: "local" }));
}
/** Owner flow for a merge: a business ask on the center, answered by the owner, then the merge intent bound to it. */
export async function mergeIntent(w: World, taskId: string, head: string, operationId = `op-merge-${taskId}`) {
  const bind = bindFor(w, taskId, head);
  const asked = await w.local.send(w.local.cmd("ask.create", { featureId: F, taskId, expiresAt: 100_000, kind: "authorize", blocking: true,
    title: "合并授权", context: "", options: [{ id: "approve", label: "批准" }], allowText: false, bind }));
  const askId = asked.result.entityId;
  await w.local.send(w.local.cmd("ask.answer", { askId, expectedRev: 1, bindDigest: v2ObjectDigest(bind),
    answer: { kind: "option", optionId: "approve" }, decision: "approved" }));
  const t = w.task(taskId);
  await w.local.send(w.local.cmd("intent.create", { ...versions(w, taskId), action: "merge", node: "merge_deploy", operationId,
    head, round: t.round, dependencyDigest: D, authorizationAskId: askId, authorizationDigest: v2ObjectDigest(bind), resources: RESOURCE }));
  const i = must(w.k.center.rows().intents.get(operationId));
  return parseSchedulerCentralContext({ ...V2_FIXTURE_SCOPE, ...w.local.fence(), homeInstanceId: "local", taskId, intentId: i.id,
    operationId, taskRev: i.taskRev, specRev: i.specRev, workflowRev: i.workflowRev, head, action: "merge",
    authorizationAskId: askId, authorizationDigest: v2ObjectDigest(bind), authorizationBind: bind });
}

/** X8 runs the merge on 本机 under its local lock; the effect is the fake gh merge. `during` runs inside the effect after gh
 * returned (a fault injected while the action is in flight). */
export async function runMerge(w: World, c: SchedulerCentralContext, opts: { lock?: () => boolean; during?: () => void | Promise<void> } = {}) {
  const runtime = { instanceId: "local", client: w.local.transport.scheduler, lock: { held: opts.lock ?? (() => true) } };
  const effect = async (_entry: SchedulerCentralJournalEntry): Promise<SchedulerCentralObservation> => {
    const r = await w.gh("pr", "merge", String(PR), "--squash", "--match-head-commit", c.head!);
    await opts.during?.();
    return { state: r.code === 0 ? "succeeded" : "failed", head: MERGED, summary: "fake gh merge", artifactIds: [] };
  };
  return executeSchedulerCentral(c, runtime, w.local.journal, effect, () => w.k.center.time);
}

/** Unknown evidence per drill item: what each side held when it went unknown, written under the drill root and read back. */
export interface UnknownItem { item: string; instance: InstanceId; local: unknown; center: unknown }
export function evidence(w: World, drill: string, items: UnknownItem[]) {
  const dir = join(w.root, "drills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${drill}.json`), JSON.stringify({ drill, items }, null, 2));
  const back = JSON.parse(readFileSync(join(dir, `${drill}.json`), "utf8")) as { drill: string; items: UnknownItem[] };
  expect(back.items.map(i => i.item)).toEqual(items.map(i => i.item));
  return back;
}
export const outcome = (o: SchedulerCentralOutcome) => ({ state: o.state, resourceHeld: o.resourceHeld, reported: o.reported, replayed: o.replayed });
