import { canonicalJson } from "./canonical-json.js";

/** Trusted routing context is supplied by the caller, never inferred from message text or a system-looking label. */
export interface HeldIdleScope {
  channelId: string;
  agentName: string;
  sessionId: string;
  projectId: string;
  ownerId: string;
  permissionSource: string;
}

export interface IdleHeldLike {
  heldAt: number;
  to: { channelId: string; agentName?: string };
  env: {
    from: { kind: string; channelId?: string; agentName?: string; label?: string };
    to: { kind: string; channelId?: string; agentName?: string };
    intent: string;
    meta: { messageId: string; threadId: string; ts: string; waitForIdle?: boolean; expectSession?: string; triggerKind: string;
      dropIfStopped?: boolean; quotaGated?: boolean };
  };
}

export type HeldIdleMode = "on" | "observe" | "off";
/** Install-time switch (process env / .env). Anything but an explicit on / off observes: batches are computed and logged, nothing changes. */
export const HELD_IDLE_BATCH_ENV = "CLAUDESTRA_HELD_IDLE_BATCH";
export function heldIdleMode(env: Record<string, string | undefined> = process.env): HeldIdleMode {
  const v = env[HELD_IDLE_BATCH_ENV]?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : "observe";
}

/** The one message a Stop release sends for a batch. It is derived data: the originals stay queued until it is really sent. */
export const HELD_IDLE_CARRIER_LABEL = "held-idle-batch";
export const isHeldIdleCarrier = (item: { env: { from: { kind: string; label?: string } } }): boolean =>
  item.env.from.kind === "bridge" && item.env.from.label === HELD_IDLE_CARRIER_LABEL;
/**
 * Bridge notices the delivery layer re-judges one by one right before sending (interrupt wrap-up: bridge/turn-cuts.ts noticeWanted;
 * resume plans: bridge/quota-wall-wiring.ts resumeStillWanted). A batch or an inbox read would skip that check, so they keep their own path.
 */
const GATED_LABELS = new Set(["turn-cuts", "quota-wall", "api-error-resume", HELD_IDLE_CARRIER_LABEL]);

export interface HeldIdleBatch<T> { scope: HeldIdleScope; items: T[] }

/** Ledger asks already share the legacy priority path with owner requests and card answers. */
export const isHeldAskNotice = (item: Pick<IdleHeldLike, "env">): boolean =>
  item.env.from.kind === "bridge" && item.env.from.label === "ledger" && /^ledger-ask:ask_[A-Za-z0-9]+$/.test(item.env.meta.messageId ?? "");

export function isInternalIdleNotice(item: IdleHeldLike): boolean {
  const { from, intent, meta } = item.env;
  if (meta.dropIfStopped || meta.quotaGated || (from.kind === "bridge" && GATED_LABELS.has(from.label ?? ""))) return false;
  return !isHeldAskNotice(item) && intent === "notification" && meta.waitForIdle === true
    && ((from.kind === "local" && meta.triggerKind === "agent_tool")
      || (from.kind === "bridge" && ["system", "bridge_synth"].includes(meta.triggerKind)));
}

/** A missing registry/session/permission proof leaves the message on its existing path. */
export function validHeldIdleScope(item: IdleHeldLike, scope: HeldIdleScope | undefined): scope is HeldIdleScope {
  if (!scope || [scope.channelId, scope.agentName, scope.sessionId, scope.projectId, scope.ownerId, scope.permissionSource]
    .some((v) => typeof v !== "string" || !v)) return false;
  const { to, meta } = item.env;
  return isInternalIdleNotice(item) && to.kind === "local" && to.channelId === item.to.channelId
    && scope.channelId === item.to.channelId && scope.agentName === item.to.agentName && to.agentName === scope.agentName
    && (!meta.expectSession || meta.expectSession === scope.sessionId);
}

export const heldIdleScopeKey = (s: HeldIdleScope): string =>
  JSON.stringify([s.channelId, s.agentName, s.sessionId, s.projectId, s.ownerId, s.permissionSource]);

