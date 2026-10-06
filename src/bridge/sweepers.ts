/**
 * Periodic sweepers the bridge starts once at boot (the Discord-ready path or the web-only path, never both):
 * the daily archive snapshot (archive-sweeper.ts), the lend lease expiry and the lend key-pin log (local-api/lend.ts),
 * and the state guard (lib/state-backup.ts: hourly snapshot of the key state files, owner push when one vanishes).
 */
import { stateGuard } from "../lib/state-backup.js";
import { startArchiveSweeper } from "./archive-sweeper.js";
import { startLendSweeper, watchLendPins } from "./local-api/lend.js";

export function startSweepers(): void {
  startArchiveSweeper();
  startLendSweeper();
  watchLendPins();
  startStateGuard();
}

function startStateGuard(): void {
  const tick = stateGuard({
    log: (line) => console.error(line),
    notify: (title, body) => void import("./push/init.js").then((m) => m.pushOwnerNotice(title, body))
      .catch((e) => console.error(`⚠️ 状态文件消失提醒没推出去: ${(e as Error).message}`)),
  });
  tick(); // 启动就快照一份并记下哪些文件在：之后每分钟一拍
  setInterval(tick, 60_000).unref?.();
}
