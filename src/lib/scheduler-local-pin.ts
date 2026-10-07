/** A card's writing pin: `peer:<name>` names a lender; `placement=local` or `localAuthorOnly=true` fixes it on this machine. */
export const LOCAL_PLACEMENT = "local";
// Same literal as scheduler-placement.ts PEER_PLACEMENT; importing it would close a cycle through placeAgentPool.
const PEER_PLACEMENT = "peer:";

/** Explicitly this machine. "local" is never a peer name, and no other extra field can stand in for it. */
export function explicitLocal(extra: Record<string, unknown> | undefined | null): boolean {
  return extra?.placement === LOCAL_PLACEMENT || extra?.localAuthorOnly === true;
}

/** The pinned peer's name, or null: only a non-empty `peer:<name>` string is a peer pin. */
export function pinnedPeer(pin: unknown): string | null {
  return typeof pin === "string" && pin.startsWith(PEER_PLACEMENT) && pin.length > PEER_PLACEMENT.length ? pin.slice(PEER_PLACEMENT.length) : null;
}

/** The pin placement facts carry: "local" for an explicit local card, the `peer:<name>` string, else none. */
export function placementPin(extra: Record<string, unknown> | undefined | null): string | null {
  if (explicitLocal(extra)) return LOCAL_PLACEMENT;
  return pinnedPeer(extra?.placement) ? extra!.placement as string : null;
}

export const LOCAL_LEASE_WAIT = (peer: string): string =>
  `本机限定卡（placement=local / localAuthorOnly）的写租约在 ${peer}：不外派也不在本机另写，PM 核对后 ledger lend-reclaim`;
