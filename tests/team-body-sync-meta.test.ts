/** team-project-TEAMVIS10: event meta on the body upload, gated by the center's eventMeta capability, and its backfill. */
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { parseTeamBodyRead, teamBodyDigest, type TeamBodyRecord } from "../src/lib/shared-ledger-contract-team-body.js";
import { TEAM_BODY_SCRUB_VERSION } from "../src/lib/team-body-scrub.js";
import { readTeamBodySync } from "../src/lib/team-body-sync.js";
import { eventMetaOf } from "../src/lib/team-body-sync-meta.js";
import { KNOWN, REFUSED, world } from "./team-body-sync-fixture.test.js";

const TASK = "c5-existing";
const T0 = 1_790_000_000_000;
const CAP = { schemaVersion: 1, teamId: "team-a", teamBody: true };
const withMeta = () => Response.json({ ...CAP, eventMeta: true });
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

test("[验收线 1] eventMeta on: stage events carry kind / ts / stageTo, notes and reviews kind / ts, the spec none; a stage without text goes up too", async () => {
  const w = await world("on");
  try {
    w.setCapability(withMeta);
    const s = ledger(w);
    await w.pass();
    const records = sent(w);
    expect(records.map((r) => [r.kind, r.sourceKey, r.meta])).toEqual([
      ["event", String(s.stage), { kind: "stage", ts: T0, stageTo: "build" }],
      ["event", String(s.note), { kind: "note", ts: T0 + 10 }],
      ["event", String(s.bare), { kind: "stage", ts: T0 + 20, stageTo: "review" }],
      ["review", String(s.review), { kind: "review", ts: T0 + 30 }],
      ["spec", "1", undefined],
    ]);
    expect(Object.hasOwn(records[4]!, "meta")).toBe(false);
    expect(records[2]!.text).toBe("");
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: s.review, metaSeq: s.review });
  } finally { await w.f.close(); }
});

test("[验收线 2] capability without eventMeta, eventMeta false, or 404: the upload body is the one main sends, byte for byte", async () => {
  const bodies: unknown[] = [];
  for (const cap of [() => Response.json(CAP), () => Response.json({ ...CAP, eventMeta: false })]) {
    const w = await world("on");
    try {
      w.setCapability(cap);
      const s = ledger(w);
      await w.pass();
      // Snapshot of main: no meta key anywhere, the stage without text is not sent, no metaSeq in the state.
      expect(strip(w)).toEqual([{ schemaVersion: 1, projectId: w.uploads()[0]!.projectId, sourceInstanceId: w.uploads()[0]!.sourceInstanceId,
        records: [row(s.stage, "开工"), row(s.note, "补了用例"), row(s.review, "审查结论 pass · P0 0 / P1 0 / P2 0", "review"), row(1, "# 规格\n正文", "spec")] }]);
      expect(JSON.stringify(w.uploads())).not.toContain("meta");
      expect(Object.hasOwn(readTeamBodySync(w.dir).features[w.f.id]!, "metaSeq")).toBe(false);
      bodies.push(JSON.stringify(strip(w)));
    } finally { await w.f.close(); }
  }
  expect(bodies[0]).toBe(bodies[1]);
  const w = await world("on");
  try {
    w.setCapability(() => new Response("not found", { status: 404 }));
    ledger(w);
    await w.pass();
    expect(w.uploads()).toHaveLength(0);
    expect(w.requests.map((r) => r.method)).toEqual(["GET"]);
  } finally { await w.f.close(); }
});