/** Keep the original items and envelopes: delivery callbacks and leases belong to each real message. */
export function heldIdleBatches<T extends IdleHeldLike>(items: readonly T[], scopeOf: (item: T) => HeldIdleScope | undefined): HeldIdleBatch<T>[] {
  const groups = new Map<string, HeldIdleBatch<T>>();
  for (const item of [...items].sort((a, b) => a.heldAt - b.heldAt)) {
    const scope = scopeOf(item);
    if (!validHeldIdleScope(item, scope)) continue;
    const key = heldIdleScopeKey(scope);
    if (!groups.has(key)) groups.set(key, { scope, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}

export interface IdleRegistryRow { name: string; status?: string; channelId?: string; sessionId?: string; projectId?: string; cwd?: string }
const bare = (name: string | undefined): string => (name ?? "").replace(/^agent-/, "");

/**
 * Scope from the registry alone: the target is the one active row on that channel, running a known session; a local sender must itself be
 * an active registered agent. Bridge notices and same-project agents share one permission source; an agent of another project gets its own
 * partition (its own turn). Anything unproven returns undefined and the message stays on its existing path.
 */
export function registryIdleScope(item: IdleHeldLike, rows: readonly IdleRegistryRow[], ownerId: string): HeldIdleScope | undefined {
  const targets = rows.filter((r) => r.channelId === item.to.channelId && r.status === "active");
  const t = targets[0], agentName = item.to.agentName;
  if (targets.length !== 1 || !t.sessionId || !agentName || bare(t.name) !== bare(agentName)) return undefined;
  const projectId = t.projectId || (t.cwd ? `cwd:${t.cwd}` : "");
  const { from } = item.env;
  let permissionSource = "internal";
  if (from.kind === "local") {
    const senders = rows.filter((r) => r.channelId === from.channelId && r.status === "active");
    if (senders.length !== 1 || bare(senders[0].name) !== bare(from.agentName)) return undefined;
    if ((senders[0].projectId ?? "") !== (t.projectId ?? "")) permissionSource = `agent:${senders[0].projectId ?? ""}:${from.channelId}`;
  } else if (from.kind !== "bridge") return undefined;
  return { channelId: item.to.channelId, agentName, sessionId: t.sessionId, projectId, ownerId, permissionSource };
}

export interface IdleBatchEntry<T> { item: T; text: string; preview?: true }
export interface IdleBatchFit<T> {
  /** What this batch shows, in the original heldAt order. A preview is only the opening: its original stays queued for a paged read or a later full delivery. */
  entries: IdleBatchEntry<T>[];
  /** Qualified but not in this batch (count / size limit): they lead the next one. */
  left: number;
  /** The same notice queued twice (see idleNoticeIdentity): shown once, settled with the one that carried it. */
  twins: Map<T, T[]>;
}

/**
 * Two queue entries are one notice only when everything the receiver is told about it matches: source, intent, id, thread, ts and body.
 * Bridge and agent notices share a batch, so an id / body collision across sources must stay two entries, each with its own origin.
 */
function idleNoticeIdentity(item: IdleHeldLike & { env: { content: unknown } }): string {
  const { from, intent, meta, content } = item.env;
  return canonicalJson([from.kind, from.channelId, from.agentName, from.label, intent, meta.messageId, meta.threadId, meta.ts, String(content)]);
}

/**
 * One release worth of a batch. `size` is the length of the final carrier text for a candidate entry list (headers, separators and note
 * included) and must stay within maxChars; an entry longer than maxEntryChars is shown as a preview. What does not fit is left for the
 * next batch. The oldest entry is never skipped: when it cannot be shown in full, nothing is picked and the caller delivers it whole on
 * the existing single path, so it cannot starve behind newer short ones.
 */
export function fitIdleBatch<T extends IdleHeldLike & { env: { content: unknown } }>(
  parts: readonly { item: T; text: string }[], lim: { maxItems: number; maxChars: number; maxEntryChars: number; maxPreviews: number },
  preview: (text: string, item: T) => string, size: (entries: readonly IdleBatchEntry<T>[]) => number,
): IdleBatchFit<T> {
  const out: IdleBatchFit<T> = { entries: [], left: 0, twins: new Map() };
  const seen = new Map<string, T>();
  let full = 0, previews = 0;
  for (const [k, { item, text }] of parts.entries()) {
    const key = idleNoticeIdentity(item), twin = seen.get(key);
    if (twin) {
      if (out.twins.has(twin)) out.twins.get(twin)!.push(item);
      continue;
    }
    seen.set(key, item);
    const long = text.length > lim.maxEntryChars;
    const entry: IdleBatchEntry<T> = long ? { item, text: preview(text, item), preview: true } : { item, text };
    const fits = (long ? previews < lim.maxPreviews : full < lim.maxItems) && size([...out.entries, entry]) <= lim.maxChars;
    if (k === 0 && (long || !fits)) return out;
    if (!fits) {
      out.left++;
      continue;
    }
    out.entries.push(entry);
    if (long) previews++;
    else {
      full++;
      out.twins.set(item, []);
    }
  }
  return out;
}

/** Stable id for a batch: the same members redelivered after a crash carry the same message_id, so the receiver can recognise the repeat. */
export function heldIdleCarrierId(items: readonly IdleHeldLike[]): string {
  let h = 5381;
  for (const c of items.map((i) => `${i.env.meta.messageId}@${i.heldAt}`).join("|")) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return `${HELD_IDLE_CARRIER_LABEL}:${items.length}:${h.toString(36)}`;
}
