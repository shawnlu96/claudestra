import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { ASK_TTL_MS, closeAsk, getAsk, listAsks, patchAsk, isRuntimeAsk, openAskFull, type Ask, type NewAsk } from "../lib/ledger-asks.js";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import { readSharedLedgerMode } from "../lib/shared-ledger-mode.js";
import { fail, parseAuthorizationBind, parseCommand, V2ContractError, v2ObjectDigest,
  type V2AuthorizationBind, type V2Command, type V2Fence } from "../lib/shared-ledger-contract-v2.js";
import type { SharedLedgerExecClient } from "../lib/shared-ledger-exec-client.js";
import type { AnswerInput } from "./asks.js";
import { sharedAnswerValue, sharedAskMapping, sharedAskOptions, sharedAskView, type SharedAskMapping } from "./shared-ledger-v2-asks-mapping.js";

export interface ExecFeatureRef { localFeatureId: string; projectId: string; centerFeatureId: string; epoch: number }
export interface SharedAskCommandContext extends V2Fence {
  teamId: string;
  projectId: string;
  taskId: string | null;
  /** An authenticated Principal-specific client; the frozen clientFor remains the default. */
  client?: SharedLedgerExecClient;
}
export interface SharedAsksPort {
  mode(project: string): "off" | "observe" | "on";
  clientFor(project: string): SharedLedgerExecClient | null;
  featureOfTask(taskId: string): ExecFeatureRef | null;
  route?(taskId: string): "local" | "skip" | "central";
  /** Resolve context.taskId from this local card; principal is a lookup hint, never an actor supplied by a reply. */
  commandContext?(project: string, feature: ExecFeatureRef, principal: string | undefined, localTaskId: string): SharedAskCommandContext | null;
  authorizationBind?(ask: NewAsk, feature: ExecFeatureRef, context: SharedAskCommandContext): V2AuthorizationBind | null;
}
interface SharedAskRuntime {
  db(): Database;
  publish(ask: Ask): void;
  rejected(status: 400 | 403 | 409 | 503, code: string, message: string): Error;
  answered(input: AnswerInput, view: Ask): Promise<void>;
}
let port: SharedAsksPort | null = null;
let runtime: SharedAskRuntime | null = null;
export function configureSharedAsks(value: SharedAsksPort | null): void { port = value; }
/** Wiring is installed without performing state or network I/O. */
export function configureSharedAskRuntime(value: SharedAskRuntime): void { runtime = value; }

const business = (a: NewAsk): boolean => !isRuntimeAsk(a) && a.kind !== "assigned";
const ready = (): boolean => !!port?.route && !!port.commandContext && !!port.authorizationBind;
function featureFor(a: NewAsk): ExecFeatureRef | null {
  if (!business(a) || !a.taskId || !ready()) return null;
  return port!.featureOfTask(a.taskId);
}
function admitted(a: NewAsk, mapped: SharedAskMapping | null = null, observe = true): ExecFeatureRef | null {
  const feature = mapped ? { localFeatureId: mapped.localFeatureId, projectId: a.project,
    centerFeatureId: mapped.centerFeatureId, epoch: mapped.epoch } : featureFor(a);
  if (!feature) {
    // Even a planning feature in migration is frozen by the injected route before its execution ref exists.
    if (business(a) && a.taskId && ready() && port!.route!(a.taskId) === "skip") fail("migration_blocked");
    return null;
  }
  if (!ready()) fail("unavailable");
  const route = port!.route!(a.taskId!);
  if (route === "skip") fail("migration_blocked");
  const mode = port!.mode(a.project);
  if (mode === "observe" && observe) console.info(`[shared asks observe] ${a.taskId}: business ask would use the center`);
  if (mode !== "on") {
    if (mapped) fail("unavailable");
    return null;
  }
  if (route !== "central") {
    if (mapped) fail("unavailable");
    return null;
  }
  return feature;
}
function contextFor(a: NewAsk, feature: ExecFeatureRef, principal?: string) {
  const context = port!.commandContext!(a.project, feature, principal, a.taskId!);
  const client = context?.client ?? port!.clientFor(a.project);
  if (!context || !client) fail("unavailable");
  if (context.epoch !== feature.epoch) fail("stale_epoch");
  return { context, client };
}
function command<K extends V2Command["type"]>(context: SharedAskCommandContext, type: K, payload: unknown): Extract<V2Command, { type: K }> {
  return parseCommand({ teamId: context.teamId, projectId: context.projectId, serviceGeneration: context.serviceGeneration,
    epoch: context.epoch, bootId: context.bootId, requestId: `ask-${crypto.randomUUID()}`, type, payload }) as Extract<V2Command, { type: K }>;
}

