import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeUiDelivery, planUiDelivery, type UiDeliverPort } from "../src/lib/ledger-deliver-ui.js";
import { projectPmUiGate } from "../src/lib/ledger-ui-approve-verdict.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, setTask } from "../src/lib/ledger-write.js";
import { readUiEvidence, uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import { recordObserved } from "../src/lib/recovery-policy.js";

let db: Database, root: string, port: UiDeliverPort;
const head = "a".repeat(40), task = () => getTask(db, "U1")!;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const events = () => listEvents(db, { project: "p", target: "U1" });
const observations = () => events().filter((e) => e.data.op === "recovery_observe");

// Follow the author instruction with legacy before/after material; never send its card/web/file fields to the parser.
function manifest(over: Partial<UiEvidence> = {}): UiEvidence {
  const material = (["before", "after"] as const).map((phase) => {
    const file = join(root, "U1", "r2", `${phase}-home-390x844.png`);
    const bytes = Buffer.from(`\x89PNG\r\n\x1a\n${phase}`);
    writeFileSync(file, bytes);
    return { card: "U1", web: "/photography-material", shots: [{ view: "home", size: "390x844", phase, file, sha256: hash(bytes) }] };
  });
  const shots = material.flatMap((m) => m.shots.map(({ file, ...s }) => ({ ...s, ref: file.slice(join(root, m.card).length + 1) })));
  const e = { v: 1 as const, taskId: material[0].card, head, specRev: 1, round: 1, source: "local" as const,
    summary: "首页前后", shots, ...over };
  return { ...e, digest: uiEvidenceDigest(e) };
}
function note(e?: unknown, h = head) {
  const t = task(), plan = planUiDelivery(db, t, { headSHA: h, uiEvidence: e }, port);
  observeUiDelivery(db, t, plan, port, h);
  return plan;
}
beforeEach(() => {
  db = openLedger(":memory:");
  root = mkdtempSync(join(tmpdir(), "ui-delivery-observation-"));
  mkdirSync(join(root, "U1", "r2"), { recursive: true });
  createTask(db, { actor: "owner", now: 1 }, { id: "U1", project: "p", title: "UI", kind: "code", agent: "agent-author" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'U1'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('U1', 'p', 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`);
  port = { mode: () => ({ mode: "observe" }), roots: { local: root, imported: join(root, "imported") },
    observe: (store, a) => { recordObserved(store, { ...a, mechanism: "uiDelivery" }, 10); } };
});
afterEach(() => { closeLedger(":memory:"); rmSync(root, { recursive: true, force: true }); });

describe("local UI success observations", () => {
  test("converted material strictly parses, hashes real bytes, and observes ok without registering or approving", () => {
    const e = manifest();
    expect(readUiEvidence(e)).toEqual(e);
    const plan = note(e);
    expect(plan.extra).toBeUndefined();
    expect(plan.data).toBeUndefined();
    expect(observations()).toHaveLength(1);
    expect(observations()[0].data).toMatchObject({ code: "ok", head, round: 1, digest: e.digest });
    expect(observations()[0].text).not.toContain("拒收");
    expect(task()).toMatchObject({ stage: "build", round: 0, extra: {} });
    expect(projectPmUiGate(db, task(), events()).state).toBe("none");
    expect(() => readUiEvidence({ card: "U1", web: "/material", shots: e.shots })).toThrow();
    const pngDigest = hash(Buffer.concat([...e.shots].sort((a, b) => a.ref.localeCompare(b.ref))
      .map((s) => readFileSync(join(root, e.taskId, s.ref)))));
    expect(() => readUiEvidence({ ...e, digest: pngDigest })).toThrow();
  });

  test("retry dedups; same-round different full head (same prefix) or digest leaves new samples", () => {
    const e = manifest();
    note(e); note(e);
    const otherHead = head.slice(0, 39) + "b";
    note(manifest({ head: otherHead }), otherHead);
    note(manifest({ summary: "另一组核对" }));
    expect(observations()).toHaveLength(3);
    expect(new Set(observations().map((x) => x.data.actionKey)).size).toBe(3);
    expect(observations().every((x) => String(x.data.actionKey).length <= 120)).toBe(true);
  });

  test.each(["build", "fix", "review"] as const)("%s uses the target review round, independent of r2 directory", (stage) => {
    db.run("UPDATE tasks SET stage = ?, round = 5 WHERE id = 'U1'", [stage]);
    const round = stage === "review" ? 5 : 6;
    note(manifest({ round }));
    expect(observations()[0].data).toMatchObject({ code: "ok", round });
  });

  test("missing/invalid/bad bytes keep problem codes; off does nothing; peer success stays empty", () => {
    note(); note({ card: "U1" });
    const e = manifest();
    writeFileSync(join(root, "U1", e.shots[1].ref), "changed after photographing");
    note(e);
    expect(observations().map((x) => x.data.code)).toEqual(["missing", "invalid", "hash_mismatch"]);
    port.mode = () => ({ mode: "off" });
    expect(note(e)).toEqual({});
    expect(observations()).toHaveLength(3);
    port.mode = () => ({ mode: "observe" });
    port.peer = { peer: "mate", worker: "worker", orderId: "U1:write:r0" };
    const dir = join(root, "imported", "mate", "U1_write_r0");
    mkdirSync(dir, { recursive: true });
    const imported = manifest({ source: "imported" });
    for (const s of imported.shots) {
      mkdirSync(join(dir, "r2"), { recursive: true });
      writeFileSync(join(dir, s.ref), Buffer.from(`\x89PNG\r\n\x1a\n${s.phase}`));
    }
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ v: 1, ...port.peer, head,
      files: Object.fromEntries(imported.shots.map((s) => [s.ref, { sha256: s.sha256 }])) }));
    expect(note(imported)).toEqual({});
    expect(observations()).toHaveLength(3);
  });

  test("real observe delivery retains PM manual registration, and on still registers without approval", () => {
    const e = manifest();
    deliver(db, { actor: "agent-author", now: 20 }, { taskId: "U1", headSHA: head, moveFrom: "build", uiEvidence: e, ui: port });
    expect(task()).toMatchObject({ stage: "review", round: 1, extra: {} });
    expect(observations()[0].data.code).toBe("ok");
    expect(events().find((x) => x.kind === "deliver")?.data.uiEvidence).toBeUndefined();
    const screenshots = e.shots.map((s) => join(root, "U1", s.ref));
    setTask(db, { actor: "owner", now: 21 }, { id: "U1", rev: task().rev,
      patch: { extra: { screenshots, screenshotsDigest: e.digest } } });
    expect(task().extra.screenshots).toEqual(screenshots);
    port.mode = () => ({ mode: "on" });
    expect(() => note()).toThrow("missing");
    expect(note(e)).toMatchObject({ extra: { screenshots, screenshotsDigest: e.digest } });
    expect(projectPmUiGate(db, task(), events()).state).toBe("none");
  });
});
