/** team-project-TEAMVIS10: event meta on the body upload, gated by the center's eventMeta capability, and its backfill. */
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { parseTeamBodyRead, teamBodyDigest, type TeamBodyRecord } from "../src/lib/shared-ledger-contract-team-body.js";
import { TEAM_BODY_SCRUB_VERSION } from "../src/lib/team-body-scrub.js";
import { readTeamBodySync } from "../src/lib/team-body-sync.js";
import { eventMetaOf, takesMeta } from "../src/lib/team-body-sync-meta.js";
import { KNOWN, REFUSED, world } from "./team-body-sync-fixture.test.js";

const TASK = "c5-existing";
const T0 = 1_790_000_000_000;
type World = Awaited<ReturnType<typeof world>>;

/** One ledger event at a fixed time, as the ledger writers leave it (stage data carries from / to). */
function insert(w: World, kind: string, text: string, ts: number, data: Record<string, unknown> = {}): number {
  return Number(w.f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-pm', ?, ?, ?, ?, ?)")
    .run(ts, w.f.project, TASK, kind, text, JSON.stringify(data)).lastInsertRowid);
}
const sent = (w: World): TeamBodyRecord[] => w.uploads().flatMap((u) => u.records);
const strip = (w: World) => w.uploads().map(({ batchId: _b, ...rest }) => rest);
const row = (sourceKey: number, text: string, kind: "event" | "review" | "spec" = "event"): TeamBodyRecord => ({ featureId: "center-feature-1", taskId: TASK,
  kind, sourceKey: String(sourceKey), text, scrubVersion: TEAM_BODY_SCRUB_VERSION, maskedSegments: 0, digest: teamBodyDigest(text) });

/** stage with text, a note, a stage without text, a verdict, and the spec file. */
function ledger(w: World) {
  writeFileSync(join(w.docs, "tasks", `${TASK}.md`), "# 规格\n正文");
  return {
    stage: insert(w, "stage", "开工", T0, { from: "spec", to: "build" }),
    note: insert(w, "note", "补了用例", T0 + 10),
    bare: insert(w, "stage", "", T0 + 20, { from: "build", to: "review" }),
    review: insert(w, "review", "", T0 + 30, { verdict: "pass", p0: 0, p1: 0, p2: 0 }),
  };
}

/** A center that predates meta: any batch carrying meta is invalid (400), as an old closed record schema answers. */
const refusesMeta = (w: World, seen: { refused: number } = { refused: 0 }) => w.failing((u) => {
  if (!u.records.some((r) => r.meta)) return null;
  seen.refused++;
  return Response.json({ schemaVersion: 1, code: "invalid_field", status: 400, message: "invalid" }, { status: 400 });
});
const DAY = 24 * 60 * 60_000;

test("[验收线 1] a center that takes meta: stage events carry kind / ts / stageTo, notes and reviews kind / ts, the spec none; a stage without text goes up too", async () => {
  const w = await world("on");
  try {
    const s = ledger(w);
    await w.pass();
    const records = sent(w);
    expect(records.map((r) => [r.kind, r.sourceKey, r.meta])).toEqual([
      ["event", String(s.stage), { kind: "stage", ts: T0, stageTo: "build" }],
      ["event", String(s.note), { kind: "note", ts: T0 + 10 }],
      ["event", String(s.bare), { kind: "stage", ts: T0 + 20, stageTo: "review" }],
      ["review", String(s.review), { kind: "review", ts: T0 + 30, reviewer: { instanceId: "home-a" } }],
      ["spec", "1", undefined],
    ]);
    expect(Object.hasOwn(records[4]!, "meta")).toBe(false);
    expect(records[2]!.text).toBe("");
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: s.review, metaSeq: s.review });
    expect(readTeamBodySync(w.dir).metaRefused).toBeUndefined();
  } finally { await w.f.close(); }
});

