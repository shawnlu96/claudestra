/** team-project-TEAMVIS10: the optional meta on event / review records and the eventMeta capability bit (same rules as the center, TEAMVIS9). */
import { describe, expect, test } from "bun:test";
import { EVENT_KINDS, STAGES } from "../src/lib/ledger-stages.js";
import {
  parseTeamBodyCapability, parseTeamBodyPageReturn, parseTeamBodyRead, parseTeamBodyRecord, parseTeamBodyUpload, teamBodyDigest,
  type TeamBodyKind, type TeamBodyRecord,
} from "../src/lib/shared-ledger-contract-team-body.js";

const rec = (kind: TeamBodyKind, sourceKey: string, text: string, extra: Record<string, unknown> = {}): TeamBodyRecord => ({
  featureId: "feat-1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text), ...extra,
} as TeamBodyRecord);
const TS = 1_791_000_000_000;
const stage = rec("event", "12", "送审", { meta: { kind: "stage", ts: TS, stageTo: "review" } });
const note = rec("event", "13", "补了用例", { meta: { kind: "note", ts: TS + 1 } });
const review = rec("review", "14", "审查结论 pass · P0 0 / P1 0 / P2 0", { meta: { kind: "review", ts: TS + 2 } });
const upload = (records: unknown[]) => ({ schemaVersion: 1, projectId: "proj-1", sourceInstanceId: "home-1", batchId: "ab".repeat(16), records });
const refuses = (value: unknown) => expect(() => parseTeamBodyRecord(value)).toThrow("invalid_field");

describe("record meta", () => {
  test("event and review records carry meta and parse to themselves; a record without meta has no meta key", () => {
    for (const r of [stage, note, review]) expect(parseTeamBodyRecord(r)).toEqual(r);
    expect(parseTeamBodyUpload(upload([stage, note, review])).records).toEqual([stage, note, review]);
    const plain = parseTeamBodyRecord(rec("event", "15", "x"));
    expect(Object.hasOwn(plain, "meta")).toBe(false);
  });
  test("every ledger event kind and every stage is accepted, taken from ledger-stages.ts", () => {
    expect(EVENT_KINDS.length).toBe(26);
    expect(STAGES.length).toBe(11);
    for (const kind of EVENT_KINDS) expect(parseTeamBodyRecord(rec("event", "1", "", { meta: { kind, ts: 1 } })).meta).toEqual({ kind, ts: 1 });
    for (const stageTo of STAGES) expect(parseTeamBodyRecord(rec("event", "1", "", { meta: { kind: "stage", ts: 1, stageTo } })).meta!.stageTo).toBe(stageTo);
  });
  test("[验收线 3] an extra key, a kind or stage outside the enums, stageTo off a stage event, a bad ts: refused", () => {
    refuses({ ...note, meta: { kind: "note", ts: TS, actor: "pm" } });
    refuses({ ...note, meta: { kind: "notes", ts: TS } });
    refuses({ ...note, meta: { kind: "note", ts: TS, stageTo: "review" } });
    refuses({ ...review, meta: { kind: "review", ts: TS, stageTo: "fix" } });
    refuses({ ...stage, meta: { kind: "stage", ts: TS, stageTo: "shipped" } });
    refuses({ ...stage, meta: { kind: "stage", ts: TS, stageTo: null } });
    for (const ts of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, null]) refuses({ ...note, meta: { kind: "note", ts } });
    refuses({ ...note, meta: { ts: TS } });
    refuses({ ...note, meta: null });
    refuses({ ...note, meta: [] });
  });
  test("[验收线 3] spec and session-page records with meta are refused", () => {
    refuses(rec("spec", "3", "# 规格", { meta: { kind: "note", ts: TS } }));
    refuses(rec("session-page", "page:1", "user: hi", { meta: { kind: "note", ts: TS } }));
    const page = (r: unknown) => ({ schemaVersion: 1, requestId: "req-1", sourceInstanceId: "home-1", result: { kind: "page", records: [r], nextCursor: null } });
    expect(() => parseTeamBodyPageReturn(page(rec("session-page", "page:1", "x", { meta: { kind: "note", ts: TS } })))).toThrow("invalid_field");
    expect(() => parseTeamBodyUpload(upload([rec("spec", "3", "x", { meta: { kind: "note", ts: TS } })]))).toThrow("invalid_field");
  });
  test("meta is outside the digest: the same text with or without meta has one digest", () => {
    expect(stage.digest).toBe(teamBodyDigest("送审"));
    expect(parseTeamBodyRecord({ ...stage, meta: { kind: "stage", ts: TS + 9, stageTo: "fix" } }).digest).toBe(stage.digest);
  });
  test("a member read returns meta as the center sent it, in the shape the team side reads (meta.kind / ts / stageTo)", () => {
    const read = { schemaVersion: 1, teamId: "team-a", projectId: "proj-1", featureId: "feat-1", taskId: "task-1", records: [stage, note, review], syncedAt: TS, homeOnline: true };
    const got = parseTeamBodyRead(read);
    expect(got.records.map((r) => r.meta)).toEqual([{ kind: "stage", ts: TS, stageTo: "review" }, { kind: "note", ts: TS + 1 }, { kind: "review", ts: TS + 2 }]);
  });
});

describe("eventMeta capability", () => {
  const body = { schemaVersion: 1, teamId: "team-a", teamBody: true };
  test("only a supported center that says eventMeta true counts", () => {
    expect(parseTeamBodyCapability(200, { ...body, eventMeta: true })).toEqual({ supported: true, eventMeta: true });
    expect(parseTeamBodyCapability(200, { ...body, eventMeta: false })).toEqual({ supported: true, eventMeta: false });
    expect(parseTeamBodyCapability(200, body)).toEqual({ supported: true, eventMeta: false });
    expect(parseTeamBodyCapability(200, { ...body, teamBody: false, eventMeta: true })).toEqual({ supported: false, eventMeta: false });
    expect(parseTeamBodyCapability(404, { ...body, eventMeta: true })).toEqual({ supported: false, eventMeta: false });
    expect(() => parseTeamBodyCapability(200, { ...body, eventMeta: "true" })).toThrow("invalid_field");
  });
});
