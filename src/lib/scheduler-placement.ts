/**
 * Shared slot pool placement (i28-W5), pure: where one ready node runs — this machine, a lend-v2 peer, or nowhere yet.
 * Candidates are this machine plus every peer that passes all hard constraints; the one with the fewest running orders
 * wins, ties going to the write-lease holder (fix), then the last answering peer (re-review), then peers before this
 * machine, then borrow order. No candidate peer → local, whose own gates queue the node exactly as before W5. A card
 * pinned to a peer by start_node goes there or waits; it is never moved. Proto-1 peers (no hello) are not candidates
 * here: scheduler-placement-plan.ts keeps them on the i28-R9 overflow rule. tests/scheduler-placement.test.ts.
 */
import type { LendRole } from "./lend-config.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { RemotePolicy } from "./scheduler-config.js";

export type PlaceRole = "review" | "write" | "fix";

/** One borrow entry as the planner sees it. `v2` = the peer's last hello (lend protocol v2); null = proto 1. */
export interface PeerFacts {
  peer: string;
  /** Roles the borrow entry allows for this project. */
  roles: readonly LendRole[];
  /** A's live orders at this peer (any project). */
  open: number;
  v2: { why: string | null; slots: Readonly<Record<AuthorFamily, number>>; roles: readonly LendRole[]; repos: readonly string[] } | null;
}

export interface PlacementFacts {
  remote: RemotePolicy | null;
  /** Borrow order. */
  peers: readonly PeerFacts[];
  /** GitHub owner/repo of the card; null = no peer can take it (a peer only gets coordinates). */
  repo: string | null;
  /** Local executors + reviewer sessions of the project, the card's own excluded; room = a new one may start now. */
  local: { running: number; room: boolean };
  /** `peer:<name>` that start_node pinned the card's writing to; null = not pinned. */
  pin: string | null;
  /** Peers already offered this round and head: each is tried once, then the next one or local. */
  tried: readonly string[];
  lastPeer: string | null;
  writeLeasePeer: string | null;
  /** Writing needs the card's fileGlobs locks: false = another card holds an overlapping one. */
  locksFree: boolean;
}

export type Placement = { kind: "local"; reason: string } | { kind: "peer"; peer: string; reason: string } | { kind: "wait"; reason: string };

export const PEER_PLACEMENT = "peer:";
export const lendRoleOf = (role: PlaceRole): LendRole => role === "review" ? "review" : "write";
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Why this peer cannot take the role now, or null. Every constraint is checked; proto 1 never qualifies here. */
export function peerRefusal(f: PlacementFacts, p: PeerFacts | undefined, role: PlaceRole, family: AuthorFamily): string | null {
  const lend = lendRoleOf(role);
  if (!p) return "不在借入名单里（或借入不含本项目）";
  if (!f.remote || f.remote.mode === "off") return "scheduler.json remote.mode = off";
  if (!(f.remote.roles as readonly string[]).includes(lend)) return `scheduler.json remote.roles 不含 ${lend}`;
  if (!p.roles.includes(lend)) return `借入名单对 ${p.peer} 不允许 ${lend}`;
  if (!p.v2) return "没有 hello（proto 1，只按老规则在本机满时接审查）";
  if (p.v2.why) return p.v2.why;
  if (!p.v2.roles.includes(lend)) return `对方授权不含 ${lend}`;
  if (!f.repo) return "卡上没有 GitHub 仓库坐标";
  if (!p.v2.repos.some((r) => sameRepo(r, f.repo as string))) return `对方授权的仓库不含 ${f.repo}`;
  if (!(p.v2.slots[family] > 0)) return `对方没有空闲的 ${family} 槽`;
  if (role !== "review" && !f.locksFree) return "文件锁被别的卡占着";
  return null;
}

interface Ranked { where: string; load: number; order: number }

/** Lower sorts first: fewest running, then the tie-breaks in the header comment. */
function rank(f: PlacementFacts, role: PlaceRole, a: Ranked, b: Ranked): number {
  if (a.load !== b.load) return a.load - b.load;
  const favoured = role === "fix" ? f.writeLeasePeer : role === "review" ? f.lastPeer : null;
  const fav = (r: Ranked) => (favoured && r.where === favoured ? 0 : 1);
  if (fav(a) !== fav(b)) return fav(a) - fav(b);
  const local = (r: Ranked) => (r.where === "local" ? 1 : 0);
  return local(a) - local(b) || a.order - b.order;
}

const loads = (rows: readonly Ranked[]): string => rows.map((r) => `${r.where === "local" ? "本机" : r.where} ${r.load}`).join(" / ");

export function placeFor(f: PlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  // The pin is where the card is written; its review is placed like any other (cross-family, possibly elsewhere).
  if (f.pin && role !== "review") {
    const name = f.pin.slice(PEER_PLACEMENT.length);
    const why = peerRefusal(f, f.peers.find((p) => p.peer === name), role, family);
    return why ? { kind: "wait", reason: `固定放在 ${f.pin}，它现在不能接：${why}` } : { kind: "peer", peer: name, reason: `start_node 固定放在 ${f.pin}` };
  }
  const usable = f.peers.map((p, order) => ({ p, order })).filter(({ p }) => !f.tried.includes(p.peer) && !peerRefusal(f, p, role, family));
  const rows: Ranked[] = usable.map(({ p, order }) => ({ where: p.peer, load: p.open, order }));
  if (f.local.room) rows.push({ where: "local", load: f.local.running, order: f.peers.length });
  if (!usable.length) return { kind: "local", reason: f.local.room ? "没有可用的 peer，放本机" : "本机满且没有可用的 peer：本机照常排队" };
  const pick = [...rows].sort((a, b) => rank(f, role, a, b))[0];
  const why = `在跑：${loads(rows)}；选最少，平手按 ${role === "fix" ? "写租约方 > " : role === "review" ? "复审回上次的 peer > " : ""}peer 先于本机 > 借入顺序`;
  return pick.where === "local" ? { kind: "local", reason: why } : { kind: "peer", peer: pick.where, reason: why };
}
