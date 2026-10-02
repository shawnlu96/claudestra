import { placeAgentPool, poolPeerRefusal } from "./scheduler-agent-pool.js";
import type { AgentPoolLoad } from "./scheduler-agent-pool.js";
import { localFamilyRefusal } from "./scheduler-local-families-placement.js";
/**
 * Shared slot pool placement (i28-W5), pure: where one ready node runs — this machine, a lend-v2 peer, or nowhere yet.
 * Candidates are this machine plus every peer that passes all hard constraints (file locks, grant roles / repos / slots,
 * cross-family review, the write lease); the tiers come next (i28-W9): the `first` machines that can take it, fewest
 * running wins; none → `balance`, then `low`; `off` never. Inside a tier ties go to the write-lease holder (fix), then the
 * last answering peer (re-review), then peers before this machine, then borrow order. No candidate peer → local, whose own
 * gates queue the node as before W5 (local `off` waits instead). A card pinned to a peer by start_node goes there or waits.
 * A review goes to the first remote.reviewFirst peer that passes the same constraints, whatever its load (i28-W5c); a fix
 * goes only back to the peer holding the card's write lease (i28-R6). Proto-1 peers (no hello) are not candidates here:
 * scheduler-placement-plan.ts keeps them on the i28-R9 overflow rule. tests/scheduler-placement*.test.ts.
 */
import type { LendRole, Priority } from "./lend-config.js";
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
  /** The borrow entry's tier; absent = balance. */
  priority?: Priority;
  v2: { why: string | null; slots: Readonly<Record<AuthorFamily, number>>; roles: readonly LendRole[]; repos: readonly string[];
    familyTotals?: Readonly<Record<AuthorFamily, number>>; familyBusy?: Readonly<Record<AuthorFamily, number>> } | null;
}

export interface PlacementFacts {
  remote: RemotePolicy | null;
  /** Borrow order. */
  peers: readonly PeerFacts[];
  /** GitHub owner/repo of the card; null = no peer can take it (a peer only gets coordinates). */
  repo: string | null;
  /** Local executors + reviewer sessions of the project, the card's own excluded; room = a new one may start now. */
  local: { running: number; room: boolean; pool?: AgentPoolLoad; family?: AuthorFamily };
  /** `peer:<name>` that start_node pinned the card's writing to; null = not pinned. */
  pin: string | null;
  /** Spent attempts this round/head exclude unpinned peers; temporary push refusals use a separate retry gate. */
  tried: readonly string[];
  lastPeer: string | null;
  /** Peer holding the card's write lease now: a fix can only go back there (it pushes the lend/ branch). */
  writeLeasePeer: string | null;
  /** Writing needs the card's fileGlobs locks: false = another card holds an overlapping one. */
  locksFree: boolean;
}

export type Placement = { kind: "local"; reason: string; family?: AuthorFamily } | { kind: "peer"; peer: string; family: AuthorFamily; reason: string } | { kind: "wait"; reason: string };

export const PEER_PLACEMENT = "peer:";
const lendRoleOf = (role: PlaceRole): LendRole => role === "review" ? "review" : "write";
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Writing goes to the lender's free family in this order: the owner wants the lender's Codex used first (i28-W9). */
const WRITE_FAMILIES: readonly AuthorFamily[] = ["codex", "claude"];

/** The family the order would run in at this peer: review = the cross family asked for, writing = the first free one. */
export function peerFamily(p: PeerFacts, role: PlaceRole, family: AuthorFamily): AuthorFamily | null {
  const free = (x: AuthorFamily) => (p.v2?.slots[x] ?? 0) > 0;
  return role === "review" ? (free(family) ? family : null) : WRITE_FAMILIES.find(free) ?? null;
}

/** Why this peer cannot take the role now, or null. Every constraint is checked; proto 1 never qualifies here. */
export function peerRefusal(f: PlacementFacts, p: PeerFacts | undefined, role: PlaceRole, family: AuthorFamily): string | null {
  if (f.remote?.agents) return poolPeerRefusal(f, p, role, family);
  const lend = lendRoleOf(role);
  if (!p) return "不在借入名单里（或借入不含本项目）";
  if (!f.remote || f.remote.mode === "off") return "scheduler.json remote.mode = off";
  if (!(f.remote.roles as readonly string[]).includes(lend)) return `scheduler.json remote.roles 不含 ${lend}`;
  if (!p.roles.includes(lend)) return `借入名单对 ${p.peer} 不允许 ${lend}`;
  if (p.priority === "off") return `借入名单把 ${p.peer} 设成 off（不用）`;
  if (!p.v2) return "没有 hello（proto 1，只按老规则在本机满时接审查）";
  if (p.v2.why) return p.v2.why;
  if (!p.v2.roles.includes(lend)) return `对方授权不含 ${lend}`;
  if (!f.repo) return "卡上没有 GitHub 仓库坐标";
  if (!p.v2.repos.some((r) => sameRepo(r, f.repo as string))) return `对方授权的仓库不含 ${f.repo}`;
  if (role === "fix" && f.writeLeasePeer !== p.peer) return "修复单只派回持有本卡写租约的出借方";
  if (!peerFamily(p, role, family)) return role === "review" ? `对方没有空闲的 ${family} 槽` : "对方没有空闲的写代码槽（codex / claude）";
  if (role !== "review" && !f.locksFree) return "文件锁被别的卡占着";
  return null;
}

