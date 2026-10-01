/** Owner-only compact work board; one deferred read transaction, no scheduler effects. */
import { canReadLedger } from '../../lib/devices.js';
import { workBoard } from '../../lib/ledger-work-board.js';
import { readSchedulerConfig } from '../../lib/scheduler-config.js';
import { readLendSync } from '../../lib/lend-config.js';
import { workBoardSlots } from '../../lib/ledger-work-board-slots.js';
import type { Principal } from '../../lib/principals.js';
import { apiJson, forbidden } from '../api-respond.js';
import { ledgerDb } from '../ledger-feed.js';
import { ledgerProjectExists } from './ledger.js';

export async function handleWorkBoardApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const match = path.match(/^\/ledger\/([^/]+)\/work$/);
  if (!match) return null;
  if (!canReadLedger(principal)) return forbidden('ledger requires a full-scope owner credential');
  if (req.method !== 'GET') return apiJson(405, { ok: false, error: 'method not allowed' });
  let project: string;
  try { project = decodeURIComponent(match[1]); }
  catch { return apiJson(400, { ok: false, error: 'bad path encoding' }); } // Bad caller input is answered with 400.
  if (project.length > 200 || /[\u0000-\u001f\u007f]/.test(project)) return apiJson(400, { ok: false, error: 'bad project' });
  if (!await ledgerProjectExists(project)) return apiJson(404, { ok: false, error: 'project not found' });
  try {
    const db = ledgerDb(), now = Date.now();
    if (!db) return apiJson(200, { ok: true, now, asOfSeq: 0, working: [], waiting: [], todo: { ready: [], blocked: [] },
      machines: {}, completionHours: 0, availableSlots: 0 });
    const policy = readSchedulerConfig().projects[project];
    const lend = readLendSync();
    const borrow = lend.file.borrow.filter(b => b.projects.includes(project) && b.priority !== 'off');
    const opts = { registry: [], maxWorkers: policy?.maxActiveWorkers ?? 0, now,
      ...(policy?.remote ? { pool: { remote: policy.remote, borrow } } : {}) };
    const result = db.transaction(() => {
      const total = workBoardSlots(db, project, opts.maxWorkers, borrow, policy?.remote, now);
      return workBoard(db, project, now, { ...opts, availableSlots: total });
    }).deferred();
    return apiJson(200, { ok: true, ...result });
  } catch (error) {
    console.warn('[work-board] read failed', error);
    return apiJson(503, { ok: false, error: 'work board unavailable' });
  }
}
