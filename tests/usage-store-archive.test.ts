/**
 * 超过 30 天不丢（UXUSAGE1 验收线 2，src/lib/usage-store.ts archiveTaskUsage）：清理明细时把要删的、已归属到卡的调用按 卡 × 家族 累加进归档，
 * 与删除同一事务；清理前后卡的总数不变（归档 + 明细），重复清理不重复累加；归档上线前已清掉的日子在迁移时记下。
 */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { taskUsageFacts } from "../src/lib/usage-query.js";
import { openUsageDb, pruneUsage, retentionCutoff } from "../src/lib/usage-store.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-13T12:00:00+09:00");
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let seq = 0;
function call(u: Database, at: number, opts: { task?: string | null; runtime?: string; session?: string; tokens?: number } = {}) {
  const id = `t${++seq}`;
  u.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime, attr_task, attr_basis)
    VALUES (?, 'a', ?, 0, ?, 'channel', '', ?, ?, 'session')`).run(id, opts.session ?? `s-${id}`, at, opts.runtime ?? "claude-code", opts.task === undefined ? "T1" : opts.task);
  u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) VALUES (?, ?, ?, ?, 'm', ?, 1, 2, 3, 4)`)
    .run(`${id}:0`, id, at, localDay(at), opts.tokens ?? 10);
}

/** 卡的总数 = 归档 + 明细，按家族 */
function totals(u: Database, task = "T1") {
  const f = taskUsageFacts(u, task);
  const out: Record<string, { tokens: number; calls: number }> = {};
  for (const p of [...f.detail, ...f.archive]) {
    const cur = (out[p.family] ??= { tokens: 0, calls: 0 });
    cur.tokens += p.totalTokens;
    cur.calls += p.calls;
  }
  return { out, sessions: f.sessions };
}

test("[验收线 2] 时钟拨过 30 天触发清理：归档 + 明细 = 清理前总数；重复清理不重复累加", () => {
  const u = openUsageDb(":memory:");
  call(u, NOW - 40 * DAY, { session: "old" });
  call(u, NOW - 35 * DAY, { runtime: "codex", session: "old-cx" });
  call(u, NOW - 2 * DAY, { session: "old" }); // 同一会话跨过清理线：会话只计一次
  call(u, NOW - 40 * DAY, { task: null }); // 未归属的不进归档
  call(u, NOW - 40 * DAY, { task: "T2" });
  const before = totals(u);
  expect(before.out).toEqual({ claude: { tokens: 40, calls: 2 }, codex: { tokens: 20, calls: 1 } });
  const cutoff = retentionCutoff(NOW);
  expect(pruneUsage(u, cutoff)).toBe(4);
  expect(totals(u)).toEqual(before);
  expect(taskUsageFacts(u, "T1").archive.map((p) => [p.family, p.calls])).toEqual([["claude", 1], ["codex", 1]]);
  expect(totals(u, "T2").out).toEqual({ claude: { tokens: 20, calls: 1 } });
  expect(pruneUsage(u, cutoff)).toBe(0);
  expect(pruneUsage(u, retentionCutoff(NOW + DAY))).toBe(0);
  expect(totals(u)).toEqual(before);
});

test("[验收线 2] 归档只在清理时写：重算归属改了 attr_task 不影响已归档的数", () => {
  const u = openUsageDb(":memory:");
  call(u, NOW - 40 * DAY);
  call(u, NOW - DAY);
  pruneUsage(u, retentionCutoff(NOW));
  u.prepare("UPDATE turns SET attr_task = 'T1'").run(); // 重算归属只改明细：归档不随之变
  expect(totals(u).out).toEqual({ claude: { tokens: 40, calls: 2 } });
  expect(u.query("SELECT COUNT(*) AS n FROM task_usage_archive").get()).toEqual({ n: 1 });
});

test("归档上线前已清掉明细的日子：迁移时记下明细最早一天，没丢过就不记", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-archive-")), "usage.sqlite");
  let u = openUsageDb(path);
  expect(taskUsageFacts(u, "T1").unarchivedBefore).toBeNull();
  call(u, NOW - 3 * DAY);
  u.prepare(`INSERT INTO daily (day, agent, runtime, model, calls, input, cache_creation, cache_read, output, reasoning)
    VALUES ('2026-08-01', 'a', 'claude-code', 'm', 1, 1, 1, 1, 1, 0)`).run();
  u.prepare("DROP TABLE usage_meta").run();
  u.exec("PRAGMA user_version = 6"); // 回到归档上线前的版本，重开时跑 v7 迁移
  u.close();
  u = openUsageDb(path);
  const f = taskUsageFacts(u, "T1");
  expect(f.unarchivedBefore).toBe(localDay(NOW - 3 * DAY));
  expect(f.detailFrom).toBe(localDay(NOW - 3 * DAY));
  u.close();
});
