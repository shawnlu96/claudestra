import { expect, test } from "bun:test";
import { FEATURE_DEPS_RESOURCE, parseFeatureDeps, parseFeatureDepsUpload, parseFeatureDepsReceipt } from "../src/lib/shared-ledger-contract-feature-deps.js";
import { FEATURE_DEPS_UPLOAD_FIXTURE, FEATURE_DEPS_READ_FIXTURE, FEATURE_DEPS_INVALID_UPLOADS,
  FEATURE_DEPS_OLD_CENTER_STATUS } from "../src/lib/shared-ledger-contract-feature-deps-fixtures.js";

test("[验收线 1] synthetic upload, read and receipt parse; resource is standalone", () => {
  expect(parseFeatureDepsUpload(FEATURE_DEPS_UPLOAD_FIXTURE)).toEqual(FEATURE_DEPS_UPLOAD_FIXTURE);
  expect(parseFeatureDeps(FEATURE_DEPS_READ_FIXTURE)).toEqual(FEATURE_DEPS_READ_FIXTURE);
  expect(parseFeatureDepsReceipt({ schemaVersion: 1, accepted: 3 })).toEqual({ schemaVersion: 1, accepted: 3 });
  expect(FEATURE_DEPS_RESOURCE.test("feature-deps")).toBe(true);
  expect(FEATURE_DEPS_RESOURCE.test("feature-deps?projectId=project-a")).toBe(false);
  expect(FEATURE_DEPS_OLD_CENTER_STATUS).toBe(403);
});
for (const [name, value] of Object.entries(FEATURE_DEPS_INVALID_UPLOADS)) {
  test(`[验收线 1] fail closed: ${name}`, () => {
    expect(() => parseFeatureDepsUpload(value)).toThrow();
    const { sourceInstanceId: _source, ...row } = value as Record<string, unknown>;
    expect(() => parseFeatureDeps({ ...row, updatedAt: 1 })).toThrow();
  });
}
test("[验收线 1] closed read and receipt; ids, booleans and safe positive counts", () => {
  expect(() => parseFeatureDeps({ ...FEATURE_DEPS_READ_FIXTURE, note: "hidden" })).toThrow();
  expect(() => parseFeatureDepsReceipt({ schemaVersion: 1, accepted: 0, extra: true })).toThrow();
  for (const patch of [{ projectId: "../private" }, { satisfied: 1 }, { count: 1.5 }, { count: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => parseFeatureDepsUpload({ ...FEATURE_DEPS_UPLOAD_FIXTURE,
      edges: [{ ...FEATURE_DEPS_UPLOAD_FIXTURE.edges[0], ...patch }] })).toThrow();
  }
});
