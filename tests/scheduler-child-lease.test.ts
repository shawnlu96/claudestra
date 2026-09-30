/**
 * T68h scope 1 (T68f-r5-adv.md P1-1): a real ledger `scheduler-session-bind` child that is still queued on the manager
 * write lock when the scheduler stops (maintenance lease taken over / SIGTERM / scheduler.pid taken over) writes nothing
 * once the lock is free: no binding, no registry kind. The test holds the instance's `.manager-write.lock`, lets every
 * earlier ledger child through one at a time, and stops the daemon only when the bind child is the one waiting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { acquireLock, type LockHandle } from "../src/lib/file-lock.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { cleanupDaemons, intents, setup, start, until, type Svc } from "./scheduler-daemon-harness.js";

afterEach(cleanupDaemons);

function children(pid: number): { pid: number; args: string }[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "ppid=,pid=,args="]).stdout.toString();
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && Number(m[1]) === pid)
    .map((m) => ({ pid: Number(m[2]), args: m[3] }));
}

const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; /* ESRCH: exited */ } };

/** Returns the manager write lock, held, with the daemon's session-bind child queued behind it. */
async function queueBind(s: Svc): Promise<LockHandle> {
  const path = join(s.state, ".manager-write.lock");
  let lock = await acquireLock(path, 0);
  for (const end = Date.now() + 40_000; Date.now() < end; await Bun.sleep(15)) {
    const kids = children(s.child!.pid).filter((k) => k.args.includes("manager.ts"));
    if (kids.some((k) => k.args.includes("scheduler-session-bind"))) return lock!;
    if (!kids.length) continue;
    lock!.release();
    for (const k of kids) await until(() => gone(k.pid), 20_000);
    lock = await acquireLock(path, 5_000);
  }
  throw new Error("session-bind never queued");
}

function bindings(s: Svc): { agent: string }[] {
  const path = join(s.state, "ledger.sqlite"), db = openLedger(path);
  try { return db.query("SELECT agent FROM scheduler_sessions WHERE taskId = 'T1'").all() as { agent: string }[]; }
  finally { closeLedger(path); }
}
const kindOf = (s: Svc): unknown => JSON.parse(readFileSync(join(s.state, "registry.json"), "utf8")).agents["agent-task-0"].kind;

const STOPS: Record<string, (s: Svc) => void> = {
  "maintenance lease taken over": (s) => writeFileSync(join(s.lockPath, "owner"), "update-took-over"),
  "SIGTERM": (s) => { s.child!.kill("SIGTERM"); },
  "scheduler.pid taken over": (s) => writeFileSync(join(s.state, "scheduler.pid", "owner"), "another-scheduler"),
};

describe("a ledger child queued on the write lock re-checks the service's lease before it writes", () => {
  for (const [name, stop] of Object.entries(STOPS)) {
    test(`${name}: once the lock is free the queued session-bind writes no binding and no registry kind`, async () => {
      const s = setup(["T1"]);
      start(s);
      const lock = await queueBind(s);
      const bind = children(s.child!.pid).find((k) => k.args.includes("scheduler-session-bind"))!;
      expect(bindings(s)).toEqual([]);
      expect(kindOf(s)).toBeUndefined();
      stop(s);
      await Bun.sleep(300);
      lock.release();
      expect(await until(() => gone(bind.pid), 20_000)).toBe(true);
      expect(await until(() => s.child!.exitCode !== null, 20_000)).toBe(true);
      expect(bindings(s)).toEqual([]);
      expect(kindOf(s)).toBeUndefined();
      expect(intents(s).find((i) => i.action === "ensure_session")?.status).toBe("submitted");
    }, 90_000);
  }

  test("positive control: nothing stops, the same queued bind writes once the lock is free", async () => {
    const s = setup(["T1"]);
    start(s);
    const lock = await queueBind(s);
    lock.release();
    expect(await until(() => bindings(s).length > 0, 20_000)).toBe(true);
    expect(bindings(s)).toEqual([{ agent: "agent-task-0" }]);
    expect(await until(() => kindOf(s) === "worker", 5_000)).toBe(true);
  }, 90_000);
});