/** `local` marks this machine; a peer may be named "local" too, so the name never stands for it. */
interface Ranked { where: string; local: boolean; load: number; order: number; tier: Priority }

/** Lower sorts first: fewest running, then the tie-breaks in the header comment. */
function rank(f: PlacementFacts, role: PlaceRole, a: Ranked, b: Ranked): number {
  if (a.load !== b.load) return a.load - b.load;
  const favoured = role === "fix" ? f.writeLeasePeer : role === "review" ? f.lastPeer : null;
  const fav = (r: Ranked) => (favoured && !r.local && r.where === favoured ? 0 : 1);
  if (fav(a) !== fav(b)) return fav(a) - fav(b);
  return Number(a.local) - Number(b.local) || a.order - b.order;
}

const loads = (rows: readonly Ranked[]): string => rows.map((r) => `${r.local ? "本机" : r.where} ${r.load}`).join(" / ");

function toPeer(f: PlacementFacts, name: string, role: PlaceRole, family: AuthorFamily, reason: string): Placement {
  const p = f.peers.find((x) => x.peer === name) as PeerFacts;
  return { kind: "peer", peer: name, family: peerFamily(p, role, family) as AuthorFamily, reason };
}

export function placeFor(f: PlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  if (f.remote?.agents) return placeAgentPool(f, role, family);
  // The pin is where the card is written; its review is placed like any other (cross-family, possibly elsewhere).
  if (f.pin && role !== "review") {
    const name = f.pin.slice(PEER_PLACEMENT.length);
    const why = peerRefusal(f, f.peers.find((p) => p.peer === name), role, family);
    return why ? { kind: "wait", reason: `固定放在 ${f.pin}，它现在不能接：${why}` } : toPeer(f, name, role, family, `start_node 固定放在 ${f.pin}`);
  }
  if (!f.remote || f.remote.mode === "off") {
    const refusal = localFamilyRefusal(f, role, family);
    return refusal ? { kind: "wait", reason: refusal } : { kind: "local", reason: "scheduler.json remote.mode = off，只用本机" };
  }
  const lease = role === "fix" && f.remote.roles.includes("write") ? f.writeLeasePeer : null;
  if (lease) {
    // The lender's branch is the card's branch now: anyone else would have to start over (`ledger lend-reclaim` hands it back).
    const why = f.tried.includes(lease) ? "本轮已试过" : peerRefusal(f, f.peers.find((p) => p.peer === lease), role, family);
    return why ? { kind: "wait", reason: `写租约在 ${lease}，修复单只派回它；它现在不能接：${why}（要换人先 ledger lend-reclaim）` }
      : toPeer(f, lease, role, family, `写租约在 ${lease}，修复单派回它`);
  }
  const first = role === "review" ? f.remote.reviewFirst ?? [] : [];
  const firstWhy = (name: string) => f.tried.includes(name) ? "本轮已试过" : peerRefusal(f, f.peers.find((p) => p.peer === name), role, family);
  const lead = first.find((name) => !firstWhy(name));
  if (lead) return toPeer(f, lead, role, family, `scheduler.json remote.reviewFirst 指定先给 ${lead}`);
  const placed = tiered(f, role, family);
  if (!first.length) return placed;
  return { ...placed, reason: `reviewFirst 里的 peer 都不能接（${first.map((n) => `${n}：${firstWhy(n)}`).join("；")}）；${placed.reason}` };
}

const TIERS: readonly Priority[] = ["first", "balance", "low"];

/** The tiers over this machine and every usable peer; with every machine on balance this is W5's even spread, word for word. */
function tiered(f: PlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  const usable = f.peers.map((p, order) => ({ p, order })).filter(({ p }) => !f.tried.includes(p.peer) && !peerRefusal(f, p, role, family));
  const refusal = localFamilyRefusal(f, role, family);
  const mine = refusal ? "off" : f.remote?.localPriority ?? "balance";
  const rows: Ranked[] = usable.map(({ p, order }) => ({ where: p.peer, local: false, load: p.open, order, tier: p.priority ?? "balance" }));
  if (f.local.room && mine !== "off") rows.push({ where: "本机", local: true, load: f.local.running, order: f.peers.length, tier: mine });
  if (!usable.length) {
    if (mine === "off") return { kind: "wait", reason: refusal ? `${refusal}，又没有能接的 peer：等` : "scheduler.json remote.localPriority = off，又没有能接的 peer：等" };
    return { kind: "local", reason: f.local.room ? "没有可用的 peer，放本机" : "本机满且没有可用的 peer：本机照常排队" };
  }
  const tier = TIERS.find((t) => rows.some((r) => r.tier === t)) as Priority;
  const pool = rows.filter((r) => r.tier === tier);
  const pick = [...pool].sort((a, b) => rank(f, role, a, b))[0];
  const tiers = mine !== "balance" || rows.some((r) => r.tier !== "balance") ? `档位 ${tier}（first → balance → low，off 不派）；` : "";
  const why = `${tiers}在跑：${loads(pool)}；选最少，平手按 ${role === "fix" ? "写租约方 > " : role === "review" ? "复审回上次的 peer > " : ""}peer 先于本机 > 借入顺序`;
  return pick.local ? { kind: "local", reason: why } : toPeer(f, pick.where, role, family, why);
}