/** Called before opening any local row: a failed center creation leaves askDb unchanged. */
const creating = new Map<string, Promise<Ask | null>>();
export async function openSharedAsk(input: NewAsk, now = Date.now()): Promise<Ask | null> {
  if (!input.dedupKey) return createSharedAsk(input, now);
  const key = v2ObjectDigest({ project: input.project, dedupKey: input.dedupKey });
  const existing = creating.get(key);
  if (existing) return existing;
  const pending = createSharedAsk(input, now);
  creating.set(key, pending);
  try { return await pending; } finally { creating.delete(key); }
}
async function createSharedAsk(input: NewAsk, now: number): Promise<Ask | null> {
  const feature = admitted(input);
  if (!feature) {
    // A rollback cannot locally supersede a still-live center ask; wait for center reconciliation first.
    if (business(input) && runtime && input.askKey && input.fromAgent && listAsks(runtime.db(), {
      project: input.project, fromAgent: input.fromAgent, states: ["open"],
    }).some((a) => a.askKey === input.askKey && sharedAskMapping(a))) fail("unavailable");
    return null;
  }
  if (!runtime) fail("unavailable");
  if (input.dedupKey) {
    const existing = runtime.db().query("SELECT id FROM asks WHERE dedupKey = ?").get(input.dedupKey) as { id: string } | null;
    if (existing) {
      const a = getAsk(runtime.db(), existing.id)!;
      if (a.project !== input.project) fail("conflict");
      return a;
    }
  }
  const { context, client } = contextFor(input, feature, input.fromAgent ?? input.createdBy ?? undefined);
  const bind = input.kind === "authorize" ? parseAuthorizationBind(port!.authorizationBind!(input, feature, context)) : null;
  const expiresAt = bind?.expiresAt ?? input.expiresAt ?? now + ASK_TTL_MS[input.kind];
  const receipt = await client.createAsk(command(context, "ask.create", {
    featureId: feature.centerFeatureId, taskId: context.taskId, kind: input.kind, blocking: input.blocking === true,
    title: input.title, context: input.context ?? "", options: sharedAskOptions(input), allowText: input.allowText !== false, bind, expiresAt,
  }));
  const mapping: SharedAskMapping = { teamId: context.teamId, projectId: context.projectId,
    centerAskId: receipt.result.entityId, centerFeatureId: feature.centerFeatureId, localFeatureId: feature.localFeatureId,
    epoch: feature.epoch, displayOnly: true, authoritative: false };
  const a = openAskFull(runtime.db(), { ...input, expiresAt, extra: { ...input.extra, sharedAsk: mapping } }, now, { deferSupersede: true }).ask;
  runtime.publish(a);
  return a;
}
function mappedClient(a: Ask, principal?: string, observe = true) {
  const mapping = sharedAskMapping(a);
  if (!mapping) return null;
  const feature = admitted(a, mapping, observe)!;
  const { context, client } = contextFor(a, feature, principal);
  if (context.teamId !== mapping.teamId || context.projectId !== mapping.projectId) fail("forbidden");
  return { mapping, feature, context, client };
}
async function query(a: Ask, principal?: string) {
  const ctx = mappedClient(a, principal);
  if (!ctx) return null;
  const center = await ctx.client.queryAsk({ teamId: ctx.mapping.teamId, projectId: ctx.mapping.projectId, askId: ctx.mapping.centerAskId });
  if (center.featureId !== ctx.mapping.centerFeatureId || center.taskId !== ctx.context.taskId) fail("forbidden");
  mappedClient(a, principal, false); // Recheck route/switch without logging the same operation twice.
  return { ...ctx, center };
}