test("[验收线 2] a center that refuses meta (400): the same batch goes again without it, and for 24 h the body is main's, byte for byte", async () => {
  const w = await world("on");
  try {
    const seen = { refused: 0 };
    refusesMeta(w, seen);
    const s = ledger(w);
    await w.pass();
    expect(seen.refused).toBe(2);
    const [refused, bare, retry, ...rest] = w.uploads();
    expect(rest).toHaveLength(0);
    expect(refused!.records.some((r) => r.meta)).toBe(true);
    expect([refused, bare].map((u) => u!.records.find((r) => r.kind === "review")!.meta)).toEqual([
      { kind: "review", ts: T0 + 30, reviewer: { instanceId: "home-a" } }, { kind: "review", ts: T0 + 30 }]);
    // Snapshot of main: no meta key anywhere, the stage without text not sent.
    const main = [row(s.stage, "开工"), row(s.note, "补了用例"), row(s.review, "审查结论 pass · P0 0 / P1 0 / P2 0", "review"), row(1, "# 规格\n正文", "spec")];
    expect(retry!.records).toEqual(main);
    expect(JSON.stringify(retry)).not.toContain("meta");
    const file = readTeamBodySync(w.dir);
    expect(Object.values(file.metaRefused!)).toEqual([w.now() + DAY]);
    expect(file.features[w.f.id]).toMatchObject({ eventSeq: s.review, failures: 0, refusedTotal: 0 });
    expect(file.features[w.f.id]!.metaSeq).toBeUndefined();
    // Within the day: no meta tried, no 400, one request carrying exactly what main sends.
    const next = insert(w, "note", "之后", T0 + 40);
    insert(w, "stage", "", T0 + 50, { to: "fix" });
    w.advance(DAY - 60_000);
    await w.pass();
    expect(seen.refused).toBe(2);
    expect(strip(w).slice(3)).toEqual([{ schemaVersion: 1, projectId: retry!.projectId, sourceInstanceId: retry!.sourceInstanceId, records: [row(next, "之后")] }]);
    // As main: the stage without text is not selected, the watermark stops at the last event with text.
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: next });
  } finally { await w.f.close(); }
});

test("a retry without meta that fails too is an ordinary failure: backoff, no mark", async () => {
  const w = await world("on");
  try {
    w.failing(() => Response.json({ schemaVersion: 1, code: "invalid_field", status: 400, message: "invalid" }, { status: 400 }));
    insert(w, "note", "一", T0);
    await w.pass();
    expect(w.uploads().map((u) => u.records.some((r) => r.meta))).toEqual([true, false]);
    const file = readTeamBodySync(w.dir);
    expect(file.metaRefused).toBeUndefined();
    expect(file.features[w.f.id]).toMatchObject({ eventSeq: 0, failures: 1 });
  } finally { await w.f.close(); }
});

test("[验收线 4] backfill waits while the center refuses meta, then resumes from metaSeq under the per-pass cap, after an interruption too, none twice", async () => {
  const w = await world("on");
  try {
    const seen = { refused: 0 };
    refusesMeta(w, seen);
    const seqs = Array.from({ length: 300 }, (_, i) => i === 150 ? insert(w, "stage", "", T0 + i, { to: "review" }) : insert(w, "note", `存量 ${i}`, T0 + i));
    const refused = insert(w, "note", REFUSED, T0 + 300);
    seqs.push(refused);
    for (let i = 0; i < 3; i++) { await w.pass(KNOWN); w.advance(10_000); }
    // One 400, then 299 records without meta: the stage without text stays home, the refused one is never sent.
    expect(seen.refused).toBe(1);
    const plainSent = sent(w).filter((r) => !r.meta);
    expect(plainSent.map((r) => r.sourceKey)).toEqual(seqs.filter((_, i) => i !== 150 && i !== 300).map(String));
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: refused, refusedTotal: 1 });
    expect(readTeamBodySync(w.dir).features[w.f.id]!.metaSeq).toBeUndefined();
    const mirror = readSharedLedgerMirrors(w.dir)[w.f.id], projections = w.projections.length;
    // Paused while marked: idle passes send nothing.
    const count = w.uploads().length;
    for (let i = 0; i < 3; i++) { w.advance(60 * 60_000); await w.pass(KNOWN); }
    expect(w.uploads()).toHaveLength(count);

    // The mark runs out and the center now takes meta; the pass's second batch fails once.
    w.advance(DAY);
    let posts = 0;
    w.failing(() => ++posts === 2 ? new Response("down", { status: 503 }) : null);
    await w.pass(KNOWN);
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: refused, metaSeq: seqs[99], failures: 1 });
    w.failing(false);
    for (let i = 0; i < 3; i++) { w.advance(60_000); await w.pass(KNOWN); }

    const after = w.uploads().slice(count);
    const delivered = after.filter((_, i) => i !== 1).flatMap((u) => u.records);
    expect(delivered.map((r) => r.sourceKey)).toEqual(seqs.slice(0, 300).map(String));
    expect(delivered.every((r) => r.meta && r.meta.ts === T0 + seqs.indexOf(Number(r.sourceKey)))).toBe(true);
    expect(delivered[150]).toMatchObject({ text: "", meta: { kind: "stage", stageTo: "review" } });
    // The same sourceKey and text as the upload without meta.
    const plain = new Map(plainSent.map((r) => [r.sourceKey, r.text]));
    expect(delivered.filter((r) => r.text).every((r) => plain.get(r.sourceKey) === r.text)).toBe(true);
    expect(after.every((u) => u.records.length <= 100)).toBe(true);
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: refused, metaSeq: refused, refusedTotal: 1, failures: 0 });
    expect(readSharedLedgerMirrors(w.dir)[w.f.id]).toEqual(mirror);
    expect(w.projections).toHaveLength(projections);

    // Done: nothing more goes; a new event goes up once with its meta.
    const done = w.uploads().length;
    w.advance(60_000);
    await w.pass(KNOWN);
    expect(w.uploads()).toHaveLength(done);
    const next = insert(w, "note", "之后", T0 + 999);
    w.advance(60_000);
    await w.pass(KNOWN);
    expect(sent(w).slice(-1)).toEqual([{ ...row(next, "之后"), meta: { kind: "note", ts: T0 + 999 } }]);
  } finally { await w.f.close(); }
});

