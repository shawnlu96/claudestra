/** Five first-round findings, reproduced against real read-only ledger projections. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openLedger, closeLedger } from '../src/lib/ledger-store.js';
import { createTask } from '../src/lib/ledger-write.js';
import { workBoard } from '../src/lib/ledger-work-board.js';
import { workBoardSlots } from '../src/lib/ledger-work-board-slots.js';
import { remainingMinutes, stepSamples } from '../src/lib/ledger-work-board-time.js';
import type { BorrowEntry } from '../src/lib/lend-config.js';
const NOW = 5 * 3600000;
let db: Database;
beforeEach(() => { db = openLedger(':memory:'); });
afterEach(() => closeLedger(':memory:'));
function task(id: string, stage = 'build', manual = true) {
  createTask(db, { actor: 'owner', now: 0 }, { id, project: 'p', title: id, kind: 'code', stage: stage as never, agent: `agent-${id}` });
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback,
    specRev, rev, createdAt, updatedAt) VALUES (?,'p','code',2,?,'codex','PM',1,1,0,0)`).run(id, manual ? 'manual' : 'observe');
}
function intent(taskId: string, id = taskId, action = 'ensure_session', seq = 1) {
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,templateVersion,
    status,reason,createdAt,updatedAt) VALUES (?,?,'p','work',?,1,?,1,1,2,'done','test',?,?)`).run(id, taskId, action, seq, seq, seq);
}
function session(id: string, role: string, state = 'active') {
  intent(id);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,?,?,?,'codex','tmux',?,?,0,0)`).run(id, role, `agent-${id}`, `s-${id}`, state, id);
}
function order(id: string, step = 'write', beat: unknown = null, claim = true) {
  db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,
    leaseMs,createdBy,createdAt,updatedAt,beat) VALUES (?,?,'p','Sekai','codex',?,1,0,'h','a/b','{}','','s','claimed',1000,'owner',?,?,?)`)
    .run(id, id, step, NOW - 4 * 3600000, NOW, beat ? JSON.stringify(beat) : null);
  if (claim) db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (?,'owner','p',?,'note','',?)`)
    .run(NOW - 60000, id, JSON.stringify({ lend: { op: 'claim', orderId: id } }));
}
function board(slots = 1) {
  db.run('PRAGMA query_only=ON');
  return db.transaction(() => workBoard(db, 'p', NOW, { registry: [], manualRegistry: [{ name: 'agent-writer', status: 'active' }],
    maxWorkers: 1, availableSlots: slots, now: NOW })).deferred();
}
test('manual-active: live registry author and claimed peer work; sessions alone cannot vouch for workers', () => {
  task('writer'); session('writer', 'author');
  task('reviewer', 'review'); session('reviewer', 'reviewer');
  task('peer'); order('peer');
  task('idle'); task('retired'); session('retired', 'author', 'retired');
  task('retiring'); session('retiring', 'author', 'retiring');
  const changes = db.query('SELECT total_changes() AS n').get();
  const b = board();
  expect(b.working.map(r => r.taskId).sort()).toEqual(['peer', 'writer']);
  expect(b.waiting.map(r => r.taskId).sort()).toEqual(['idle', 'retired', 'retiring', 'reviewer']);
  expect(b.machines).toEqual({ local: 1, Sekai: 1 });
  expect(b.waiting.find(r => r.taskId === 'reviewer')?.code).toBe('reviewer');
  expect(b.waiting.filter(r => r.taskId !== 'reviewer').every(r => r.code === 'executor_missing')).toBe(true);
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
});
test('peer-since: four-hour pool wait is excluded; claim beats heartbeat and publishing uses beat.since', () => {
  task('claim'); order('claim', 'write', { phase: 'working', since: NOW - 120000 });
  task('heartbeat'); order('heartbeat', 'write', { phase: 'working', since: NOW - 30000, at: NOW }, false);
  task('publishing'); order('publishing', 'write', { phase: 'publishing', since: NOW - 10000 });
  const b = board();
  expect(b.working.find(r => r.taskId === 'claim')).toMatchObject({ since: NOW - 60000, overMinutes: 0, remainingMinutes: 119 });
  expect(b.working.find(r => r.taskId === 'heartbeat')?.since).toBe(NOW - 30000);
  expect(b.working.find(r => r.taskId === 'publishing')).toMatchObject({ step: 'publishing', since: NOW - 10000 });
});
test('merge-round: latest merge intent wins even when an older merged row is inserted first and updated later', () => {
  task('merge', 'merge', false);
  intent('merge', 'old', 'merge', 1); intent('merge', 'current', 'merge', 2);
  for (const [id, phase, updated] of [['old', 'merged', NOW], ['current', 'await_ci', NOW - 1000]] as const) {
    db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
      VALUES (?,'merge','p','a/b#1','b','h','[]',?,?,?)`).run(id, phase, id === 'old' ? 1 : 2, updated);
  }
  expect(board().waiting[0]).toMatchObject({ taskId: 'merge', code: 'ci', step: 'merge', since: NOW - 1000 });
});
test('eta-slots: the sole occupied local slot still yields completion; held peer writers keep capacity', () => {
  task('writer'); session('writer', 'author');
  db.query("INSERT INTO scheduler_resources(project,resource,taskId,intentId,acquiredAt) VALUES ('p','slot:p:0','writer','writer',0)").run();
  expect(workBoardSlots(db, 'p', 1, [], undefined, NOW)).toBe(1);
  expect(board(1).completionHours).toBe(1);
});
test('eta-slots: only usable writing capacity plus own claimed writers count, not review-only or foreign busy slots', () => {
  task('writer'); order('writer');
  const grant = { until: NOW + 1000000, roles: ['write', 'review'], repos: ['a/b'], ordersLeftToday: 20, ordersPerDay: 20 };
  db.query(`INSERT INTO lend_peers(peer,proto,boot,seq,grant,slots,helloAt) VALUES ('Sekai',2,'boot',1,?,?,?)`)
    .run(JSON.stringify(grant), JSON.stringify({ codex: { total: 4, busy: 2 }, claude: { total: 2, busy: 1 } }), NOW);
  const b: BorrowEntry = { peer: 'Sekai', projects: ['p'], roles: ['write', 'review'], maxOpen: 4 };
  const remote = { mode: 'balance' as const, roles: ['write' as const], poolTimeoutMin: 15, repo: 'a/b' };
  expect(workBoardSlots(db, 'p', 1, [b], remote, NOW)).toBe(5); // local 1 + own writer 1 + free write 3
  expect(workBoardSlots(db, 'p', 1, [{ ...b, roles: ['review'] }], remote, NOW)).toBe(2);
  expect(workBoardSlots(db, 'p', 1, [b], { ...remote, roles: ['review'] }, NOW)).toBe(2);
  db.query("UPDATE lend_peers SET helloAt=0").run();
  expect(workBoardSlots(db, 'p', 1, [b], remote, NOW)).toBe(2);
});
test('eta-deploy: every code tail includes deployment, including fix then another review', () => {
  const samples = stepSamples(new Map(), NOW);
  expect(['write', 'review', 'fix', 'merge'].map(step => remainingMinutes(step as 'write', 0, samples, '', true)))
    .toEqual([120, 60, 90, 30]);
  expect(remainingMinutes('review', 40, samples, '', true)).toBe(30);
  expect(remainingMinutes('review', 0, samples, '', false)).toBe(30);
});
