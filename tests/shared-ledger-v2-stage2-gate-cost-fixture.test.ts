import * as writes from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { execution, type Fixture } from "./shared-ledger-v2-stage2-gate-helpers.test.js";

export const planning = { authorityMode: "planning" as const, sharedPlanning: true };
export function cards(f: Fixture, n: number) {
  const insert = f.db.prepare(`INSERT INTO tasks (id,project,title,kind,stage,rev,extra,createdAt,updatedAt)
    SELECT ?, project, title, kind, stage, 1, ?, createdAt, updatedAt FROM tasks WHERE id='T'`);
  f.db.transaction(() => { for (let i = 0; i < n; i++) insert.run(`c${i}`, i % 2 ? "{}" : JSON.stringify({ sharedFeatureId: `G${i % 7}` })); })();
}
const average = (n: number, fn: (i: number) => void): number => {
  let total = 0;
  for (let i = 0; i < n + 3; i++) {
    const t0 = performance.now();
    fn(i);
    if (i >= 3) total += performance.now() - t0;
  }
  return total / n;
};
// Always measure and log; only the opt-in profile asserts absolute milliseconds.
export function absoluteCost(f: Fixture) {
  f.workflow();
  let base = 0, gated = 0;
  const rounds = 20;
  for (let i = 0; i < rounds; i++) {
    f.setMode(planning);
    f.plan(`a${i}`);
    let t0 = performance.now();
    settleIntent(f.db, f.scheduler, { id: `a${i}`, from: "pending", to: "cancelled" });
    base += performance.now() - t0;
    f.plan(`b${i}`);
    f.setMode(execution);
    t0 = performance.now();
    f.scope(() => settleIntent(f.db, f.scheduler, { id: `b${i}`, from: "pending", to: "cancelled" }));
    gated += performance.now() - t0;
  }
  f.setMode(planning);
  const localBase = average(30, i => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: `p${i}` } }));
  f.setMode(execution);
  const local = average(30, i => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: `e${i}` } }));
  console.log(`[S2G2 cost] 2000 cards: local write ${local.toFixed(3)} ms (planning ${localBase.toFixed(3)} ms); `
    + `executor settle ${(gated / rounds).toFixed(3)} ms (planning ${(base / rounds).toFixed(3)} ms)`);
  return { local, localBase, gated, base, rounds };
}

const median = (samples: number[]): number => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const elapsed = (fn: () => unknown): number => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};

/** Mode switches and intent setup stay outside the timer. Alternate both modes and fixture order to limit time drift.
 * Use positive execution medians as denominators: subtracting planning can produce zero or negative costs. */
export function scalingCost(small: Fixture, large: Fixture) {
  const samples = [small, large].map(f => {
    f.workflow();
    return { f, local: [] as number[], settle: [] as number[] };
  });
  for (let i = 0; i < 24; i++) {
    for (const sample of i % 2 ? [...samples].reverse() : samples) {
      const { f } = sample;
      for (const mode of i % 2 ? [execution, planning] : [planning, execution]) {
        const gated = mode === execution;
        f.setMode(planning);
        const id = `scale-${i}-${gated}`;
        f.plan(id);
        f.setMode(mode);
        const local = elapsed(() => writes.setTask(f.db, f.owner, {
          id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: id },
        }));
        const settle = elapsed(() => {
          const write = () => settleIntent(f.db, f.scheduler, { id, from: "pending", to: "cancelled" });
          return gated ? f.scope(write) : write();
        });
        if (i >= 3 && gated) { sample.local.push(local); sample.settle.push(settle); }
      }
    }
  }
  return samples.map(s => ({ local: median(s.local), settle: median(s.settle) }));
}
