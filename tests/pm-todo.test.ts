import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { importTask } from "../src/lib/ledger-write.js";
import { pmTodos } from "../src/lib/pm-todo.js";

const P = "proj", H = 3600_000, T = 1_000 * H, dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { closeLedger(join(d, "ledger.sqlite")); rmSync(d, { recursive: true, force: true }); } });

function world(): Database {
  const dir = mkdtempSync(join(tmpdir(), "pm-todo-"));
  dirs.push(dir);
  return openLedger(join(dir, "ledger.sqlite"));
}
const card = (db: Database, id: string, stage: "verified" | "live", at = T) => importTask(db, { actor: "owner", now: at }, {
  createdTs: at - H, initialStage: "live", events: stage === "verified" ? [{ kind: "stage", ts: at, data: { from: "live", to: "verified" } }] : [],
  task: { project: P, id, stage, title: id, kind: "code", agent: "agent-w", pm: "agent-pm" },
});
const specs: Record<string, string> = {
  "p-obs": "# p-obs\n\n## 上线后 PM\n观察期：12 小时\n- 看 x 的观察，切 on\n",
  "p-now": "# p-now\n\n## 上线后 PM\n- 部署后核一次 y\n",
  "p-done": "# p-done\n\n## 上线后 PM\n- 已结\n",
  "p-live": "# p-live\n\n## 上线后 PM\n- 还没上线\n",
  "p-none": "# p-none\n\n## 目标\n没有上线后一节\n",
};

test("pm-todo lists verified cards with an open post-launch section; due once the written observation period has passed", () => {
  const db = world();
  for (const id of ["p-obs", "p-now", "p-done", "p-none"]) card(db, id, "verified");
  card(db, "p-live", "live");
  // 结单记录走 `ledger note --dedup`，这里直接插同样的一行
  db.run("INSERT INTO events (ts, actor, project, target, kind, text, dedupKey) VALUES (?, ?, ?, ?, ?, ?, ?)", [T + 1, "agent-pm", P, "p-done", "note", "结了", "post-verify-done:p-done"]);
  const read = (id: string) => specs[id];
  const before = pmTodos(db, P, read, T + 11 * H);
  expect(before.map((t) => [t.task, t.due, t.hours])).toEqual([["p-now", true, null], ["p-obs", false, 12]]);
  expect(before[1].what).toBe("- 看 x 的观察，切 on");
  expect(pmTodos(db, P, read, T + 12 * H).map((t) => [t.task, t.due])).toEqual([["p-now", true], ["p-obs", true]]);
});
