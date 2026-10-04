import { describe, expect, test } from "bun:test";
import { EXT_CAPABILITIES_OFF, parseActivityCursor, parseSharedLedgerReadResponse } from "../src/lib/shared-ledger-contract-reads.js";
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import { SHARED_LEDGER_CAPABILITIES } from "../src/lib/shared-ledger-contract.js";
import {
  SHARED_LEDGER_ACTIVITY_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE,
  SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_LIST_FIXTURE, SHARED_LEDGER_VERSIONS_FIXTURE,
} from "../src/lib/shared-ledger-contract-fixtures.js";

const caps = SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE;
const rejects = (kind: "extCapabilities" | "versions" | "activity", value: unknown) =>
  expect(() => parseSharedLedgerReadResponse(kind, value)).toThrow("invalid_field");

describe("ext-capabilities: closed, all-required, reads separate from uploads", () => {
  test("new and read-only center fixtures parse to themselves; read-only keeps uploads false", () => {
    expect(parseSharedLedgerReadResponse("extCapabilities", caps)).toEqual(caps);
    const ro = parseSharedLedgerReadResponse("extCapabilities", SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE);
    expect(Object.values(ro.reads).every(Boolean)).toBe(true);
    expect(ro.uploads.projectionExt1).toBe(false);
    expect(EXT_CAPABILITIES_OFF).toEqual({ schemaVersion: 1, reads: { versions: false, activity: false, ext1: false, activityExt: false },
      uploads: { projectionExt1: false } });
  });
  test("missing / extra / non-boolean keys reject the whole body", () => {
    const { uploads: _u, ...noUploads } = caps;
    const { activityExt: _a, ...fewReads } = caps.reads;
    for (const bad of [noUploads, { ...caps, extra: 1 }, { ...caps, reads: fewReads }, { ...caps, reads: { ...caps.reads, more: true } },
      { ...caps, uploads: {} }, { ...caps, uploads: { projectionExt1: 1 } }, { ...caps, reads: { ...caps.reads, ext1: null } },
      { ...caps, schemaVersion: 2 }, { ...caps, teamId: "" }]) rejects("extCapabilities", bad);
  });
});

describe("versions reuse the V1 dag schema", () => {
  test("fixture parses; unknown at/by stay null", () => {
    const parsed = parseSharedLedgerReadResponse("versions", SHARED_LEDGER_VERSIONS_FIXTURE);
    expect(parsed).toEqual(SHARED_LEDGER_VERSIONS_FIXTURE);
    expect(parsed.versions[1]).toMatchObject({ at: null, by: null });
  });
  test("bad nodes/bindings, a person-name by, extra keys and duplicate versions are refused", () => {
    const v = SHARED_LEDGER_VERSIONS_FIXTURE.versions[0]!;
    const withVersion = (patch: Record<string, unknown>) => ({ ...SHARED_LEDGER_VERSIONS_FIXTURE, versions: [{ ...v, ...patch }] });
    for (const bad of [withVersion({ bindings: [{ nodeKey: "missing", taskId: "t" }] }), withVersion({ nodes: [{ ...v.nodes[0]!, deps: ["C1"] }] }),
      withVersion({ by: "张 三" }), withVersion({ at: -1 }), withVersion({ text: "原文" }), withVersion({ reason: undefined }),
      { ...SHARED_LEDGER_VERSIONS_FIXTURE, versions: [v, v] }, { ...SHARED_LEDGER_VERSIONS_FIXTURE, extra: true }]) rejects("versions", bad);
  });
});

describe("activity carries types and times only", () => {
  test("fixture parses for both sources", () => {
    expect(parseSharedLedgerReadResponse("activity", SHARED_LEDGER_ACTIVITY_FIXTURE)).toEqual(SHARED_LEDGER_ACTIVITY_FIXTURE);
  });
  test("复现: activity 带 text / data / summary 等原文键整包拒收", () => {
    const [center, home] = SHARED_LEDGER_ACTIVITY_FIXTURE.items;
    for (const leak of [{ text: "原文" }, { data: { to: "write" } }, { summary: "进入实现阶段" }, { note: "x" }]) {
      for (const item of [center, home]) rejects("activity", { ...SHARED_LEDGER_ACTIVITY_FIXTURE, items: [{ ...item, ...leak }] });
    }
  });
  test("unknown src, mixed shapes, negative or unsafe sequences, center items past serverSeq are refused", () => {
    const [center, home] = SHARED_LEDGER_ACTIVITY_FIXTURE.items;
    const items = (...xs: unknown[]) => ({ ...SHARED_LEDGER_ACTIVITY_FIXTURE, items: xs });
    for (const bad of [items({ ...center, src: "peer" }), items({ ...home, src: "center" }), items({ ...center, serverSeq: -1 }),
      items({ ...home, sourceSeq: 2 ** 53 }), items({ ...center, serverSeq: 41 }), items({ ...home, taskId: "../x" }),
      { ...SHARED_LEDGER_ACTIVITY_FIXTURE, truncated: "no" }, { ...SHARED_LEDGER_ACTIVITY_FIXTURE, projectId: undefined }]) rejects("activity", bad);
  });
  test("path cursor is a canonical non-negative safe integer", () => {
    expect(["0", "7", "9007199254740991"].map(parseActivityCursor)).toEqual([0, 7, 9007199254740991]);
    for (const bad of ["", "-1", "01", "1.0", "1e3", " 1", "9007199254740992", "99999999999999999"]) expect(parseActivityCursor(bad)).toBeNull();
  });
});

describe("frozen V1 responses unchanged", () => {
  test("old features/feature fixtures with the old capabilities parse byte-identically", () => {
    expect(JSON.stringify(parseSharedLedgerResponse("features", SHARED_LEDGER_LIST_FIXTURE))).toBe(JSON.stringify(SHARED_LEDGER_LIST_FIXTURE));
    expect(JSON.stringify(parseSharedLedgerResponse("feature", SHARED_LEDGER_FEATURE_FIXTURE))).toBe(JSON.stringify(SHARED_LEDGER_FEATURE_FIXTURE));
    expect(Object.keys(SHARED_LEDGER_CAPABILITIES)).toEqual(["feature.new", "feature.set", "dag.init", "dag.rewrite", "task.new", "dag.bind",
      "stage", "approval", "scopeChange"]);
    // The old parser still refuses an extra capability key, which is why discovery lives in a separate ext-capabilities read.
    expect(() => parseSharedLedgerResponse("features", { ...SHARED_LEDGER_LIST_FIXTURE,
      capabilities: { ...SHARED_LEDGER_CAPABILITIES, versions: { enabled: true } } })).toThrow("invalid_field");
  });
});
