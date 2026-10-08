import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/lib/canonical-json.js";
import {
  SOURCE_DAG_UPLOAD_PATH, SOURCE_DAG_UPLOAD_RESOURCE, SOURCE_DAG_UPLOAD_STATUS,
  parseSourceDagUpload, parseSourceDagUploadResponse, sourceDagUploadDigest,
} from "../src/lib/shared-ledger-contract-source-dag.js";
import {
  SOURCE_DAG_UPLOAD_ERROR_FIXTURES, SOURCE_DAG_UPLOAD_FIXTURE, SOURCE_DAG_UPLOAD_RESULT_FIXTURE,
} from "../src/lib/shared-ledger-contract-source-dag-fixtures.js";

const req = SOURCE_DAG_UPLOAD_FIXTURE;
const dag = req.dag;
const rejects = (value: unknown) => expect(() => parseSourceDagUpload(value)).toThrow("invalid_field");
const fixtureDigest = createHash("sha256").update(canonicalJson(req)).digest("hex");
const okBody = { ...SOURCE_DAG_UPLOAD_RESULT_FIXTURE, digest: fixtureDigest };

describe("source-dag upload request", () => {
  test("fixture parses to itself and its digest is canonical JSON sha256", () => {
    expect(parseSourceDagUpload(req)).toEqual(req);
    expect(sourceDagUploadDigest(req)).toBe(fixtureDigest);
    expect(sourceDagUploadDigest(structuredClone(req))).toBe(fixtureDigest);
    expect(sourceDagUploadDigest({ ...req, dag: { ...dag, reason: "改了原因" } })).not.toBe(fixtureDigest);
  });
  test("endpoint and status table are fixed", () => {
    expect(SOURCE_DAG_UPLOAD_PATH).toBe(`/v1/teams/{teamId}/${SOURCE_DAG_UPLOAD_RESOURCE}`);
    expect(SOURCE_DAG_UPLOAD_STATUS).toEqual({ ok: 200, invalid_field: 400, forbidden: 403, unsupported: 404, conflict: 409 });
  });
  test("missing / extra fields at both levels are refused", () => {
    for (const key of Object.keys(req)) {
      const { [key]: _drop, ...rest } = req as unknown as Record<string, unknown>;
      rejects(rest);
    }
    for (const key of Object.keys(dag)) {
      const { [key]: _drop, ...rest } = dag as unknown as Record<string, unknown>;
      rejects({ ...req, dag: rest });
    }
    rejects({ ...req, extra: 1 });
    rejects({ ...req, dag: { ...dag, text: "原文" } });
    rejects({ ...req, schemaVersion: 2 });
    rejects({ ...req, featureId: "" });
  });
  test("version must be a positive safe integer", () => {
    for (const version of [0, -1, 1.5, "17", null, Number.MAX_SAFE_INTEGER + 1]) rejects({ ...req, dag: { ...dag, version } });
  });
  test("invalid nodes reuse validateDag negatives: unknown dep, cycle, duplicate key, bad glob", () => {
    const [a1, a2] = dag.nodes;
    for (const nodes of [[{ ...a1!, deps: ["Z9"] }, a2], [{ ...a1!, deps: ["A2"] }, a2], [a1, { ...a2!, key: "A1" }],
      [{ ...a1!, fileGlobs: ["../x"] }, a2], [{ ...a1!, oneLine: "" }, a2]]) rejects({ ...req, dag: { ...dag, nodes } });
  });
  test("bindings referencing a missing nodeKey or duplicating key/task are refused", () => {
    for (const bindings of [[{ nodeKey: "Z9", taskId: "t" }], [{ nodeKey: "A1", taskId: "t1" }, { nodeKey: "A1", taskId: "t2" }],
      [{ nodeKey: "A1", taskId: "t" }, { nodeKey: "A2", taskId: "t" }], [{ nodeKey: "A1", taskId: "t", extra: 1 }]]) {
      rejects({ ...req, dag: { ...dag, bindings } });
    }
  });
});

describe("source-dag upload response", () => {
  test("200 success body parses with droppedBindings", () => {
    expect(parseSourceDagUploadResponse(200, okBody)).toEqual({ kind: "ok", result: okBody });
  });
  test("404 means unsupported regardless of body", () => {
    for (const body of [undefined, null, "Not Found", { code: "not_found" }]) {
      expect(parseSourceDagUploadResponse(404, body)).toEqual({ kind: "unsupported" });
    }
  });
  test("every error fixture parses under its own status", () => {
    for (const e of Object.values(SOURCE_DAG_UPLOAD_ERROR_FIXTURES)) {
      expect(e.status).toBe(SOURCE_DAG_UPLOAD_STATUS[e.code]);
      expect(parseSourceDagUploadResponse(e.status, e)).toEqual({ kind: "error", error: e });
    }
  });
  test("unknown / missing fields, mismatched status and unknown codes are refused", () => {
    const { conflict, forbidden } = SOURCE_DAG_UPLOAD_ERROR_FIXTURES;
    const { droppedBindings: _d, ...noDropped } = okBody;
    const bad: [number, unknown][] = [
      [200, { ...okBody, extra: 1 }], [200, noDropped], [200, { ...okBody, droppedBindings: -1 }], [200, { ...okBody, version: 0 }],
      [200, { ...okBody, digest: "x" }], [403, { ...forbidden, extra: 1 }], [409, { ...conflict, currentVersion: undefined }],
      [409, { ...forbidden, status: 409 }], [400, forbidden], [403, { ...forbidden, currentVersion: 3 }],
      [500, { schemaVersion: 1, code: "internal", status: 500, message: "x" }], [413, { schemaVersion: 1, code: "payload_too_large", status: 413, message: "x" }],
    ];
    for (const [status, body] of bad) expect(() => parseSourceDagUploadResponse(status, body)).toThrow("invalid_field");
  });
});
