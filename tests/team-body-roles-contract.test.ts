/** team-project-TEAMVIS12: reviewer on review meta, `{pm}` as spec meta, the identity's two shapes; same rules for record / upload / read. */
import { expect, test } from "bun:test";
import {
  parseTeamBodyRead, parseTeamBodyRecord, parseTeamBodyUpload, teamBodyDigest, type TeamBodyKind, type TeamBodyRecord,
} from "../src/lib/shared-ledger-contract-team-body.js";
import { checkedIdentity } from "../src/lib/team-body-roles-contract.js";

const rec = (kind: TeamBodyKind, sourceKey: string, text: string, meta?: unknown): TeamBodyRecord => ({
  featureId: "feat-1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text), ...(meta === undefined ? {} : { meta }),
} as TeamBodyRecord);
const TS = 1_791_000_000_000;
const upload = (records: unknown[]) => ({ schemaVersion: 1, projectId: "proj-1", sourceInstanceId: "home-1", batchId: "ab".repeat(16), records });
const read = (records: unknown[]) => ({ schemaVersion: 1, teamId: "team-a", projectId: "proj-1", featureId: "feat-1", taskId: "task-1", records, syncedAt: TS, homeOnline: true });
/** Every parser takes it, as itself. */
const takes = (r: ReturnType<typeof rec>) => {
  expect(parseTeamBodyRecord(r)).toEqual(r);
  expect(parseTeamBodyUpload(upload([r])).records).toEqual([r]);
  expect(parseTeamBodyRead(read([r])).records).toEqual([r]);
};
/** Every parser refuses it. */
const refuses = (r: ReturnType<typeof rec>) => {
  expect(() => parseTeamBodyRecord(r)).toThrow("invalid_field");
  expect(() => parseTeamBodyUpload(upload([r]))).toThrow("invalid_field");
  expect(() => parseTeamBodyRead(read([r]))).toThrow("invalid_field");
};

test("[验收线 1] review meta with reviewer {instanceId} or {memberCode, instanceId?}, spec meta {pm}: taken by record, upload and read", () => {
  for (const reviewer of [{ instanceId: "home-1" }, { memberCode: "m-ab", instanceId: "home-1" }, { memberCode: "m-ab" }]) {
    takes(rec("review", "14", "审查结论 pass", { kind: "review", ts: TS, reviewer }));
  }
  for (const pm of [{ instanceId: "home-1" }, { memberCode: "m-pm", instanceId: "home-1" }, { memberCode: "m-pm" }]) takes(rec("spec", "3", "# 规格", { pm }));
  takes(rec("review", "14", "审查结论 pass", { kind: "review", ts: TS }));
});

test("[验收线 1] event with reviewer, review with pm, spec with kind / ts / reviewer or empty meta, session-page with meta: invalid", () => {
  refuses(rec("event", "12", "x", { kind: "note", ts: TS, reviewer: { instanceId: "home-1" } }));
  refuses(rec("event", "12", "x", { kind: "note", ts: TS, pm: { instanceId: "home-1" } }));
  refuses(rec("review", "14", "x", { kind: "review", ts: TS, pm: { instanceId: "home-1" } }));
  refuses(rec("review", "14", "x", { reviewer: { instanceId: "home-1" } }));
  refuses(rec("spec", "3", "x", { kind: "note", ts: TS }));
  refuses(rec("spec", "3", "x", { pm: { instanceId: "home-1" }, kind: "note", ts: TS }));
  refuses(rec("spec", "3", "x", { reviewer: { instanceId: "home-1" } }));
  refuses(rec("spec", "3", "x", { pm: { instanceId: "home-1" }, reviewer: { instanceId: "home-1" } }));
  refuses(rec("spec", "3", "x", {}));
  expect(() => parseTeamBodyRecord(rec("session-page", "page:1", "x", { pm: { instanceId: "home-1" } }))).toThrow("invalid_field");
});

test("[验收线 1] identity: empty, an extra key, both missing, non-id values → invalid, wherever it sits", () => {
  const bad = [{}, { instanceId: "home-1", agentId: "a" }, { memberCode: "m", instanceId: "home-1", x: 1 }, { memberCode: "m", personId: "p" },
    { instanceId: "" }, { instanceId: "_x" }, { instanceId: "a b" }, { memberCode: 7 }, { memberCode: null, instanceId: "home-1" }, null, "home-1", []];
  for (const identity of bad) {
    expect(checkedIdentity(identity)).toBeUndefined();
    refuses(rec("review", "14", "x", { kind: "review", ts: TS, reviewer: identity }));
    refuses(rec("spec", "3", "x", { pm: identity }));
  }
});
