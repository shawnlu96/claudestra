import { poolPeerFamily } from "./scheduler-agent-pool.js";
/** Family policy overlays the existing placement gates, tiers and load ranking; it never edits the hello's slot counts. */
import type { AuthorFamily } from "./ledger-scheduler.js";
import { peerFamily as availableFamily, peerRefusal, placeFor as placeByTier, type PeerFacts, type PlaceRole, type PlacementFacts, type Placement } from "./scheduler-placement.js";

export { PEER_PLACEMENT, type PeerFacts, type PlaceRole, type PlacementFacts } from "./scheduler-placement.js";

const DEFAULT_WRITE_FAMILIES: readonly AuthorFamily[] = ["codex"];

/** Proto-1 lenders hard-code Codex and reject Claude orders; a Claude reviewer requires a hello advertising its slot. */
export const allowLegacyReview = (family: AuthorFamily): boolean => family === "codex";

/** Omission preserves the old config shape; the picker supplies Codex as the default. */
export function parseWriteFamilies(raw: unknown, where: string): { writeFamilies?: AuthorFamily[] } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || !raw.length || raw.length > 2 || new Set(raw).size !== raw.length ||
    raw.some((f) => f !== "claude" && f !== "codex")) {
    throw new Error(`${where}.writeFamilies must contain claude / codex, each once, in preference order`);
  }
  return { writeFamilies: [...raw] as AuthorFamily[] };
}

/** A fix must keep its author's family even if the preferred writing family has changed since the initial order. */
export function peerFamily(p: PeerFacts, role: PlaceRole, family: AuthorFamily,
  writeFamilies: readonly AuthorFamily[] = DEFAULT_WRITE_FAMILIES, unified = false): AuthorFamily | null {
  if (unified) return poolPeerFamily(p, role, family);
  if (role !== "write") return availableFamily(p, "review", family);
  return writeFamilies.find((f) => (p.v2?.slots[f] ?? 0) > 0) ?? null;
}

export function placeFor(facts: PlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  if (facts.remote?.agents) return placeByTier(facts, role, family);
  if (role === "review") return placeByTier(facts, role, family);
  const peers = facts.peers.map((p) => {
    if (!p.v2) return p;
    const selected = peerFamily(p, role, family, facts.remote?.writeFamilies);
    // The legacy ranker can only see the chosen family, so its Codex-first rule cannot override the configured order.
    const slots = { claude: selected === "claude" ? p.v2.slots.claude : 0, codex: selected === "codex" ? p.v2.slots.codex : 0 };
    return { ...p, v2: { ...p.v2, slots } };
  });
  if (role === "write" && !facts.pin) {
    for (const tier of ["first", "balance", "low"] as const) {
      const usable = peers.filter((p) => (p.priority ?? "balance") === tier &&
        !facts.tried.includes(p.peer) && !peerRefusal({ ...facts, peers }, p, role, family));
      const selected = (facts.remote?.writeFamilies ?? DEFAULT_WRITE_FAMILIES)
        .find((f) => usable.some((p) => (p.v2?.slots[f] ?? 0) > 0));
      if (!selected) continue;
      // Choose the family's pool before ranking load, so a Codex-only peer cannot defeat Claude preference within this tier.
      for (const p of usable) {
        if (p.v2 && !p.v2.slots[selected]) p.v2.slots = { claude: 0, codex: 0 };
      }
    }
  }
  return placeByTier({ ...facts, peers }, role, family);
}
