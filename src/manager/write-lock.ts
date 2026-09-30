/**
 * The command-level write lock every state-changing manager run takes, and the scheduler lease gate right behind it.
 * cron and CLI runs race on registry and the other state files (load → mutate → save; saveRegistry only prevents torn
 * writes, not lost updates), so one lock serialises every write command. Not getting it in 20s degrades to running
 * anyway: advisory, an old race rather than a stuck command. Process exit releases it as a backstop.
 * A child of the scheduler service reads its lease first (lib/scheduler-lease-env.ts); once it holds the lock, a lease
 * already lost or a service already stopped means this run does nothing at all.
 */
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { adoptSchedulerLease, schedulerLeaseRefusal } from "../lib/scheduler-lease-env.js";
import { output } from "./core.js";
import { needsWriteLock, PRINCIPALS_WRITE_COMMANDS } from "./write-commands.js";

export async function takeWriteLocks(cmd: string, args: string[]): Promise<{ release: () => void } | null> {
  adoptSchedulerLease(); // read once and dropped from env, so nothing this run spawns inherits it
  let writeLock: { release: () => void } | null = null;
  if (needsWriteLock(cmd, args)) {
    writeLock = await acquireLock(statePath(".manager-write.lock"));
    if (!writeLock) console.error("⚠ 写锁 20s 未拿到,降级继续(并发写命令可能竞态)");
    else process.on("exit", () => writeLock?.release());
    // 写 principals 的命令另持 principals 锁，与 bridge 的设备凭据写（updatePrincipals）互斥
    const pLock = PRINCIPALS_WRITE_COMMANDS.has(cmd) ? await acquireLock((await import("../lib/principals.js")).principalsLockPath()) : null;
    if (pLock) process.on("exit", () => pLock.release());
  }
  const leaseLost = schedulerLeaseRefusal();
  if (leaseLost) { output({ ok: false, code: "lease-lost", error: leaseLost }); writeLock?.release(); process.exit(1); }
  return writeLock;
}
