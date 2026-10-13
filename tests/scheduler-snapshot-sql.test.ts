/**
 * 调度快照的三条慢查询改走索引（dispatch-recovery-SNAPSQL1）：生产 SQL 的查询计划、新旧 SQL 结果逐行一致、dedupKey 前缀的写入方钉住。
 * 旧 SQL 只作等价参照抄在这里；台账没有 sqlite_stat1，合成库与线上库的计划一致。
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOSTART_DEDUP_PREFIX, claimDedup, DAG_START_DEDUP_PREFIX, dedupRangeEnd, settleDedup } from "../src/lib/ledger-autostart-grant.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { STARTS_SQL, workingSeats } from "../src/lib/scheduler-agent-pool-ledger.js";
import { CLAIMS_SQL, LEND_ORDERS_SQL, localWriteOwner, writeSlotFacts } from "../src/lib/scheduler-slot-hold-facts.js";

const OLD_STARTS = `SELECT DISTINCT t.agent, w.authorFamily AS family FROM events e JOIN tasks t
      ON t.id=CASE WHEN json_extract(e.data,'$.op')='autostart_claim' THEN json_extract(e.data,'$.taskId') ELSE e.target END
      JOIN task_workflows w ON w.taskId=t.id WHERE e.project=? AND t.id!=?
      AND ((json_extract(e.data,'$.op')='autostart_claim' AND json_extract(e.data,'$.peer') IS NULL)
        OR (w.mode='auto' AND e.kind='task' AND json_extract(e.data,'$.op')='set' AND e.dedupKey LIKE 'dag-start:%:task-set'))
      AND t.stage IN ('spec','restate','build','fix') AND t.agent IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId=t.id AND s.role='author')
      AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action='ensure_session'
        AND i.node IN ('restate','write','fix') AND i.status IN ('submitted','unknown'))`;
const OLD_CLAIMS = `SELECT json_extract(e.data, '$.taskId') AS taskId FROM events e WHERE e.project = ?
    AND json_extract(e.data, '$.op') = 'autostart_claim' AND json_extract(e.data, '$.peer') IS NULL
    AND NOT EXISTS (SELECT 1 FROM events s WHERE s.dedupKey = 'autostart-settle:' || e.seq)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = json_extract(e.data, '$.taskId'))`;
/** 候选行（不 JOIN 任务）：新旧两种 events 访问方式圈出的 claim / task-set 行应完全相同 */
const OLD_CANDIDATES = `SELECT seq FROM events e WHERE e.project=? AND (json_extract(e.data,'$.op')='autostart_claim'
  OR (e.kind='task' AND json_extract(e.data,'$.op')='set' AND e.dedupKey LIKE 'dag-start:%:task-set')) ORDER BY seq`;
const NEW_CANDIDATES = `SELECT seq FROM events e WHERE +e.project=?
  AND ((e.dedupKey >= 'autostart:' AND e.dedupKey < 'autostart;') OR (e.dedupKey >= 'dag-start:' AND e.dedupKey < 'dag-start;'))
  AND (json_extract(e.data,'$.op')='autostart_claim'
  OR (e.kind='task' AND json_extract(e.data,'$.op')='set' AND e.dedupKey LIKE 'dag-start:%:task-set')) ORDER BY seq`;
const OLD_LEND = "SELECT step, status FROM lend_orders WHERE taskId = ?";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function ledger(): Database {
  const dir = mkdtempSync(join(tmpdir(), "snapsql-")), path = join(dir, "ledger.sqlite");
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  return openLedger(path);
}

const plan = (db: Database, sql: string, ...args: (string | null)[]): string[] =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail);

/** 读旧 SQL 的同一个库：query 遇到生产 SQL 就换成旧 SQL，其余原样，用来比 workingSeats / writeSlotFacts 的返回值 */
function withOldSql(db: Database): Database {
  const swap = new Map([[STARTS_SQL, OLD_STARTS], [CLAIMS_SQL, OLD_CLAIMS], [LEND_ORDERS_SQL, OLD_LEND]]);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "query") return (sql: string) => target.query(swap.get(sql) ?? sql);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

