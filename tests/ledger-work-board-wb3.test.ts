import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workBoardSpecReady } from '../src/bridge/local-api/work-board.js';
import type { Database } from 'bun:sqlite';
import { openLedger, closeLedger } from '../src/lib/ledger-store.js';
import { createTask } from '../src/lib/ledger-write.js';
import { workBoard } from '../src/lib/ledger-work-board.js';

let db: Database;
beforeEach(() => {
  db = openLedger(':memory:');
  db.query("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')").run();
});
afterEach(() => closeLedger(':memory:'));
function feature(nodes: { key: string; deps?: string[]; taskId?: string }[]) {
  db.query(`INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES ('ab12-i28','p','Feature','','active',1,1,'owner',0,0)`).run();
  db.query(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES ('ab12-i28',1,'initial','','owner','owner',0,?,'[]',0)`).run(JSON.stringify(nodes.map(n => ({
      ...n, taskId: n.taskId ?? null, deps: n.deps ?? [], oneLine: n.key, status: 'spec', estimate: 'S', inheritedFrom: null,
    }))));
}
function board(specReady?: (taskId: string) => boolean) {
  return workBoard(db, 'p', 1000, { registry: [], manualRegistry: [], maxWorkers: 2, now: 1000, specReady });
}
test('unopened nodes use scheduler card ids and injected specification readiness', () => {
  feature([{ key: 'READY' }, { key: 'MISSING' }]);
  const calls: string[] = [];
  const b = board(id => { calls.push(id); return id === 'i28-READY'; });
  expect(calls.sort()).toEqual(['i28-MISSING', 'i28-READY']);
  expect(b.todo.ready).toHaveLength(1);
  expect(b.todo.ready[0]).toMatchObject({ nodeKey: 'READY', taskId: null, reason: null });
  expect(b.todo.blocked).toHaveLength(1);
  expect(b.todo.blocked[0]).toMatchObject({ nodeKey: 'MISSING', reason: '缺规格' });
});
test('a present specification does not bypass unfinished dependencies', () => {
  feature([{ key: 'UPSTREAM' }, { key: 'DOWNSTREAM', deps: ['UPSTREAM'] }]);
  const b = board(() => true);
  expect(b.todo.ready.map(r => r.nodeKey)).toEqual(['UPSTREAM']);
  expect(b.todo.blocked).toHaveLength(1);
  expect(b.todo.blocked[0]).toMatchObject({ nodeKey: 'DOWNSTREAM', reason: '被 UPSTREAM 挡住' });
});
test('omitting the injection preserves missing-spec behavior for unopened nodes', () => {
  feature([{ key: 'A' }, { key: 'B', deps: ['A'] }]);
  const b = board();
  expect(b.todo.ready).toHaveLength(0);
  expect(b.todo.blocked.map(r => r.reason)).toEqual(['缺规格', '被 A 挡住；缺规格']);
});
test('opened cards rely on task.spec without consulting the injection', () => {
  for (const [id, spec] of [['has-spec', 'spec.md'], ['no-spec', null]]) {
    createTask(db, { actor: 'owner', now: 0 }, { id: id!, project: 'p', title: id!, kind: 'code', stage: 'spec', spec });
    db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
      VALUES (?,'p','code',2,'observe','codex','PM',1,1,0,0)`).run(id);
  }
  feature([{ key: 'HAS', taskId: 'has-spec' }, { key: 'NONE', taskId: 'no-spec' }]);
  const b = board(() => { throw new Error('opened cards must not consult specReady'); });
  expect(b.todo.ready.map(r => r.taskId)).toEqual(['has-spec']);
  expect(b.todo.blocked[0]).toMatchObject({ taskId: 'no-spec', reason: '缺规格' });
});

test('a directory at the formal specification path remains missing; only files are ready', () => {
  const ledger = mkdtempSync(join(tmpdir(), 'i28-wb3-spec-'));
  const tasks = join(ledger, 'docs', 'tasks');
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(tasks, 'i28-DIR.md'));
  writeFileSync(join(tasks, 'i28-FILE.md'), '# Specification');
  feature([{ key: 'DIR' }, { key: 'FILE' }, { key: 'ABSENT' }]);
  const b = board(id => workBoardSpecReady(join(tasks, `${id}.md`)));
  expect(b.todo.ready.map(r => r.nodeKey)).toEqual(['FILE']);
  expect(b.todo.blocked.map(r => ({ key: r.nodeKey, reason: r.reason }))).toEqual([
    { key: 'DIR', reason: '缺规格' }, { key: 'ABSENT', reason: '缺规格' },
  ]);
});
