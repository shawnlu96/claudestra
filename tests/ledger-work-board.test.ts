import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openLedger, closeLedger } from '../src/lib/ledger-store.js';
import { createTask } from '../src/lib/ledger-write.js';
import { workBoard } from '../src/lib/ledger-work-board.js';
let db: Database;
const now = 3600000;
beforeEach(() => { db = openLedger(':memory:'); });
afterEach(() => closeLedger(':memory:'));
function task(id: string, stage = 'build') {
  createTask(db, { actor: 'owner', now: 0 }, { id, project: 'p', title: id, kind: 'code', stage: stage as never, agent: `agent-${id}`, spec: 'spec.md' });
}
function order(id: string, status: string, step = 'write', beat: unknown = null) {
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, leaseMs, createdBy, createdAt, updatedAt, beat) VALUES (?,?,'p','Sekai','codex',?,1,0,'h','a/b','{}','','s',?,1000,'owner',100,200,?)`)
    .run(id, id, step, status, beat ? JSON.stringify(beat) : null);
}
function intent(id: string, action = 'dispatch', status = 'submitted') {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, templateVersion,
    status, reason, createdAt, updatedAt) VALUES (?,?,'p','write',?,1,2,1,1,2,?,'test',0,0)`).run(id, id, action, status);
}
function workflow(id: string, mode = 'auto') {
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev,
    createdAt, updatedAt) VALUES (?,'p','code',2,?,'codex','PM',1,1,0,0)`).run(id, mode);
}
function session(id: string) {
  intent(id, 'ensure_session', 'done');
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'author',?,?,'codex','tmux','active',?,0,0)`).run(id, `agent-${id}`, `s-${id}`, id);
}
function board(maxWorkers = 2) { return db.transaction(() => workBoard(db, 'p', now, { registry: [], maxWorkers, now })).deferred(); }
test('local write, peer write, publishing and pool wait; no writes and no unrelated project', () => {
  for (const id of ['local', 'peer', 'publish', 'pool']) task(id);
  order('peer', 'claimed'); order('publish', 'claimed', 'write', { phase: 'publishing', since: 600000 }); order('pool', 'pooled', 'review');
  createTask(db, { actor: 'owner', now: 0 }, { id: 'foreign', project: 'q', title: 'secret', kind: 'code', stage: 'build' });
  const changes = db.query('SELECT total_changes() AS n').get();
  db.run('PRAGMA query_only=ON');
  const b = board();
  expect(b.working.map(r => r.taskId)).toEqual(['local', 'peer', 'publish']);
  expect(b.working.find(r => r.taskId === 'peer')).toMatchObject({ who: 'peer:Sekai · codex', step: 'write' });
  expect(b.working.find(r => r.taskId === 'publish')).toMatchObject({ step: 'publishing', since: 600000 });
  expect(b.waiting[0]).toMatchObject({ code: 'pooled', reason: '等审查员领单', since: 100 });
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
});
test('blocking asks, unknown effects, manual and CI use authoritative facts', () => {
  for (const id of ['ask', 'unknown', 'manual', 'ci', 'queue']) task(id, ['ci', 'queue'].includes(id) ? 'merge' : 'build');
  workflow('manual', 'manual'); intent('unknown', 'dispatch', 'unknown'); intent('ci', 'merge');
  db.query(`INSERT INTO asks (id,project,taskId,source,kind,blocking,title,expiresAt,state,createdAt,updatedAt)
    VALUES ('ask','p','ask','system','owner_action',1,'Confirm',99999999,'open',300,300)`).run();
  db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
    VALUES ('ci','ci','p','a/b#1','b','h','[]','await_ci',100,200)`).run();
  const b = board();
  expect(b.waiting.map(r => r.code).sort()).toEqual(['ask', 'unknown_effect', 'manual', 'ci', 'merge_queue'].sort());
  expect(b.waiting.find(r => r.taskId === 'queue')?.reason).toContain('ci');
});
test('planner file conflict and local capacity classify as waiting', () => {
  task('lock'); task('full'); task('holder');
  for (const id of ['lock', 'full']) {
    workflow(id); session(id);
    db.query("UPDATE tasks SET extra=? WHERE id=?").run(JSON.stringify({ fileGlobs: ['web/file.ts'] }), id);
  }
  intent('holder');
  db.query("INSERT INTO scheduler_resources(project,resource,taskId,intentId,acquiredAt) VALUES ('p','web/file.ts','holder','holder',0)").run();
  expect(board().waiting.find(r => r.taskId === 'lock')?.reason).toContain('holder');
  expect(board(0).waiting.find(r => r.taskId === 'full')).toMatchObject({ code: 'capacity', reason: '本机名额满' });
});
test('todo separates ready specifications from missing specifications and unfinished dependencies', () => {
  task('ready', 'spec'); task('blocked', 'spec'); task('missing', 'spec'); task('upstream');
  db.query("UPDATE tasks SET spec=NULL WHERE id='missing'").run();
  db.query(`INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES ('f','p','Feature','','active',1,1,'owner',0,0)`).run();
  const nodes = ['ready', 'blocked', 'missing', 'upstream'].map(id => ({ key: id, taskId: id, oneLine: id,
    deps: id === 'blocked' ? ['upstream'] : [], status: id === 'upstream' ? 'build' : 'spec', estimate: 'S', inheritedFrom: null }));
  db.query(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES ('f',1,'initial','','owner','owner',0,?,'[]',0)`).run(JSON.stringify(nodes));
  const b = board();
  expect(b.todo.ready.map(r => r.taskId)).toEqual(['ready']);
  expect(b.todo.blocked.find(r => r.taskId === 'blocked')?.reason).toBe('被 upstream 挡住');
  expect(b.todo.blocked.find(r => r.taskId === 'missing')?.reason).toBe('缺规格');
  expect(b.todo.ready[0].remainingMinutes).toBe(30);
});
test('quota fallback, PM / executor asks and active restating stay out of todo', () => {
  for (const id of ['quota', 'pm', 'executor']) task(id);
  workflow('quota', 'manual');
  db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (200,'scheduler','p','quota','scheduler','',?)`)
    .run(JSON.stringify({ op: 'fallback_manual', reason: 'codex 撞额度 quota' }));
  db.query("UPDATE tasks SET pm='agent-pm' WHERE id='pm'").run();
  for (const [id, assignee] of [['pm', 'agent-pm'], ['executor', 'agent-executor']]) {
    db.query(`INSERT INTO asks (id,project,taskId,source,kind,blocking,title,expiresAt,state,createdAt,updatedAt,assignee)
      VALUES (?,'p',?,'system','assigned',1,'问题',99999999,'open',300,300,?)`).run(id, id, assignee);
  }
  task('restate', 'spec'); intent('restate');
  db.query("UPDATE scheduler_intents SET node='restate',recipient='agent-restate' WHERE taskId='restate'").run();
  const b = board();
  expect(b.waiting.find(r => r.taskId === 'quota')).toMatchObject({ code: 'quota', since: 200 });
  expect(b.waiting.find(r => r.taskId === 'pm')?.reason).toContain('PM');
  expect(b.waiting.find(r => r.taskId === 'executor')?.reason).toContain('执行者');
  expect(b.working.find(r => r.taskId === 'restate')?.step).toBe('restate');
});
test('production-scale fixture: 80 cards, 30 sessions, 40 lend orders, response below 30KB and read-only', () => {
  const nodes = Array.from({ length: 80 }, (_, i) => {
    const id = `i28-${i}`;
    task(id, i >= 70 ? 'spec' : 'build');
    db.query('UPDATE tasks SET title=? WHERE id=?').run('生产量级工作看板：并发开工、审查、修复与交付状态', id);
    if (i < 40) order(id, i < 30 ? 'claimed' : 'pooled', i % 3 === 0 ? 'review' : 'write', i % 7 === 0 ? { phase: 'publishing', since: 1000 } : null);
    if (i >= 40 && i < 70) session(id);
    return { key: id, taskId: id, oneLine: id, deps: i >= 71 ? [`i28-${i - 1}`] : [], status: i >= 70 ? 'spec' : 'build',
      estimate: i % 2 ? 'S' : '半天', inheritedFrom: null };
  });
  db.query(`INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES ('f','p','Feature','','active',1,1,'owner',0,0)`).run();
  db.query(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES ('f',1,'initial','','owner','owner',0,?,'[]',0)`).run(JSON.stringify(nodes));
  const changes = db.query('SELECT total_changes() AS n').get();
  db.run('PRAGMA query_only=ON');
  const result = board();
  const bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...result }));
  console.log(`[work-board scale] 80 cards / 30 sessions / 40 orders: ${bytes} bytes`);
  expect(bytes).toBeLessThanOrEqual(30 * 1024);
  expect(result.working.length + result.waiting.length + result.todo.ready.length + result.todo.blocked.length).toBe(80);
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
});