let seq = 0;
function event(db: Database, project: string, target: string, kind: string, data: Record<string, unknown>, dedupKey: string | null): number {
  return Number(db.query("INSERT INTO events (ts, actor, project, target, kind, data, dedupKey) VALUES (?, 'pm', ?, ?, ?, ?, ?)")
    .run(++seq, project, target, kind, JSON.stringify(data), dedupKey).lastInsertRowid);
}
function task(db: Database, id: string, stage: string, agent: string | null, mode: string | null, project = "p", extra: Record<string, unknown> = {}): void {
  db.query("INSERT INTO tasks (id, project, title, kind, stage, agent, extra, createdAt, updatedAt) VALUES (?, ?, ?, 'code', ?, ?, ?, 0, 0)")
    .run(id, project, id, stage, agent, JSON.stringify(extra));
  if (mode) db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, 'code', 2, ?, ?, 'pm', 1, 0, 0)`).run(id, project, mode, id.endsWith("x") ? "codex" : "claude");
}
function intent(db: Database, id: string, taskId: string, node: string, status: string, project = "p"): void {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'ensure_session', 1, 1, 1, 2, ?, 'r', 0, 0)`).run(id, taskId, project, node, status);
}
function session(db: Database, taskId: string, agent: string): void {
  intent(db, `create:${taskId}`, taskId, "write", "done");
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, 'author', ?, ?, 'claude', 'tmux', 'active', ?, 0, 0)`).run(taskId, agent, `sid-${taskId}`, `create:${taskId}`);
}
const claim = (db: Database, project: string, feature: string, key: string, taskId: string, agent: string, peer: unknown = null): number =>
  event(db, project, feature, "feature", { op: "autostart_claim", key, taskId, agent, peer }, claimDedup(feature, key, "a1"));
const taskSet = (db: Database, project: string, taskId: string, step = "task-set", attempt = "a1"): number =>
  event(db, project, taskId, "task", { op: "set" }, `${DAG_START_DEDUP_PREFIX}${taskId}:${attempt}:${step}`);

/** 覆盖规格列的各类情况；返回所有任务 id（逐个当 exceptTask） */
function seed(db: Database): string[] {
  const ids: string[] = [];
  const t = (id: string, stage: string, agent: string | null, mode: string | null, project = "p", extra: Record<string, unknown> = {}) => {
    task(db, id, stage, agent, mode, project, extra); ids.push(id);
  };
  // 每个 stage × auto / 非 auto 的 dag-start task-set，同前缀的其他步骤
  for (const stage of ["spec", "restate", "build", "fix", "review", "merge", "done"]) {
    for (const mode of ["auto", "manual", "observe"]) {
      const id = `S-${stage}-${mode}${stage === "fix" ? "x" : ""}`;
      t(id, stage, `agent-${id}`, mode);
      taskSet(db, "p", id); taskSet(db, "p", id, "task-new"); taskSet(db, "p", id, "agent");
    }
  }
  t("S-noagent", "build", null, "auto"); taskSet(db, "p", "S-noagent");
  t("S-noflow", "build", "agent-noflow", null); taskSet(db, "p", "S-noflow");
  // 有 / 没有 author session；有 submitted / unknown / done 的 ensure_session 意图；同一 agent 两张卡
  t("S-sess", "build", "agent-sess", "auto"); taskSet(db, "p", "S-sess"); session(db, "S-sess", "agent-sess");
  t("S-sub", "build", "agent-sub", "auto"); taskSet(db, "p", "S-sub"); intent(db, "i-sub", "S-sub", "write", "submitted");
  t("S-unk", "fix", "agent-unk", "auto"); taskSet(db, "p", "S-unk"); intent(db, "i-unk", "S-unk", "fix", "unknown");
  t("S-done", "spec", "agent-shared", "auto"); taskSet(db, "p", "S-done", "task-set", "a2"); intent(db, "i-done", "S-done", "restate", "done");
  t("S-other-node", "build", "agent-shared", "auto"); taskSet(db, "p", "S-other-node"); intent(db, "i-on", "S-other-node", "adversarial_review", "submitted");
  // claim：未结 / 已结 / 带 peer；对应任务已存在 / 不存在
  claim(db, "p", "F1", "n1", "C-open-missing", "agent-c1");
  claim(db, "p", "F1", "n2", "C-peer-missing", "agent-c2", { name: "Sekai", repo: "r", reason: "x" });
  const settled = claim(db, "p", "F1", "n3", "C-settled-missing", "agent-c3");
  event(db, "p", "F1", "feature", { op: "autostart_settle", result: "failed" }, settleDedup(settled));
  t("C-open-exists", "spec", "agent-c4", "manual"); claim(db, "p", "F2", "n1", "C-open-exists", "agent-c4");
  t("C-open-built", "build", "agent-c5x", "auto"); claim(db, "p", "F2", "n2", "C-open-built", "agent-c5x");
  t("C-peer-exists", "spec", "agent-c6", "auto"); claim(db, "p", "F2", "n3", "C-peer-exists", "agent-c6", { name: "Sekai", repo: "r", reason: "x" });
  t("C-settled-exists", "restate", "agent-c7", "auto"); event(db, "p", "F2", "feature", { op: "autostart_settle" },
    settleDedup(claim(db, "p", "F2", "n4", "C-settled-exists", "agent-c7")));
  t("C-review", "review", "agent-c8", "auto"); claim(db, "p", "F2", "n5", "C-review", "agent-c8");
  // 行序敏感：dedupKey 序与 (target, seq) 序相反的 claim；同一 agent 两个家族、dag-start 键序与事件序相反
  claim(db, "p", "Zfeat", "k", "Z-a", "agent-za"); claim(db, "p", "Yfeat", "k", "Z-b", "agent-zb");
  claim(db, "p", "Aa", "z", "Z-c", "agent-zc", { name: "Sekai", repo: "r", reason: "x" });
  t("A-twinx", "build", "agent-twin", "auto"); t("B-twin", "build", "agent-twin", "auto");
  taskSet(db, "p", "B-twin", "task-set", "a0"); taskSet(db, "p", "A-twinx", "task-set", "z9");
  // op 相同但 dedupKey 不在区间里：手写的 set、没有 dedupKey 的 set、settle 行；以及其他项目的同形事件
  t("O-set", "build", "agent-o", "auto");
  event(db, "p", "O-set", "task", { op: "set" }, "manual:O-set:task-set");
  event(db, "p", "O-set", "task", { op: "set" }, null);
  event(db, "p", "O-set", "task", { op: "set" }, "dag-startx:O-set:a1:task-set");
  event(db, "p", "O-set", "task", { op: "set", note: "dag-start:O-set:a1:task-set" }, "dag-start;O-set");
  t("Q-1", "build", "agent-q", "auto", "q"); taskSet(db, "q", "Q-1"); claim(db, "q", "FQ", "n1", "Q-missing", "agent-q2");
  claim(db, "q", "FQ", "n2", "S-build-auto", "agent-cross");
  // 外加一些无关事件（project 索引在线上就是被这类行拖垮的）
  for (let i = 0; i < 50; i++) event(db, "p", `S-build-auto`, "note", { op: "note", i }, i % 2 ? `note:${i}` : null);
  // writeSlotFacts：已持有的 slot、stale slot、peer 放置、lend 单
  t("W-build", "build", "agent-w", "auto"); intent(db, "i-w", "W-build", "write", "done");
  db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt) VALUES ('p', 'slot:p:0', 'W-build', 'i-w', 0)").run();
  db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt) VALUES ('p', 'slot:p:1', 'S-done', 'i-done', 0)").run();
  t("W-peer", "spec", "agent-wp", "auto", "p", { placement: "peer:Sekai" });
  t("W-lent", "build", "agent-wl", "auto");
  for (const [n, status] of [["1", "done"], ["2", "pooled"]] as const) {
    db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status,
      leaseMs, createdBy, createdAt, updatedAt) VALUES (?, 'W-lent', 'p', 'Sekai', 'claude', 'write', 1, 0, 'h', 'r', 'w', 't', 's', ?, 1, 'pm', 0, 0)`)
      .run(`o-${n}`, status);
  }
  return ids;
}

