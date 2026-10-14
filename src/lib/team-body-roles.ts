/**
 * Reviewer / PM identity on the body upload (team-project-TEAMVIS12): the home reports an instance id only
 * (`{instanceId}`), the center looks the member code up (TEAMVIS11B). Nothing is guessed: a source this instance cannot
 * place goes without the key, and an identity never makes a record invalid.
 * - Reviewer (each review): data.reviewer, else the event's actor. Imported (data.imported, actor `import`) or written
 *   elsewhere (origin set and not this ledger's storedOrigin) → none. `peer:<name>` → that enabled peer's instanceId
 *   in peers.json, if it is one; `x@y` → none; anything else (local agent, owner, a PM writing for a local reviewer) →
 *   this instance's service credential instanceId. PM (spec): tasks.pm by the same rules; empty → none.
 * - peers.json is read at most once a pass, and only when a `peer:` source shows up in a pass that carries identity.
 * - Fallback: a center that refuses a batch carrying identity (400) gets the same batch once more without it, and no
 *   identity for 24 h (`identity:` + origin key in team-body-sync.json metaRefused, team-body-sync-meta.ts takesMeta /
 *   refuseMeta; the origin's own key stays unwritten, so meta still goes). Still 400 → TEAMVIS10's meta fallback.
 * tests/team-body-roles.test.ts.
 */
import { isInstanceId } from "./instance-id.js";
import { readPeers } from "./peers.js";
import { SharedLedgerRemoteError } from "./shared-ledger-client-transport.js";
import type { TeamBodyEventMeta, TeamBodyKind, TeamBodyRecord } from "./shared-ledger-contract-team-body.js";
import { checkedIdentity, type TeamBodyIdentity, type TeamBodySpecMeta } from "./team-body-roles-contract.js";

/** The raw material of one record's identity: the review event's row, or the card's PM. */
export type RoleSource = { actor: string; origin: string | null; data: string } | { pm: string | null };
/** The fields of a peers.json entry read here; the tokens are never touched. */
export interface RolePeer { name: string; instanceId?: string; disabled?: boolean }
export type RolePeers = () => Promise<readonly RolePeer[]>;

/** metaRefused key of a center that refused identity. */
export const identityKey = (origin: string): string => `identity:${origin}`;

/** One read at most, on first use; an injected reader that fails reads as no peers. */
export function rolePeers(read: RolePeers = async () => (await readPeers()).httpPeers ?? []): RolePeers {
  let once: Promise<readonly RolePeer[]> | undefined;
  return () => once ??= read().then((all) => Array.isArray(all) ? all : [], () => []);
}

interface RoleContext { localInstance: string; storedOrigin: string | null; peers: RolePeers }

async function instanceOf(name: string | null, ctx: RoleContext): Promise<TeamBodyIdentity | undefined> {
  if (!name) return undefined;
  if (name.startsWith("peer:")) {
    const peer = (await ctx.peers()).find((p) => p?.name === name.slice(5) && !p.disabled && isInstanceId(p.instanceId));
    return peer ? checkedIdentity({ instanceId: peer.instanceId }) : undefined;
  }
  return name.includes("@") ? undefined : checkedIdentity({ instanceId: ctx.localInstance });
}

/** Who wrote this review, as this ledger knows it; null when it was imported or came from elsewhere. */
function reviewerName(src: { actor: string; origin: string | null; data: string }, storedOrigin: string | null): string | null {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(src.data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch { /* unreadable data: the actor alone */ }
  if (data.imported || src.actor === "import" || (src.origin && src.origin !== storedOrigin)) return null;
  return typeof data.reviewer === "string" && data.reviewer ? data.reviewer : src.actor || null;
}

/**
 * Items with identity attached: a review's meta gains `reviewer` (only when it has its event meta), a spec gains
 * `meta: {pm}`. Anything that cannot be placed, or fails the contract's identity schema, stays as it was.
 */
export async function withRoles<T extends { kind: TeamBodyKind; meta?: TeamBodyEventMeta | TeamBodySpecMeta; who?: RoleSource }>(
  items: readonly T[], ctx: RoleContext): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) {
    const who = item.who;
    if (item.kind === "review" && item.meta && who && "actor" in who) {
      const reviewer = await instanceOf(reviewerName(who, ctx.storedOrigin), ctx);
      out.push(reviewer ? { ...item, meta: { ...item.meta, reviewer } } : item);
    } else if (item.kind === "spec" && who && "pm" in who) {
      const pm = await instanceOf(who.pm, ctx);
      out.push(pm ? { ...item, meta: { pm } } : item);
    } else out.push(item);
  }
  return out;
}

/** The record without its identity keys: a review keeps kind / ts, a spec loses its meta (pm is all it has). */
function withoutIdentity(record: TeamBodyRecord): TeamBodyRecord {
  if (record.kind === "spec" && record.meta) {
    const { meta: _meta, ...plain } = record;
    return plain;
  }
  if (!record.meta?.reviewer) return record;
  const { reviewer: _reviewer, ...meta } = record.meta;
  return { ...record, meta };
}
const carriesIdentity = (r: TeamBodyRecord | null): boolean => !!r && (r.kind === "spec" ? !!r.meta : !!r.meta?.reviewer);
const is400 = (error: unknown): boolean => error instanceof SharedLedgerRemoteError && error.status === 400;

/** How the rest of a pass sends: strip = no meta at all (TEAMVIS10), bare = no identity. Both only ever turn on. */
export interface RoleSend { strip: boolean; bare: boolean }

/**
 * Sends one run, falling back on a 400: first without identity when it carried any (then `refused.identity`), then,
 * still 400 and still meta, without meta (then `refused.meta`). Any other failure, or a 400 with nothing left to drop,
 * is thrown as before.
 */
export async function uploadWithRoles<P extends { record: TeamBodyRecord | null }, R>(slice: readonly P[], s: RoleSend,
  upload: (slice: readonly P[], strip: boolean) => Promise<R>, refused: { identity: () => void; meta: () => void }): Promise<R> {
  const shown = () => s.bare ? slice.map((x) => ({ ...x, record: x.record && withoutIdentity(x.record) })) : slice;
  let failure: unknown;
  try { return await upload(shown(), s.strip); }
  catch (error) { failure = error; }
  if (!is400(failure)) throw failure;
  if (!s.strip && !s.bare && slice.some((x) => carriesIdentity(x.record))) {
    s.bare = true;
    try {
      const done = await upload(shown(), false);
      refused.identity();
      return done;
    } catch (error) {
      if (!is400(error)) throw error;
      failure = error;
    }
  }
  if (s.strip || !shown().some((x) => x.record?.meta)) throw failure;
  s.strip = true;
  const done = await upload(slice, true);
  refused.meta();
  return done;
}