/** All three answer entry points arrive here; no local decision or answer is persisted. */
export async function sharedAskAnswer(input: AnswerInput): Promise<Ask | null> {
  try { return await runSharedAnswer(input); } catch (error) {
    if (!(error instanceof V2ContractError)) throw error;
    if (error.status === 409) throw new LedgerError("conflict", error.code);
    const status = error.status >= 500 ? 503 : error.status === 400 ? 400 : 403;
    throw runtime?.rejected(status, error.code, error.message) ?? error;
  }
}
async function runSharedAnswer(input: AnswerInput): Promise<Ask | null> {
  const ctx = await query(input.ask, input.principal);
  if (!ctx) {
    if (admitted(input.ask)) fail("unavailable"); // A stage-one approval cannot become execution authority after a switch.
    return null;
  }
  const approve = input.picks.some((p) => input.ask.bind?.approve.some((id) => p.wire === `[button:${id}]`));
  await ctx.client.answerAsk(command(ctx.context, "ask.answer", {
    askId: ctx.mapping.centerAskId, expectedRev: ctx.center.rev, bindDigest: v2ObjectDigest(ctx.center.bind),
    answer: sharedAnswerValue(input.ask, input.picks, input.text),
    decision: input.ask.kind === "authorize" ? approve ? "approved" : "rejected" : "acknowledged",
  }));
  const answer = input.picks.map((p) => p.wire);
  const view: Ask = { ...input.ask, state: "answered", answer: { choices: answer, labels: input.picks.map((p) => p.label), text: input.text,
    principal: input.principal, device: input.device, via: input.via, at: Date.now(), final: true } };
  await runtime?.answered(input, view);
  return view;
}
export async function readSharedAsk(a: Ask, principal?: string): Promise<Ask> {
  const ctx = await query(a, principal);
  return ctx ? sharedAskView(a, ctx.center) : a;
}
/** Lists and message previews are display-only: one unavailable row must not hide unrelated runtime asks. */
export async function displaySharedAsk(a: Ask, principal?: string): Promise<Ask> {
  const stale = () => ({ ...a, extra: { ...a.extra, displayStale: true } });
  try {
    if (sharedAskMapping(a) && (!ready() || port!.mode(a.project) !== "on" || port!.route!(a.taskId!) !== "central")) return stale();
    const view = await readSharedAsk(a, principal);
    displayFailures.delete(a.id);
    return view;
  } catch (error) {
    // This fallback never participates in answer, cancellation or authorization decisions.
    const message = (error as Error).message;
    if (displayFailures.get(a.id) !== message) console.info(`shared ask display stale (${a.id}): ${message}`);
    if (displayFailures.size >= 1000) displayFailures.clear();
    displayFailures.set(a.id, message);
    return stale();
  }
}
const displayFailures = new Map<string, string>();
/** Persist only center terminal state as display metadata; answer/approval and decision events remain absent. */
export function recordSharedAskDisplay(view: Ask): void {
  if (!runtime || !sharedAskMapping(view) || view.state === "open") return;
  runtime.db().query("UPDATE asks SET state = ?, updatedAt = ? WHERE id = ? AND state = 'open'")
    .run(view.state, Date.now(), view.id);
}
export async function cancelSharedAsk(a: Ask, reason: string, principal?: string): Promise<Ask | null> {
  const ctx = await query(a, principal);
  if (!ctx) {
    if (admitted(a)) fail("unavailable");
    return null;
  }
  await ctx.client.cancelAsk(command(ctx.context, "ask.cancel", {
    askId: ctx.mapping.centerAskId, expectedRev: ctx.center.rev, bindDigest: v2ObjectDigest(ctx.center.bind), reason,
  }));
  const view: Ask = { ...a, state: "cancelled", answer: null };
  recordSharedAskDisplay(view);
  return view;
}

