/**
 * agents-ACTIONSTATE1 事实收集：固定 now 的同卡在总览、详情、完成分页、工作行得到相同 actionState；无 taskId 行 / legacy 行有覆盖；
 * 只读（query_only 下跑、total_changes 不变）；ask / 心跳 / CI 的证据口径；actions 不带正文或凭据。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store";
import { appendEvent, createTask } from "../src/lib/ledger-write";
import { projectView, taskDetail } from "../src/lib/ledger-read";
import { donePage } from "../src/lib/ledger-read-done";
import { workBoard } from "../src/lib/ledger-work-board";
import type { AttentionCtx } from "../src/lib/ledger-attention-facts";
import { STUCK_MS } from "../src/lib/action-state-thresholds";

const NOW = 50 * 3_600_000;
const MIN = 60_000;
const H1 = "1".repeat(40), H2 = "2".repeat(40);
const FACTS: AttentionCtx = { frozen: new Set(["frozen"]), spec: () => null };
let db: Database;
beforeEach(() => { db = openLedger(":memory:"); });
afterEach(() => closeLedger(":memory:"));

function task(id: string, stage = "build", auto = true, at = NOW - 10 * MIN) {
  createTask(db, { actor: "owner", now: at }, { id, project: "p", title: id, kind: "code", stage: stage as never, agent: `agent-${id}`, spec: "s.md" });
  if (auto) db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
    VALUES (?,'p','code',2,'observe','codex','PM',1,1,0,0)`).run(id);
}
function askRow(id: string, taskId: string, over: { assignee?: string; state?: string; expiresAt?: number; kind?: string; source?: string } = {}) {
  db.query(`INSERT INTO asks (id,project,taskId,source,kind,blocking,title,body,expiresAt,state,assignee,createdAt,updatedAt)
    VALUES (?,'p',?,?,?,0,'机密标题','机密正文 token=abc',?,?,?,?,?)`)
    .run(id, taskId, over.source ?? "human", over.kind ?? "decide", over.expiresAt ?? NOW + 60 * MIN, over.state ?? "open", over.assignee ?? null, NOW - 4 * MIN, NOW - 4 * MIN);
}
function order(taskId: string, status: string, leaseUntil: number | null) {
  db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,worker,leaseMs,leaseUntil,
    createdBy,createdAt,updatedAt) VALUES (?,?,'p','Sekai','codex','write',1,0,'h','a/b','{}','','s',?,'w-77',1000,?,'owner',100,?)`)
    .run(`o-${taskId}`, taskId, status, leaseUntil, NOW - 3 * MIN);
}
let seq = 10;
function mergeRun(taskId: string, head: string, phase: string, reason: string | null) {
  const id = `m-${taskId}-${seq++}`;
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,'p','merge','merge',1,?,1,1,2,'done','t',?,?)`).run(id, taskId, seq, seq, seq);
  db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,reason,createdAt,updatedAt)
    VALUES (?,?,'p','https://github.com/a/b/pull/1','b',?,'test',?,?,?,?)`).run(id, taskId, head, phase, reason, seq, NOW - MIN);
}
const ciFail = (head: string) => `退回 fix（ci_fail）：PR head ${head}，失败检查 [{"name":"test","link":""}]`;
const board = (opts = {}) => db.transaction(() => workBoard(db, "p", NOW, { registry: [], manualRegistry: [], maxWorkers: 2, now: NOW, attention: FACTS, canPause: false, ...opts })).deferred();
const card = (id: string) => projectView(db, "p", NOW, null, FACTS).tasks.find((t) => t.id === id)!;
const detail = (id: string) => taskDetail(db, "p", id, NOW, FACTS)!.task;
const rowOf = (b: ReturnType<typeof workBoard>, id: string) =>
  [...b.working, ...b.waiting, ...b.todo.ready, ...b.todo.blocked, ...b.legacy].find((r) => r.taskId === id);

test("同一张卡：总览、详情、工作行 actionState 相同；完成卡：总览、完成分页相同", () => {
  task("work"); task("rev", "review"); task("frozen", "fix"); task("asked"); askRow("q1", "asked");
  task("old", "build", false); task("fin", "done");
  const b = board();
  for (const id of ["work", "rev", "frozen", "asked"]) {
    const s = card(id).actionState;
    expect(s).toBeDefined();
    expect(detail(id).actionState).toEqual(s);
    expect(rowOf(b, id)?.actionState).toEqual(s);
  }
  expect(rowOf(b, "old")?.actionState).toEqual(card("old").actionState); // legacy 行
  expect(donePage(db, "p", null, 50, NOW, FACTS).tasks.find((t) => t.id === "fin")?.actionState).toEqual(card("fin").actionState);
  expect(card("fin").actionState?.group).toBe("usable");
  expect([card("asked").actionState?.group, card("frozen").actionState?.group, card("rev").actionState?.waitingOn]).toEqual(["owner", "queued", "review"]);
});

test("只读：query_only 下构建，不产生事件或写入", () => {
  task("a"); task("b", "merge"); askRow("q", "a"); order("b", "claimed", NOW + MIN); mergeRun("b", H1, "await_ci", null);
  const changes = db.query("SELECT total_changes() AS n").get();
  const events = db.query("SELECT COUNT(*) AS n FROM events").get();
  db.run("PRAGMA query_only=ON");
  projectView(db, "p", NOW, null, FACTS); taskDetail(db, "p", "a", NOW, FACTS); donePage(db, "p", null, 10, NOW, FACTS); board();
  db.run("PRAGMA query_only=OFF");
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(events);
});

test("ask：owner 未过期开着才算；PM 收件、过期、已答不算；actions 不带标题 / 正文", () => {
  for (const id of ["own", "pm", "exp", "ans", "perm"]) task(id);
  askRow("a-own", "own"); askRow("a-pm", "pm", { assignee: "agent-claudestra" }); askRow("a-exp", "exp", { expiresAt: NOW });
  askRow("a-ans", "ans", { state: "answered" }); askRow("a-perm", "perm", { source: "permission", kind: "authorize" });
  expect(card("own").actionState?.actions).toEqual([{ kind: "answer", askId: "a-own" }]);
  expect(card("perm").actionState?.actions).toEqual([{ kind: "approve", askId: "a-perm" }]);
  for (const id of ["pm", "exp", "ans"]) expect(card(id).actionState?.group).toBe("active");
  const wire = JSON.stringify(projectView(db, "p", NOW, null, FACTS).tasks.map((t) => t.actionState));
  for (const secret of ["机密", "token", "abc"]) expect(wire).not.toContain(secret);
});

test("心跳：claimed 租约在期 live、过期 stale、unknown 单断联、没有订单 unknown", () => {
  for (const id of ["live", "stale", "dc", "none"]) task(id);
  order("live", "claimed", NOW + MIN); order("stale", "claimed", NOW - 1); order("dc", "unknown", null);
  const s = (id: string) => card(id).actionState!;
  expect([s("live").health, s("live").group, s("live").instance, s("live").placement]).toEqual(["normal", "active", "w-77", { where: "peer", peer: "Sekai", family: "codex" }]);
  expect([s("stale").health, s("stale").group]).toEqual(["stale", "problem"]);
  expect([s("dc").health, s("dc").group]).toEqual(["disconnected", "problem"]);
  expect([s("none").health, s("none").group, s("none").instance]).toEqual(["unknown", "active", null]);
});

test("CI：当前 head 连续三败出问题；旧 head 的失败、取消打断、一次红都不算", () => {
  for (const id of ["three", "old", "cancel", "once"]) task(id, "merge", true, NOW - 5 * MIN);
  for (let k = 0; k < 3; k++) mergeRun("three", H1, "resolved", ciFail(H1));
  for (let k = 0; k < 3; k++) mergeRun("old", H1, "resolved", ciFail(H1));
  mergeRun("old", H2, "await_ci", null);
  mergeRun("cancel", H1, "resolved", ciFail(H1)); mergeRun("cancel", H1, "resolved", ciFail(H1));
  mergeRun("cancel", H1, "resolved", "CI 取消：手动处理"); mergeRun("cancel", H1, "resolved", ciFail(H1));
  mergeRun("once", H1, "resolved", ciFail(H1));
  const s = (id: string) => card(id).actionState!;
  expect([s("three").group, s("three").ci?.failStreak, s("three").health]).toEqual(["problem", 3, "failed"]);
  expect([s("old").group, s("old").ci, s("old").waitingOn]).toEqual(["active", { phase: "await_ci", head: H2, failStreak: 0 }, "ci"]);
  expect([s("cancel").group, s("cancel").ci?.failStreak]).toEqual(["active", 1]);
  expect([s("once").group, s("once").ci?.failStreak]).toEqual(["active", 1]);
});

test("等待超时与暂停事件；没有合并运行时 ci 为 null", () => {
  task("slow", "review", true, NOW - STUCK_MS - MIN); task("paused");
  appendEvent(db, { actor: "owner", now: NOW - MIN }, { project: "p", target: "paused", kind: "decision", text: "停", data: { op: "card_pause" } });
  expect([card("slow").actionState?.group, card("slow").actionState?.ci]).toEqual(["problem", null]);
  expect([card("paused").actionState?.group, card("paused").actionState?.actions]).toEqual(["queued", [{ kind: "resume", taskId: "paused" }]]);
});

test("工作看板：无 taskId 的 DAG 待做行按节点依赖 / 规格就绪投影排队；分栏与计数不变", () => {
  const nodes = [
    { key: "n1", taskId: null, oneLine: "一", deps: [], status: "spec", estimate: "S", inheritedFrom: null },
    { key: "n2", taskId: null, oneLine: "二", deps: ["n1"], status: "spec", estimate: "S", inheritedFrom: null },
  ];
  db.query(`INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES ('f','p','Feature','','active',1,1,'owner',0,0)`).run();
  db.query(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES ('f',1,'initial','','owner','owner',0,?,'[]',0)`).run(JSON.stringify(nodes));
  const b = board({ specReady: () => true });
  const rows = [...b.todo.ready, ...b.todo.blocked];
  expect(rows.map((r) => [r.nodeKey, r.taskId, r.actionState?.group, r.actionState?.waitingOn])).toEqual([
    ["n1", null, "queued", "none"], ["n2", null, "queued", "dependency"],
  ]);
  expect([b.todo.ready.length, b.todo.blocked.length]).toEqual([1, 1]);
  expect(rows.every((r) => r.actionState?.actions.length === 0 && r.actionState.instance === null)).toBe(true);
});
