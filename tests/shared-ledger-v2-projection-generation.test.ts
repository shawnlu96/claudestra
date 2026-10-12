/** S2P2: the projection watermark is (serviceGeneration, centerSeq); a restored center (CS7) wins, a pre-restore late reply never lands. */
import { describe, expect, test } from "bun:test";
import { insertEvent, tx } from "../src/lib/ledger-tx.js";
import { PROJECTION_ACTOR, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { landedCenterSeq, landedWatermark, writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { executionMode, ledger, ref, tables, task, view, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

type Obj = Record<string, any>;
const genView = (serviceGeneration: number, serverSeq: number, stage: string): Obj =>
  ({ ...view(serverSeq, { tasks: [task("T1", { stage, title: `g${serviceGeneration}/${serverSeq}` })] }), serviceGeneration });
const card = (l: Ledger) => l.rows("SELECT stage, title FROM tasks WHERE id = 'T1'")[0];
const lastEvent = (l: Ledger) => JSON.parse(l.rows("SELECT data FROM events WHERE actor = ? ORDER BY seq DESC LIMIT 1", PROJECTION_ACTOR)[0]!.data);

function caught(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected a refusal");
}

describe("S2P2 projection watermark by service generation", () => {
  test("[验收线 1] a restored center's g2/90 snapshot lands over g1/100 and records the generation switch", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      expect(writeExecutionProjection(l.db, genView(1, 100, "build"), ref)).toMatchObject({ kind: "written", centerSeq: 100 });
      expect(lastEvent(l).generationSwitch).toBeUndefined();
      expect(writeExecutionProjection(l.db, genView(2, 90, "review"), ref)).toMatchObject({ kind: "written", centerSeq: 90, tasks: ["T1"] });
      expect(card(l)).toEqual({ stage: "review", title: "g2/90" });
      expect(lastEvent(l)).toMatchObject({ op: "center-projection", serverSeq: 90, centerSeq: 90, serviceGeneration: 2, featureId: "F",
        generationSwitch: { from: 1, to: 2, landedSeq: 100 } });
      expect(landedWatermark(l.db, "F")).toEqual({ serviceGeneration: 2, centerSeq: 90 });
      expect(landedCenterSeq(l.db, "F")).toBe(90);
    } finally { l.close(); }
  });

  test("[验收线 2] after g2/90 landed, an in-flight g1/100 reply is stale and writes nothing", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, genView(1, 40, "build"), ref);
      writeExecutionProjection(l.db, genView(2, 90, "review"), ref);
      const before = tables(l);
      expect(writeExecutionProjection(l.db, genView(1, 100, "build"), ref))
        .toEqual({ kind: "stale", centerSeq: 100, landed: 90, serviceGeneration: 1, landedGeneration: 2 });
      expect(tables(l)).toEqual(before);
      expect(card(l)).toEqual({ stage: "review", title: "g2/90" });
    } finally { l.close(); }
  });

  test("[验收线 3] within one generation the watermark stays strictly monotonic by serverSeq", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, genView(1, 10, "build"), ref);
      writeExecutionProjection(l.db, genView(2, 5, "review"), ref);
      expect(writeExecutionProjection(l.db, genView(2, 8, "review"), ref)).toMatchObject({ kind: "written", centerSeq: 8 });
      expect(lastEvent(l).generationSwitch).toBeUndefined();
      const before = tables(l);
      for (const seq of [8, 6]) expect(writeExecutionProjection(l.db, genView(2, seq, "build"), ref)).toMatchObject({ kind: "stale", landed: 8 });
      expect(tables(l)).toEqual(before);
      expect(writeExecutionProjection(l.db, genView(3, 1, "merge"), ref)).toMatchObject({ kind: "written", centerSeq: 1 });
      expect(lastEvent(l).generationSwitch).toEqual({ from: 2, to: 3, landedSeq: 8 });
    } finally { l.close(); }
  });
});

describe("S2P2 gate token watermark", () => {
  const scoped = (l: Ledger, centerSeq: number, serviceGeneration?: number, data: Obj = {}) =>
    tx(l.db, () => withProjectionScope(l.db, { featureId: "F", centerSeq, ...(serviceGeneration !== undefined ? { serviceGeneration } : {}) },
      () => insertEvent(l.db, { actor: PROJECTION_ACTOR }, { project: "p", target: "T1", kind: "task", data: { op: "center-projection", ...data } }, true)));

  test("legacy rows without a generation count as 1; the token, not the caller, sets the recorded generation", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, genView(1, 1, "build"), ref);
      expect(scoped(l, 50).data).toEqual({ op: "center-projection", centerSeq: 50, featureId: "F" });
      expect(landedWatermark(l.db, "F")).toEqual({ serviceGeneration: 1, centerSeq: 50 });
      expect(caught(() => scoped(l, 50, 1))).toMatchObject({ code: "forbidden" });
      // A caller-supplied generation cannot raise the watermark: the token's generation overwrites it.
      expect(scoped(l, 51, undefined, { serviceGeneration: 99 }).data).toMatchObject({ centerSeq: 51, serviceGeneration: 1 });
      expect(landedWatermark(l.db, "F")).toEqual({ serviceGeneration: 1, centerSeq: 51 });
      expect(scoped(l, 3, 2).data).toMatchObject({ centerSeq: 3, serviceGeneration: 2 });
      expect(caught(() => scoped(l, 200, 1))).toMatchObject({ code: "forbidden" });
      expect(caught(() => scoped(l, 3, 2))).toMatchObject({ code: "forbidden" });
      expect(caught(() => scoped(l, 10, 0))).toMatchObject({ code: "forbidden" });
      expect(landedWatermark(l.db, "F")).toEqual({ serviceGeneration: 2, centerSeq: 3 });
    } finally { l.close(); }
  });
});
