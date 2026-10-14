/** team-project-TEAMVIS12 · 读口：review 挂回核过的 reviewer、spec 挂回核过的 pm；形状不对只丢这个键；event 的 meta 照 TEAMVIS7。 */
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTeamBodyCapabilityCache, teamBodyRead } from "../src/bridge/local-api/team-body.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { teamBodyDigest } from "../src/lib/shared-ledger-contract-team-body.js";

const conn = { centerId: "fake-center", baseUrl: "http://127.0.0.1/", teamId: "fake-team", personId: "fake-member",
  instanceId: "fake-instance", bearer: "obviously-fake-credential" };
const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
const PATH = "/shared-ledger/team-body/features/feat-1/tasks/task-1";
const rec = (kind: "event" | "review" | "spec", sourceKey: string, text: string, meta?: unknown) =>
  ({ featureId: "feat-1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text), ...(meta === undefined ? {} : { meta }) });

let dir = "";
afterEach(() => { resetTeamBodyCapabilityCache(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

async function readBack(records: unknown[]): Promise<Record<string, unknown>[]> {
  dir = mkdtempSync(join(tmpdir(), "team-body-roles-read-"));
  await writeSharedLedgerCredential({ ...conn, localSubject: "owner:self", kind: "person", projects: [{ projectId: "fake-project", actions: ["read"] }] }, dir);
  const body = { schemaVersion: 1, teamId: "fake-team", projectId: "fake-project", featureId: "feat-1", taskId: "task-1", records, syncedAt: 1, homeOnline: true };
  const fetcher = (async (url: URL | string) => new URL(String(url)).pathname.endsWith("/capability")
    ? Response.json({ schemaVersion: 1, teamId: "fake-team", teamBody: true }) : Response.json(body)) as typeof fetch;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project",
    key: { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) }, fetch: fetcher };
  const res = (await teamBodyRead(new Request(`https://fake.invalid/api/v1${PATH}`), PATH, principal, deps))!;
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: Record<string, unknown>[] }).records;
}

const reviewer = { memberCode: "m-rev", instanceId: "inst-rev" }, pm = { memberCode: "m-pm", instanceId: "inst-pm" };

test("[验收线 6] review 带 reviewer、spec 带 pm → 代理回包照带；event meta 与 TEAMVIS7 一致", async () => {
  const stage = { kind: "stage", ts: 1000, stageTo: "build" };
  const got = await readBack([
    rec("event", "3", "交付 PR", stage), rec("review", "4", "审查结论 pass · P0 0 / P1 0 / P2 0", { kind: "review", ts: 1001, reviewer }),
    rec("spec", "2", "# 规格", { pm }),
  ]);
  expect(got.map((r) => r.meta ?? null)).toEqual([stage, { reviewer }, { pm }]);
  expect(got[2]).toEqual(rec("spec", "2", "# 规格", { pm }));
});

test("[验收线 6] 身份形状不对只丢那个键，整份正文照回", async () => {
  const got = await readBack([
    rec("review", "4", "a", { kind: "review", ts: 1001, reviewer: { memberCode: "m", agentId: "x" } }),
    rec("review", "5", "b", { kind: "review", ts: 1002, reviewer: {} }),
    rec("spec", "2", "# 规格", { pm: { instanceId: "_bad" } }),
    rec("spec", "3", "# 规格 3", { pm: { instanceId: "inst-pm" }, kind: "note" }),
    rec("event", "6", "c", { kind: "note", ts: 1003, reviewer }),
  ]);
  expect(got).toHaveLength(5);
  expect(got.map((r) => r.meta ?? null)).toEqual([null, null, null, { pm: { instanceId: "inst-pm" } }, { kind: "note", ts: 1003 }]);
});