test("[验收线 1] 生产 SQL 的计划：events 走 dedupKey 唯一索引的区间，lend_orders 走 lend_orders_task", () => {
  const db = ledger();
  for (const [sql, args] of [[STARTS_SQL, ["p", "x"]], [CLAIMS_SQL, ["p"]]] as const) {
    const details = plan(db, sql, ...args);
    const onE = details.filter((d) => /^(SCAN|SEARCH) e\b/.test(d));
    expect(onE.length).toBeGreaterThan(0);
    for (const d of onE) expect(d).toBe("SEARCH e USING INDEX sqlite_autoindex_events_1 (dedupKey>? AND dedupKey<?)");
    expect(details.join("\n")).not.toContain("events_project_target");
  }
  expect(plan(db, STARTS_SQL, "p", "x")).toContain("MULTI-INDEX OR");
  const lend = plan(db, LEND_ORDERS_SQL, "T");
  expect(lend).toEqual(["SEARCH lend_orders USING INDEX lend_orders_task (taskId=?)"]);
  // 参照：旧 SQL 在同一个库上走 project 索引 / 整表扫（main 上的现状）
  expect(plan(db, OLD_STARTS, "p", "x").join("\n")).toContain("events_project_target");
  expect(plan(db, OLD_CLAIMS, "p").join("\n")).toContain("events_project_target");
});

