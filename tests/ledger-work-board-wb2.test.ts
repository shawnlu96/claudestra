import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openLedger, closeLedger } from '../src/lib/ledger-store.js';
import { createTask } from '../src/lib/ledger-write.js';
import { workBoardSlots } from '../src/lib/ledger-work-board-slots.js';
import { workBoard } from '../src/lib/ledger-work-board.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stateFile from '../src/lib/state-file.js';
import { workBoardRegistry } from '../src/lib/ledger-work-board-registry.js';
import type { RegistryAgent } from '../src/lib/registry.js';
let db: Database;
let registry: RegistryAgent[];
beforeEach(() => { db = openLedger(':memory:'); registry = []; });
afterEach(() => closeLedger(':memory:'));
function card(id: string, stage = 'build', manual = true, status: string | undefined = 'active') {
  createTask(db, { actor: 'owner', now: 0 }, { id, project: 'p', title: id, kind: 'code', stage: stage as never, agent: `agent-${id}` });
  if (manual) db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,
    specRev,rev,createdAt,updatedAt) VALUES (?,'p','ui',3,'manual','codex','PM',1,1,0,0)`).run(id);
  registry.push({ name: `agent-${id}`, status });
}
function board() { return workBoard(db, 'p', 60000, { registry: [], manualRegistry: registry, maxWorkers: 2 }); }
function fallback(id: string) {
  db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'scheduler','p',?,'scheduler','',?)`)
    .run(id, JSON.stringify({ op: 'fallback_manual', reason: 'PM intervention' }));
}
test('08:15 shape: eight frozen legacy cards and six manual local workers, with no scheduler sessions', () => {
  for (let i = 0; i < 8; i++) card(`old-${i}`, 'build', false);
  for (let i = 0; i < 6; i++) card(`manual-${i}`, ['restate', 'build', 'fix'][i % 3]);
  const changes = db.query('SELECT total_changes() AS n').get();
  db.run('PRAGMA query_only=ON');
  const b = board();
  expect(b.working.map(r => r.taskId).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `manual-${i}`));
  expect(b.working.every(r => r.who === `agent-${r.taskId}` && r.machine === 'local')).toBe(true);
  expect(b.legacy).toHaveLength(8); expect(b.waiting).toEqual([]); expect(b.machines).toEqual({ local: 6 });
  expect(Object.keys(b.legacy[0]).sort()).toEqual(['stage', 'taskId', 'title']);
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(30 * 1024);
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
});
test('only active and creating workers are alive; stopped/dead/missing/unknown status do not occupy local slots', () => {
  card('missing'); registry = [];
  for (const status of ['stopped', 'dead', 'unknown', 'active', 'creating']) card(status, 'build', true, status);
  card('unset'); registry.at(-1)!.status = undefined;
  const b = board();
  expect(b.working.map(r => r.taskId).sort()).toEqual(['active', 'creating']);
  for (const id of ['missing', 'stopped', 'dead', 'unknown', 'unset']) {
    expect(b.working.some(r => r.taskId === id)).toBe(false);
    expect(b.waiting.find(r => r.taskId === id)).toMatchObject({ code: 'executor_missing', reason: '执行者不在了' });
  }
  expect(b.machines).toEqual({ local: 2 });
});
test('a fallback event does not hide an active manual executor', () => {
  card('alive', 'restate'); fallback('alive');
  expect(board().working[0]?.taskId).toBe('alive');
});
test('only real fallback without a living worker says manual intervention', () => {
  card('fallback', 'build', true, 'dead'); fallback('fallback');
  expect(board().waiting[0]).toMatchObject({ code: 'manual', reason: '退回人工（manual）：PM intervention' });
});
test('manual review needs a claimed review order, not an alive task author', () => {
  card('review', 'review');
  expect(board().waiting[0]).toMatchObject({ code: 'reviewer', reason: '等审查员领单' });
  db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,
    leaseMs,createdBy,createdAt,updatedAt) VALUES ('o','review','p','Sekai','codex','write',1,0,'h','a/b','{}','','s','claimed',1000,'owner',0,0)`).run();
  expect(board().waiting[0]?.code).toBe('reviewer');
  db.query("UPDATE lend_orders SET step='review' WHERE orderId='o'").run();
  expect(board().working[0]).toMatchObject({ who: 'peer:Sekai · codex', machine: 'Sekai', step: 'review' });
});
test('legacy cards do not affect ETA or occupancy, even when bound into an idle DAG', () => {
  card('worker'); const before = board();
  card('old'); db.query("DELETE FROM task_workflows WHERE taskId='old'").run();
  db.query(`INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES ('f','p','Feature','','active',1,1,'owner',0,0)`).run();
  const node = { key: 'old', taskId: 'old', oneLine: 'old', deps: [], status: 'spec', estimate: '100天', inheritedFrom: null };
  db.query(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES ('f',1,'initial','','owner','owner',0,?,'[]',0)`).run(JSON.stringify([node]));
  const after = board();
  expect(after.completionHours).toBe(before.completionHours); expect(after.machines).toEqual(before.machines);
  expect(after.legacy).toHaveLength(1); expect(after.todo.ready).toEqual([]); expect(after.todo.blocked).toEqual([]);
});

test('isolated registry read failures fail closed even after a successful cached snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb2-registry-')), path = join(dir, 'registry.json');
  const log = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    writeFileSync(path, JSON.stringify({ agents: { 'agent-fixture': { status: 'active' } } }));
    expect(workBoardRegistry(path).map(a => a.name)).toEqual(['agent-fixture']);
    writeFileSync(path, '{broken');
    expect(workBoardRegistry(path)).toEqual([]);
    unlinkSync(path);
    expect(workBoardRegistry(path)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); if (existsSync(path)) unlinkSync(path); rmdirSync(dir); }
});

test('claimed legacy writers do not add machine capacity', () => {
  card('old', 'build', false);
  db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,
    leaseMs,createdBy,createdAt,updatedAt) VALUES ('o','old','p','Sekai','codex','write',1,0,'h','a/b','{}','','s','claimed',1000,'owner',0,0)`).run();
  expect(workBoardSlots(db, 'p', 2, [], undefined, 60000)).toBe(2);
  expect(board().machines).toEqual({}); expect(board().completionHours).toBe(0);
});

test('150 legacy cards expose the first 50 sorted IDs and total while keeping the response below 30KB', () => {
  for (let i = 149; i >= 0; i--) {
    const id = `old-${String(i).padStart(3, '0')}`; card(id, 'spec', false);
    db.query('UPDATE tasks SET title=? WHERE id=?').run('冻结老卡'.repeat(45), id);
  }
  card('worker');
  const b = board();
  expect(b.legacyTotal).toBe(150); expect(b.legacy).toHaveLength(50);
  expect(b.legacy.map(r => r.taskId)).toEqual(Array.from({ length: 50 }, (_, i) => `old-${String(i).padStart(3, '0')}`));
  expect(b.todo.ready).toEqual([]); expect(b.todo.blocked).toEqual([]);
  expect(b.machines).toEqual({ local: 1 });
  const bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...b }));
  console.log(`[work-board legacy scale] 150 cards / 50 returned: ${bytes} bytes`);
  expect(bytes).toBeLessThanOrEqual(30 * 1024);
});

test('registry normalizes the one successfully read snapshot without reopening the file', () => {
  const read = spyOn(stateFile, 'readJsonStateSync').mockReturnValue({ status: 'ok',
    data: { agents: { 'agent-first': { status: 'active' } } } });
  try {
    expect(workBoardRegistry('fixture-registry').map(a => a.name)).toEqual(['agent-first']);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { read.mockRestore(); }
});