test("a mark from a clock that moved back (further off than a day) is spent; another origin is not marked", () => {
  const file = { metaRefused: { a: 10 + DAY } };
  expect(takesMeta(file, "a", 10)).toBe(false);
  expect(takesMeta(file, "a", 10 + DAY)).toBe(true);
  expect(takesMeta(file, "a", 9)).toBe(true);
  expect(takesMeta(file, "b", 10)).toBe(true);
});

test("meta of one row: unknown kind or time goes without meta, unreadable or unknown stage data goes without stageTo", () => {
  expect(eventMetaOf({ kind: "stage", ts: 5, data: JSON.stringify({ to: "fix" }) })).toEqual({ kind: "stage", ts: 5, stageTo: "fix" });
  expect(eventMetaOf({ kind: "stage", ts: 5, data: JSON.stringify({ to: "shipped" }) })).toEqual({ kind: "stage", ts: 5 });
  expect(eventMetaOf({ kind: "stage", ts: 5, data: "{" })).toEqual({ kind: "stage", ts: 5 });
  expect(eventMetaOf({ kind: "note", ts: 5, data: JSON.stringify({ to: "fix" }) })).toEqual({ kind: "note", ts: 5 });
  expect(eventMetaOf({ kind: "mystery", ts: 5, data: "{}" })).toBeUndefined();
  expect(eventMetaOf({ kind: "note", ts: 0, data: "{}" })).toBeUndefined();
});

/** TEAMVIS7's replay fixture (tests/web-collab-team-body.test.ts LOCAL): the same five home events, the same times. */
test("[验收线 5] the TEAMVIS7 replay fixture goes up and reads back with the meta its team-side replay takes, stages in home order", async () => {
  const w = await world("on");
  try {
    const local = [
      { kind: "stage", ts: T0, text: "开工", data: { from: "spec", to: "build" } },
      { kind: "deliver", ts: T0 + 600_000, text: "交付", data: {} },
      { kind: "stage", ts: T0 + 700_000, text: "送审", data: { from: "build", to: "review" } },
      { kind: "review", ts: T0 + 900_000, text: "要改", data: { verdict: "changes", p0: 0, p1: 1, p2: 0 } },
      { kind: "stage", ts: T0 + 950_000, text: "退回", data: { from: "review", to: "fix" } },
    ];
    const seqs = local.map((e) => insert(w, e.kind, e.text, e.ts, e.data));
    await w.pass();
    const records = sent(w).filter((r) => r.kind !== "spec");
    const read = parseTeamBodyRead({ schemaVersion: 1, teamId: "team-a", projectId: w.uploads()[0]!.projectId, featureId: "center-feature-1", taskId: TASK,
      records: [...records].reverse(), syncedAt: T0 + 1_000_000, homeOnline: true });
    const back = [...read.records].sort((x, y) => Number(x.sourceKey) - Number(y.sourceKey));
    expect(back.map((r) => Number(r.sourceKey))).toEqual(seqs);
    expect(back.map((r) => [r.meta!.kind as string, r.meta!.ts])).toEqual(local.map((e) => [e.kind, e.ts]));
    expect(back.flatMap((r) => r.meta!.stageTo ? [r.meta!.stageTo] : [])).toEqual(["build", "review", "fix"]);
    expect(back[3]!.text).toContain("审查结论 changes · P0 0 / P1 1 / P2 0");
  } finally { await w.f.close(); }
});

test("a state file written before meta (no metaSeq) reads as nothing sent with meta yet", async () => {
  const w = await world("on");
  try {
    refusesMeta(w);
    const a = insert(w, "note", "一", T0);
    await w.pass();
    const path = join(w.dir, "team-body-sync.json"), file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.features[w.f.id].metaSeq).toBeUndefined();
    delete file.metaRefused;
    writeFileSync(path, JSON.stringify(file));
    w.failing(false);
    w.advance(60_000);
    await w.pass();
    expect(sent(w).map((r) => [r.sourceKey, r.meta?.kind ?? null])).toEqual([[String(a), "note"], [String(a), null], [String(a), "note"]]);
  } finally { await w.f.close(); }
});