/** Replacing a delivered message cancels its old center ask; changing only the local row would leave an approval live. */
export async function supersedeSharedAsks(a: Ask): Promise<boolean> {
  if (!a.askKey || !a.fromAgent || !runtime) return !!sharedAskMapping(a);
  const old = listAsks(runtime.db(), { fromAgent: a.fromAgent, source: "reply", states: ["open"] })
    .filter((x) => x.id !== a.id && x.project === a.project && x.askKey === a.askKey && x.createdAt <= a.createdAt);
  if (!sharedAskMapping(a) && !old.some((x) => sharedAskMapping(x))) return false;
  for (const item of old) {
    if (!sharedAskMapping(item)) {
      const closed = closeAsk(runtime.db(), item.id, "cancelled", `superseded by ${a.id}`);
      if (closed) runtime.publish(closed);
      continue;
    }
    const view = await readSharedAsk(item);
    if (view.state === "open") await cancelSharedAsk(item, `superseded by ${a.id}`);
    else recordSharedAskDisplay(view);
    patchAsk(runtime.db(), item.id, { extra: { hidden: { at: Date.now(), supersededBy: a.id } } });
    runtime.publish({ ...item, state: view.state === "open" ? "cancelled" : view.state });
  }
  return true;
}

/** CLI can pass its own database without initializing bridge wiring or opening the production ask database. */
export async function checkSharedAskAuthorization(a: Ask | null, hash: string, actor: string, db: Database): Promise<boolean | null> {
  if (!a || !business(a)) return null;
  const mapping = sharedAskMapping(a);
  if (!mapping && !admitted(a)) {
    // A mapped/previously approved execution ask never falls back to the local approved record in another CLI process.
    const task = a.taskId ? getTask(db, a.taskId) : null;
    const featureId = task?.extra.sharedFeatureId;
    const file = (db.query("PRAGMA database_list").get() as { file?: string } | null)?.file;
    if (typeof featureId === "string" && file && readSharedLedgerMode(featureId, dirname(file)).authorityMode === "execution") fail("unavailable");
    return null;
  }
  if (!a.bind || a.fromAgent !== actor || hash.toLowerCase() !== a.bind.paramsHash) fail("authorization_mismatch");
  const ctx = mappedClient(a, actor);
  if (!ctx) fail("unavailable");
  const feature = ctx.feature;
  const bind = parseAuthorizationBind(port!.authorizationBind!(a, feature, ctx.context));
  if (bind.featureId !== feature.centerFeatureId || bind.taskId !== ctx.context.taskId) fail("authorization_mismatch");
  if (bind.taskId === null || bind.taskRev === null || bind.specRev === null || bind.workflowRev === null) fail("authorization_mismatch");
  // A new requestId on every invocation prevents the X7 receipt cache from granting a historical approval.
  await ctx.client.checkAuthorization(command(ctx.context, "authorization.check", {
    taskId: bind.taskId, expectedRev: bind.taskRev, expectedSpecRev: bind.specRev, expectedWorkflowRev: bind.workflowRev,
    askId: ctx.mapping.centerAskId, bind, action: a.bind.action,
  }));
  return true;
}

/** reply and HTTP adapters translate center errors instead of dropping into their local write paths. */
export function sharedAskError(error: unknown): { status: number; code: string; error: string } | null {
  return error instanceof V2ContractError ? { status: error.status, code: error.code, error: error.message } : null;
}
