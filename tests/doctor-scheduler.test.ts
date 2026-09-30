import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulerJournal } from "../src/lib/doctor-scheduler.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { DEPLOY_LABEL_PREFIX } from "../src/lib/scheduler-deploy-job.js";
import type { runBounded } from "../src/lib/run-bounded.js";

test("doctor surfaces unknown merge journals and deployment labels stuck in the KeepAlive relaunch loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-doctor-")), path = join(root, "ledger.db"), db = new Database(path);
  db.exec("PRAGMA user_version=1; CREATE TABLE scheduler_merges(intentId TEXT,taskId TEXT,project TEXT,phase TEXT,reason TEXT,updatedAt INTEGER)");
  db.exec("INSERT INTO scheduler_merges VALUES ('m1','T1','p','unknown','gh timeout',1), ('m2','T2','p','done',NULL,1)");
  db.close();
  const stale = `${DEPLOY_LABEL_PREFIX}${"a".repeat(32)}`, running = `${DEPLOY_LABEL_PREFIX}${"b".repeat(32)}`;
  const command: typeof runBounded = async () => ({ code: 0, timedOut: false, stderr: "",
    stdout: `PID\tStatus\tLabel\n-\t1\t${stale}\n42\t0\t${running}\n-\t0\tcom.example.other\n` });
  try {
    const checks = await checkSchedulerJournal(new LedgerReader(path), command);
    expect(checks[0].status).toBe("warn");
    expect(String(checks[0].detail)).toContain("p/T1（m1）");
    expect(checks[0].fix).toContain("scheduler-merge-resolve");
    if (process.platform === "darwin") {
      const detail = String(checks[1].detail);
      expect(checks[1].status).toBe("warn");
      expect(detail.includes(stale) && !detail.includes(running)).toBe(true);
    }
    const empty = await checkSchedulerJournal(new LedgerReader(join(root, "missing.db")), async () => ({ code: 0, timedOut: false, stderr: "", stdout: "" }));
    expect(empty[0]).toMatchObject({ status: "ok" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
