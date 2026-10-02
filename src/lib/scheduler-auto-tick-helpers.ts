import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import type { BorrowEntry } from "./lend-config.js";
import type { RemotePolicy } from "./scheduler-config.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";

/** One borrow read per pass, and only when some project may pool; an unreadable lend.json pools nothing (fail-closed). */
function poolReader(deps: AutoTickDeps) {
  let borrow: Promise<BorrowEntry[]> | null = null;
  return async (remote: RemotePolicy | undefined): Promise<SnapshotOpts["pool"]> => {
    if (!remote || !deps.borrow) return undefined;
    if (remote.mode === "off") return { remote, borrow: [] };
    borrow ??= deps.borrow().catch((e: unknown) => { console.error(`⚠️ [scheduler] 读 lend.json 借入名单失败，本轮不挂池：${(e as Error).message}`); return []; });
    return { remote, borrow: await borrow };
  };
}

export { poolReader };
