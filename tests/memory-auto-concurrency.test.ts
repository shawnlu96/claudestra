import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { recordMemory, markMemory, listMarks, memoryState } from "../src/lib/ledger-memory.js";
import { testChildEnv } from "./test-env.js";

// Separate OS processes share only the private fixture ledger, so the receipt check really races the writer lock.
test("two independent observers of one merge commit only one fixed mark", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-auto-race-"));
  const path = join(dir, "ledger.sqlite"); const db = openLedger(path);
  try {
    ledgerOrigin(db, () => "ab12");
    createTask(db, { actor: "owner", now: 1 }, { id: "FIX", project: "demo", kind: "code", title: "Atomic writes" });
    const m = recordMemory(db, { actor: "agent-reviewer", now: 2 }, { project: "demo", kind: "pitfall", title: "Transaction boundaries",
      symptom: "Concurrent reads skip a revision", rule: "Keep writes and revision in one transaction", fixable: true,
      family: "widgettx", files: ["src/lib/widget-store.ts"], via: "tool", authorRole: "reviewer", sourceNote: "fixture review" }).memory;
    markMemory(db, { actor: "owner", now: 3 }, { memoryId: m.id, mark: "link_fix", taskId: "FIX" });
    db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'FIX'").run();
    const stage = moveStage(db, { actor: "owner", now: 4 }, { taskId: "FIX", from: "merge", to: "live" }).event;
    const modulePath = resolve("src/lib/memory-auto.ts");
    const script = `import {Database} from 'bun:sqlite'; import {observeMemory} from ${JSON.stringify(modulePath)};
      const db=new Database(${JSON.stringify(path)}); db.run('PRAGMA busy_timeout=5000');
      const result=await observeMemory(db,'scheduler','demo',{assertLease:()=>{}}); db.close(); console.log(JSON.stringify(result));`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", script], {
      env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe", cwd: dir,
    }));
    for (const child of children) {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, err }).toEqual({ code: 0, err: "" }); expect(JSON.parse(out).rejected).toEqual([]);
    }
    expect(memoryState(db, m.id)!.status).toBe("fixed");
    const marks = listMarks(db, m.id).filter((mk) => mk.mark === "fixed");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.dedupKey).toBe(`auto:fixed:${m.id}:FIX:ab12/${stage.originSeq}`);
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
