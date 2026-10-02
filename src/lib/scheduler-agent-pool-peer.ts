/** One conversion used by planning, start_node and autostart; preserve the peer's family counts. */
import type { PoolFacts } from "./scheduler-pool-plan.js";
import type { PeerFacts } from "./scheduler-placement.js";
export const peerFacts = (x: PoolFacts["peers"][number]): PeerFacts =>
  ({ peer: x.peer, roles: x.roles ?? ["review"], open: x.open, v2: x.v2 ?? null, ...(x.priority ? { priority: x.priority } : {}) });
