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
    meta: { messageId: string; threadId: string; ts: string; waitForIdle?: boolean; expectSession?: string; triggerKind: string };
  };
}

export interface HeldIdleBatch<T> { scope: HeldIdleScope; items: T[] }

/** Ledger asks already share the legacy priority path with owner requests and card answers. */
export const isHeldAskNotice = (item: Pick<IdleHeldLike, "env">): boolean =>
  item.env.from.kind === "bridge" && item.env.from.label === "ledger" && /^ledger-ask:ask_[A-Za-z0-9]+$/.test(item.env.meta.messageId ?? "");

export function isInternalIdleNotice(item: IdleHeldLike): boolean {
  const { from, intent, meta } = item.env;
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
