import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { registerCredential } from "../src/shared-ledger/identity.js";
import { signSharedLedgerRequest, sharedLedgerCredentialHash, type SharedLedgerCredential } from "../src/lib/shared-ledger-auth.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { SharedLedgerImportManifest, SharedLedgerProjection, SharedLedgerCommandResult } from "../src/lib/shared-ledger-contract.js";

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-test-"));
  const path = join(dir, "shared.sqlite");
  let store = new Store(path);
  let service = new LedgerService(store);
  const keys = new Map<string, InstanceKey>();
  const secrets = new Map<string, string>();
  const credentials = new Map<string, SharedLedgerCredential>();
  const now = Date.now();
  function add(person: string, role: "member" | "owner" | "service" = "member", project = "project-a", actions?: SharedLedgerCredential["projects"][number]["actions"]) {
    const pair = generateKeyPairSync("ed25519");
    const key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
    keys.set(person, key);
    const secret = randomBytes(24).toString("hex");
    secrets.set(person, secret);
    const c: SharedLedgerCredential = { credentialHash: sharedLedgerCredentialHash(secret), teamId: "team-a", personId: person,
      instanceId: `instance-${person}`, publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: now + 1000000,
      projects: [{ projectId: project, role, actions: actions ?? (role === "service" ? ["read", "plan", "import", "project"] : role === "owner" ? ["read", "plan", "import"] : ["read", "plan"]) }] };
    credentials.set(person, c);
    registerCredential(store, c, person);
    return c;
  }
  add("alice"); add("bob"); add("home", "service");
  function signed(person: string, payload: unknown = null, resource = "commands", method = "POST") {
    const attemptNonce = randomBytes(16).toString("hex");
    return signSharedLedgerRequest({ method, path: `/v1/teams/team-a/${resource}`, body: method === "GET" ? "" : JSON.stringify({ attemptNonce, payload }),
      bearer: secrets.get(person)!, instanceId: credentials.get(person)!.instanceId, ts: String(Math.floor(now / 1000)), attemptNonce }, keys.get(person)!);
  }
  function call(person: string, payload: unknown = null, resource = "commands", method = "POST") {
    const r = service.handle(signed(person, payload, resource, method), now);
    return { status: r.status, body: r.body as Record<string, any> };
  }
  function create(title = "Feature") {
    const r = call("alice", { type: "feature.new", projectId: "project-a", requestId: randomBytes(6).toString("hex"),
      title, description: "Shared plan", homeInstanceId: "instance-home" });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
    return (r.body as unknown as SharedLedgerCommandResult).result.featureId;
  }
  const node = (key = "n1") => ({ key, oneLine: "Work", deps: [] as string[], fileGlobs: ["src/sample.ts"], estimate: "1h" });
  function manifest(title = "Imported"): SharedLedgerImportManifest {
    return { projectId: "project-a", sourceInstanceId: "instance-home", sourceSeq: 10, features: [{
      sourceFeatureId: "source-feature", title, description: "Shared import", rev: 1, authorityMode: "planning", pendingProposal: false,
      versions: [{ version: 1, nodes: [node()], bindings: [{ nodeKey: "n1", taskId: "source-task" }], reason: "Initial" }],
      projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 10, observedAt: now, tasks: [{ sourceTaskId: "source-task",
        sourceRev: 1, sourceSeq: 10, stage: "build", assigneeCode: "worker", executorInstanceId: "instance-home", pr: null, head: null,
        deps: [], specSummary: "Shared summary", specDigest: null, fullText: "home_only", asks: [],
        steps: [{ sourceStepId: "step-a", sourceRev: 1, sourceSeq: 10, state: "running" }] }], events: [] } }] };
  }
  function imported() {
    const m = manifest();
    const r = call("home", { mode: "commit", batchId: "batch-a", manifestDigest: sharedLedgerManifestDigest(m), manifest: m }, "imports");
    if (r.status !== 200) throw new Error(JSON.stringify(r));
    return { id: r.body.mappings.find((v: { kind: string }) => v.kind === "feature").id as string, manifest: m };
  }
  function projection(id: string, m = manifest()): SharedLedgerProjection {
    return { ...m.features[0]!.projection, projectId: m.projectId, featureId: id, sourceInstanceId: m.sourceInstanceId,
      mode: "delta", previousSourceSeq: 10, sourceSeq: 11 };
  }
  return { get store() { return store; }, get service() { return service; }, now, add, credentials, secrets, keys, signed, call, create, node, manifest, imported, projection,
    restart() { store.close(); store = new Store(path); service = new LedgerService(store); },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