test("[验收线 2] 新旧 SQL 结果逐行一致：每个 exceptTask 的 starts、claims、候选行、lend_orders", () => {
  const db = ledger(), ids = seed(db);
  for (const project of ["p", "q", "none"]) {
    for (const except of [...ids, "", "C-open-missing"]) {
      // 行序也要一致：claim 的顺序决定 slot 号，starts 的首行决定同名 agent 的家族
      expect(JSON.stringify(db.query(STARTS_SQL).all(project, except))).toBe(JSON.stringify(db.query(OLD_STARTS).all(project, except)));
    }
    expect(JSON.stringify(db.query(CLAIMS_SQL).all(project))).toBe(JSON.stringify(db.query(OLD_CLAIMS).all(project)));
    expect(db.query(NEW_CANDIDATES).all(project)).toEqual(db.query(OLD_CANDIDATES).all(project));
  }
  for (const id of ids) expect(db.query(LEND_ORDERS_SQL).all(id)).toEqual(db.query(OLD_LEND).all(id));
  // 合成数据确实打到了各分支：starts、claims 都非空，候选行包含 claim 和 task-set
  expect(db.query(STARTS_SQL).all("p", "").length).toBeGreaterThan(3);
  // 旧计划的行序是 (target, seq)，和 dedupKey 序不同：这几条 claim 的 dedupKey 序是 Z-a、Z-b、C-open-missing
  expect((db.query(CLAIMS_SQL).all("p") as { taskId: string }[]).map((r) => r.taskId)).toEqual(["C-open-missing", "Z-b", "Z-a"]);
  const twin = (db.query(STARTS_SQL).all("p", "") as { agent: string; family: string }[]).filter((r) => r.agent === "agent-twin");
  expect(twin).toEqual([{ agent: "agent-twin", family: "codex" }, { agent: "agent-twin", family: "claude" }]);
  expect(db.query(LEND_ORDERS_SQL).all("W-lent")).toHaveLength(2);
});

