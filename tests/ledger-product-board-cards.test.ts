import { expect, test } from 'bun:test';
import { productBoard } from '../src/lib/ledger-product-board.js';
import { closeLedger, openLedger } from '../src/lib/ledger-store.js';
import { createFeature, initDag } from '../src/lib/ledger-feature-write.js';
import { createTask } from '../src/lib/ledger-write.js';
import { assertProductBoard } from '../web/lib/api/product-board-types';

test('no-DAG cards contract includes only project-owned bindings and exposes only link fields', () => {
  const db = openLedger(':memory:');
  try {
    const ctx = { actor: 'owner', now: 1 };
    const f = createFeature(db, ctx, { project: 'p', slug: 'cards', title: 'Cards' }).row;
    const other = createFeature(db, ctx, { project: 'p', slug: 'other', title: 'Other' }).row;
    for (const [id, project, title, featureId] of [
      ['own', 'p', 'Own card', f.id], ['foreign', 'q', 'Foreign secret', f.id], ['other', 'p', 'Other feature', other.id],
    ]) {
      createTask(db, ctx, { project, id, title, kind: 'code', stage: 'spec' });
      db.prepare('UPDATE tasks SET featureId=? WHERE id=?').run(featureId, id);
    }
    const result = productBoard(db, 'p', 1000);
    assertProductBoard(result);
    const projected = result.features.find(x => x.id === f.id)!;
    expect(projected.cards).toEqual([{ id: 'own', title: 'Own card', stage: 'spec' }]);
    expect(projected.counts.total).toBe(projected.cards!.length);
    expect(projected.eta).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('Foreign secret');
    const empty = createFeature(db, ctx, { project: 'p', slug: 'empty', title: 'Empty' }).row;
    expect(productBoard(db, 'p', 1000).features.find(x => x.id === empty.id)?.cards).toEqual([]);
    initDag(db, ctx, { id: f.id, rev: 1, nodes: [{ key: 'a', taskId: 'own', oneLine: 'a' }] });
    const withDag = productBoard(db, 'p', 1000);
    assertProductBoard(withDag);
    expect(withDag.features.find(x => x.id === f.id)).not.toHaveProperty('cards');
  } finally { closeLedger(':memory:'); }
});
