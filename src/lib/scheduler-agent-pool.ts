/** Family is chosen across the whole fleet before machines are ranked; roles and tiers never split a pool. */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { PeerFacts, PlaceRole, Placement, PlacementFacts } from "./scheduler-placement.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import { LOCAL_PLACEMENT, pinnedPeer } from "./scheduler-local-pin.js";
import { reviewLocalFirst, type ReviewLocalFacts } from "./scheduler-agent-pool-review-local.js";
import { writeLocalEqual, type WriteLocalFacts } from "./scheduler-agent-pool-write-local.js";
import { pinTriedNote } from "./lend-return-local.js";

export interface AgentPoolLoad { running: AgentLimits; totals: AgentLimits }
export const zeroAgentCounts = (): AgentLimits => ({ claude: 0, codex: 0 });
const preferred: readonly AuthorFamily[] = ["claude", "codex"];

export function poolPeerRefusal(f: PlacementFacts, p: PeerFacts | undefined, role: PlaceRole, family: AuthorFamily): string | null {
  if (!p) return "不在借入名单里（或借入不含本项目）";
  if (!f.remote || f.remote.mode === "off") return "scheduler.json remote.mode = off";
  if (!p.v2) return "没有 hello，无法核实家族名额";
  if (p.v2.why) return p.v2.why;
  if (!f.repo || !p.v2.repos.some((r) => r.toLowerCase() === f.repo!.toLowerCase())) return "对方未授权本卡仓库";
  if (role === "fix" && f.writeLeasePeer && f.writeLeasePeer !== p.peer) return "修复单只派回写租约方";
  if ((p.v2.slots[family] ?? 0) <= 0) return `等 ${family} 空位`;
  if (role !== "review" && !f.locksFree) return "文件锁被别的卡占着";
  return null;
}

function localPoolRoom(f: PlacementFacts, family: AuthorFamily): boolean {
  const total = f.local.pool?.totals[family] ?? f.remote?.agents?.[family] ?? 0;
  const running = f.local.pool?.running[family] ?? f.local.running;
  return total > running;
}

export function poolPeerFamily(p: PeerFacts, role: PlaceRole, family: AuthorFamily): AuthorFamily | null {
  return (role === "write" ? preferred : [family]).find((f) => (p.v2?.slots[f] ?? 0) > 0) ?? null;
}

function peerRows(f: PlacementFacts, peers: readonly PeerFacts[], role: PlaceRole, selected: AuthorFamily) {
  const rows = peers.filter((p) => !poolPeerRefusal(f, p, role, selected)).map((p, order) => ({
    peer: p.peer, load: p.v2?.familyBusy?.[selected] ?? Math.max(0, (p.v2?.familyTotals?.[selected] ?? p.open) -
      (p.v2?.familyTotals ? p.v2.slots[selected] : 0)), order,
  }));
  return rows.sort((a, b) => a.load - b.load || a.order - b.order);
}

export function placeAgentPool(f: ReviewLocalFacts & WriteLocalFacts, role: PlaceRole, family: AuthorFamily): Placement {
  const placed = placeByLoad(f, role, family);
  // WRITELOCAL1: on = an unpinned write goes to the least loaded of every peer family and this machine's author family.
  const peers = f.peers.filter((p) => !f.tried.includes(p.peer));
  return writeLocalEqual(f, role, placed, (x) => peerRows(f, peers, role, x)[0] ?? null) ?? placed;
}

function placeByLoad(f: ReviewLocalFacts & WriteLocalFacts, role: PlaceRole, family: AuthorFamily): Placement {
  if (role !== "review" && !f.locksFree) return { kind: "wait", reason: "文件锁被别的卡占着" };
  // Review placement keeps its own cross-family rules; writing pinned "local" stays here, never a peer named "".
  const local = role !== "review" && f.pin === LOCAL_PLACEMENT;
  const pin = role !== "review" && !local ? pinnedPeer(f.pin) ?? (role === "fix" ? f.writeLeasePeer : null) : null;
  const peers = local ? [] : f.peers.filter((p) => (!pin || p.peer === pin) && !f.tried.includes(p.peer));
  const families = role === "write" ? preferred : [family];
  for (const selected of families) {
    const rows = peerRows(f, peers, role, selected);
    const here = !pin && (role === "review" || !f.local.family || f.local.family === selected) && localPoolRoom(f, selected);
    const running = f.local.pool?.running[selected] ?? f.local.running;
    if (rows[0] && (!here || rows[0].load <= running)) {
      const first = here ? reviewLocalFirst(f, role, selected, running, rows[0].peer) : null; // REVLOCAL1: on = this machine's free seat first
      if (first) return first;
      return { kind: "peer", peer: rows[0].peer, family: selected, reason: `${selected} 在跑 ${rows[0].load}，最少优先，平手 peer 先` };
    }
    if (here) return { kind: "local", family: selected, reason: `${selected} 本机在跑 ${running}，有空位且负载最少` };
  }
  const waiting = role === "write" ? "claude / codex" : family;
  const tried = pin ? pinTriedNote(f.writeLocal?.card?.project, pin, f.tried) : null; // LENDBACK1: a pin already tried is no seat shortage
  return { kind: "wait", reason: `等 ${waiting} 空位${tried ? `（${tried}）` : pin ? `（固定 ${pin}）` : local ? "（固定本机）" : ""}` };
}

/** Stable within each group, preserving the scheduler's rotation while finishing work before admitting more. */
export function finishFirst<T>(cards: readonly T[], stage: (card: T) => string): T[] {
  return [...cards.filter((c) => ["review", "fix", "merge", "live", "verified"].includes(stage(c))),
    ...cards.filter((c) => !["review", "fix", "merge", "live", "verified"].includes(stage(c)))];
}