test("[验收线 2] workingSeats、writeSlotFacts、localWriteOwner 的返回值新旧一致", () => {
  const db = ledger(), ids = seed(db), old = withOldSql(db);
  for (const project of ["p", "q"]) {
    for (const except of [null, ...ids]) expect([...workingSeats(db, project, except)!]).toEqual([...workingSeats(old, project, except)!]);
    expect(JSON.stringify(writeSlotFacts(db, project), (_, v) => v instanceof Set ? [...v] : v))
      .toBe(JSON.stringify(writeSlotFacts(old, project), (_, v) => v instanceof Set ? [...v] : v));
  }
  const tasks = db.query("SELECT id, stage FROM tasks").all() as { id: string; stage: string }[];
  for (const t of tasks) {
    const card = { id: t.id, stage: t.stage } as Parameters<typeof localWriteOwner>[1];
    expect(localWriteOwner(db, card)).toBe(localWriteOwner(old, card));
  }
  // 代理确实换上了旧 SQL（否则上面是自己比自己）
  let used = false;
  const spy = new Proxy(old, { get: (t, p) => p === "query" ? (sql: string) => { used ||= sql === STARTS_SQL; return t.query(sql); } : Reflect.get(t, p) });
  workingSeats(spy, "p"); expect(used).toBe(true);
  expect(workingSeats(db, "p")!.size).toBeGreaterThan(3);
});

test("[验收线 3] 写入方钉住：claim 和 dag-start 的 key 都在各自前缀区间里", () => {
  expect(AUTOSTART_DEDUP_PREFIX).toBe("autostart:"); expect(DAG_START_DEDUP_PREFIX).toBe("dag-start:");
  expect(dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)).toBe("autostart;");
  expect(dedupRangeEnd(DAG_START_DEDUP_PREFIX)).toBe("dag-start;");
  expect(() => dedupRangeEnd("autostart")).toThrow();
  for (const key of [claimDedup("F", "n", "a1"), claimDedup("feat-x", "write", "arm:2")]) {
    expect(key.startsWith(AUTOSTART_DEDUP_PREFIX)).toBe(true);
    expect(key >= AUTOSTART_DEDUP_PREFIX && key < dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)).toBe(true);
  }
  // settle 行不在 claim 区间里（claims 查询的 NOT EXISTS 仍靠它判结清）
  expect(settleDedup(7) < AUTOSTART_DEDUP_PREFIX || settleDedup(7) >= dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)).toBe(true);
  // start_node 两处拼 key 都经导出常量（函数未导出，钉源码）
  const root = join(import.meta.dir, "..", "src", "lib");
  const steps = readFileSync(join(root, "dag-tools-steps.ts"), "utf8"), settle = readFileSync(join(root, "dag-start-settle.ts"), "utf8");
  expect(steps).toContain("const dedup = (io: StepIO, p: StartPlan, step: string) => `${DAG_START_DEDUP_PREFIX}${p.taskId}:${io.attempt}:${step}`;");
  expect(settle).toContain("const startDedup = (taskId: string, attempt: string, step: string): string => `${DAG_START_DEDUP_PREFIX}${taskId}:${attempt}:${step}`;");
  for (const src of [steps, settle]) expect(src).toContain('import { DAG_START_DEDUP_PREFIX } from "./ledger-autostart-grant.js";');
  // 生产 SQL 引用的是同一组常量算出的区间
  for (const p of [AUTOSTART_DEDUP_PREFIX, DAG_START_DEDUP_PREFIX]) expect(STARTS_SQL).toContain(`e.dedupKey >= '${p}' AND e.dedupKey < '${dedupRangeEnd(p)}'`);
  expect(CLAIMS_SQL).toContain(`e.dedupKey >= '${AUTOSTART_DEDUP_PREFIX}' AND e.dedupKey < '${dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)}'`);
});