test("[验收线 4] the capability turning true backfills meta under the per-pass cap, resumes after an interruption, none twice, none missed", async () => {
  const w = await world("on");
  try {
    const seqs = Array.from({ length: 300 }, (_, i) => i === 150 ? insert(w, "stage", "", T0 + i, { to: "review" }) : insert(w, "note", `存量 ${i}`, T0 + i));
    const refused = insert(w, "note", REFUSED, T0 + 300);
    seqs.push(refused);
    await w.pass(KNOWN);
    w.advance(10_000);
    await w.pass(KNOWN);
    expect(sent(w)).toHaveLength(299); // no meta yet: the stage without text stays home, the refused one is never sent
    expect(sent(w).some((r) => r.meta)).toBe(false);
    const before = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(before).toMatchObject({ eventSeq: refused, refusedTotal: 1 });
    const mirror = readSharedLedgerMirrors(w.dir)[w.f.id], projections = w.projections.length, uploadsBefore = w.uploads().length;

    w.setCapability(withMeta);
    w.advance(60 * 60_000);
    let posts = 0;
    w.failing(() => ++posts === 2 ? new Response("down", { status: 503 }) : null); // the pass's second batch fails
    await w.pass(KNOWN);
    const st1 = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(st1).toMatchObject({ eventSeq: refused, metaSeq: seqs[99], failures: 1 });
    w.failing(false);
    for (let i = 0; i < 3; i++) { w.advance(60_000); await w.pass(KNOWN); }

    const all = w.uploads().slice(uploadsBefore);
    const delivered = all.filter((_, i) => i !== 1).flatMap((u) => u.records);
    expect(delivered.map((r) => r.sourceKey)).toEqual(seqs.slice(0, 300).map(String));
    expect(delivered.every((r) => r.meta && r.meta.ts === T0 + seqs.indexOf(Number(r.sourceKey)))).toBe(true);
    expect(delivered[150]).toMatchObject({ text: "", meta: { kind: "stage", stageTo: "review" } });
    // The same sourceKey and text as the upload without meta.
    const plain = new Map(sent(w).slice(0, 299).map((r) => [r.sourceKey, r.text]));
    expect(delivered.filter((r) => r.text).every((r) => plain.get(r.sourceKey) === r.text)).toBe(true);
    expect(all.every((u) => u.records.length <= 100)).toBe(true);
    const st = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(st).toMatchObject({ eventSeq: refused, metaSeq: refused, refusedTotal: 1, failures: 0 });
    expect(readSharedLedgerMirrors(w.dir)[w.f.id]).toEqual(mirror);
    expect(w.projections).toHaveLength(projections);

    // Done: nothing more goes; a new event goes up once with its meta.
    const count = w.uploads().length;
    w.advance(60_000);
    await w.pass(KNOWN);
    expect(w.uploads()).toHaveLength(count);
    const next = insert(w, "note", "之后", T0 + 999);
    w.advance(60_000);
    await w.pass(KNOWN);
    expect(sent(w).slice(-1)).toEqual([{ ...row(next, "之后"), meta: { kind: "note", ts: T0 + 999 } }]);
  } finally { await w.f.close(); }
});

test("a center that drops eventMeta again: uploads go without meta and the lag is backfilled once it returns", async () => {
  const w = await world("on");
  try {
    w.setCapability(withMeta);
    const a = insert(w, "note", "一", T0);
    await w.pass();
    w.setCapability(() => Response.json(CAP));
    w.advance(60 * 60_000);
    const b = insert(w, "note", "二", T0 + 1);
    await w.pass();
    expect(sent(w).map((r) => [r.sourceKey, r.meta?.kind ?? null])).toEqual([[String(a), "note"], [String(b), null]]);
    w.setCapability(withMeta);
    w.advance(60 * 60_000);
    await w.pass();
    expect(sent(w).slice(2).map((r) => [r.sourceKey, r.meta?.kind ?? null])).toEqual([[String(b), "note"]]);
  } finally { await w.f.close(); }
});

test("a center without eventMeta and an idle feature: the capability is asked at most hourly, nothing is sent again", async () => {
  const w = await world("on");
  try {
    w.setCapability(() => Response.json(CAP));
    insert(w, "note", "一", T0);
    await w.pass();
    expect(w.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    for (let i = 0; i < 5; i++) { w.advance(10 * 60_000); await w.pass(); }
    expect(w.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    w.advance(20 * 60_000);
    await w.pass();
    expect(w.requests.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  } finally { await w.f.close(); }
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
    w.setCapability(withMeta);
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
    const a = insert(w, "note", "一", T0);
    await w.pass();
    const path = join(w.dir, "team-body-sync.json"), file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.features[w.f.id].metaSeq).toBeUndefined();
    w.setCapability(withMeta);
    w.advance(60 * 60_000);
    await w.pass();
    expect(sent(w).map((r) => [r.sourceKey, r.meta?.kind ?? null])).toEqual([[String(a), null], [String(a), "note"]]);
  } finally { await w.f.close(); }
});
