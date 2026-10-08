import { EnrollmentResponses } from "./shared-ledger-migration-http-fixture.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjects } from "../src/lib/projects.js";
import { joinSharedLedger } from "../src/lib/shared-ledger-join.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { sharedLedgerGateProxy, SHARED_LEDGER_PROJECT_HEADER } from "../src/lib/shared-ledger-gate-proxy.js";
import { handleSharedLedgerApi } from "../src/bridge/local-api/shared-ledger.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { Principal } from "../src/lib/principals.js";

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const scrub = { identity: { username: "nobody-local", hostname: "nobody-host" } };
const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-10-02T00:00:00Z" } as Principal;
let root: string, responses: EnrollmentResponses, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-migration-http-"));
  responses = new EnrollmentResponses();
  url = responses.url;
});
afterAll(() => { responses.close(); rmSync(root, { recursive: true, force: true }); });

/** 本机 joins the given projects and creates one feature in each; returns the feature id per project. */
async function enroll(dir: string, key: InstanceKey, person: string, projects: string[]): Promise<Record<string, string>> {
  await writeProjects({ projects: projects.map(id => ({ id, name: id, dirs: [], createdAt: "" })) }, join(dir, "projects.json"));
  const out: Record<string, string> = {};
  for (const projectId of projects) {
    const invite = responses.invite({ projectId, personId: person });
    const joined = await joinSharedLedger({ url, code: String(invite.joinCode), key, subject: owner.id, stateDir: dir });
    const credential = resolveSharedLedgerCredential(owner.id, "person", joined.centerId, "team-a", projectId, "plan", dir)!;
    const created = await new SharedLedgerClient(credential, key, { scrub }).command({ type: "feature.new", projectId,
      requestId: randomBytes(6).toString("hex"), title: `${person} ${projectId} plan`, description: "Shared plan", homeInstanceId: credential.instanceId });
    out[projectId] = (created as { result: { featureId: string } }).result.featureId;
  }
  return out;
}
const proxy = (dir: string, key: InstanceKey, path: string, project?: string) => sharedLedgerGateProxy(
  new Request(`http://127.0.0.1/api/v1${path}`, { headers: project === undefined ? {} : { [SHARED_LEDGER_PROJECT_HEADER]: project } }),
  path, owner, handleSharedLedgerApi, { stateDir: dir, key: () => key });

describe("shared ledger gate proxy routes by project", () => {
  test("本机 joined to A and B reads each project through the web entry and only sees that project", async () => {
    const dir = join(root, "local-multi"), key = newKey();
    const ids = await enroll(dir, key, "local-multi", ["project-a", "project-b"]);
    for (const [projectId, other] of [["project-a", "project-b"], ["project-b", "project-a"]] as const) {
      const list = await proxy(dir, key, "/shared-ledger/features", projectId);
      expect(list!.status).toBe(200);
      const features = (await list!.json() as { features: { id: string; projectId: string }[] }).features;
      expect(features.map((f) => f.id)).toContain(ids[projectId]!);
      expect(features.every((f) => f.projectId === projectId)).toBe(true);
      expect(features.map((f) => f.id)).not.toContain(ids[other]!);
      const detail = await proxy(dir, key, `/shared-ledger/features/${ids[projectId]}`, projectId);
      expect((await detail!.json() as { feature: { projectId: string } }).feature.projectId).toBe(projectId);
      expect((await proxy(dir, key, `/shared-ledger/features/${ids[other]}`, projectId))!.status).toBe(403);
    }
  });

  test("without a project several bindings answer a distinct project_required code, not a bare 403", async () => {
    const dir = join(root, "local-multi"), key = newKey();
    const r = await proxy(dir, key, "/shared-ledger/features");
    expect(r!.status).toBe(409);
    const body = await r!.json() as { code: string; projects: string[] };
    expect(body.code).toBe("shared_ledger_project_required");
    expect(body.projects.sort()).toEqual(["project-a", "project-b"]);
    const context = await (await proxy(dir, key, "/shared-ledger/context"))!.json() as { identities: { project: string }[] };
    expect(context.identities.map((i) => i.project).sort()).toEqual(["project-a", "project-b"]);
  });

  test("a project the principal has no binding for is refused; the header grants no authority", async () => {
    const r = await proxy(join(root, "local-multi"), newKey(), "/shared-ledger/features", "project-c");
    expect(r!.status).toBe(403);
    expect(await r!.json()).toEqual({ error: "shared ledger identity unavailable" });
  });

  test("a single binding behaves as before with or without the project header", async () => {
    const dir = join(root, "local-single"), key = newKey();
    const ids = await enroll(dir, key, "local-single", ["project-a"]);
    for (const project of [undefined, "project-a"]) {
      const r = await proxy(dir, key, "/shared-ledger/features", project);
      expect(r!.status).toBe(200);
      expect((await r!.json() as { features: { id: string }[] }).features.map((f) => f.id)).toContain(ids["project-a"]!);
    }
    expect((await proxy(dir, key, "/shared-ledger/features", "project-b"))!.status).toBe(403);
    expect((await proxy(join(root, "local-none"), key, "/shared-ledger/features"))!.status).toBe(403);
  });
});
