import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { startServer } from "../src/shared-ledger/server.js";
import { registerCredential } from "../src/shared-ledger/identity.js";
import { sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { writeSharedLedgerCredential, resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";

export async function c6Fixture() {
  const root = mkdtempSync(join(tmpdir(), "c6-http-"));
  const dirs = [join(root, "peer-a"), join(root, "peer-b")];
  dirs.forEach((dir) => mkdirSync(dir));
  const keys = dirs.map((dir) => instanceKeySync(dir)!);
  let store = new Store(join(root, "shared.sqlite")), service = new LedgerService(store), server = startServer(service);
  const baseUrl = server.url.origin;
  const scrub = { identity: { username: "private-user", hostname: "private-host" } };
  function credential(person: string, side: number, role: "member" | "service", actions: ("read" | "plan" | "import" | "project")[]) {
    const bearer = randomBytes(24).toString("hex"), instanceId = side === 0 ? "peer-a" : "peer-b";
    registerCredential(store, { credentialHash: sharedLedgerCredentialHash(bearer), teamId: "team", personId: person, instanceId,
      publicKey: keys[side]!.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: Date.now() + 3600000,
      projects: [{ projectId: "project", role, actions }] }, side === 0 ? "peer-A" : "peer-B");
    return { baseUrl, centerId: "center", teamId: "team", personId: person, instanceId, bearer };
  }
  const connections = [credential("member-a", 0, "member", ["read", "plan"]), credential("member-b", 1, "member", ["read", "plan"])];
  const importer = credential("migration", 0, "service", ["read", "import", "project"]);
  for (const side of [0, 1]) await writeSharedLedgerCredential({ ...connections[side]!, localSubject: "owner:self", kind: "person",
    projects: [{ projectId: "project", actions: ["read", "plan"] }] }, dirs[side]);
  const members = dirs.map((dir, side) => new SharedLedgerClient(resolveSharedLedgerCredential("owner:self", "person", "center", "team", "project", "plan", dir)!,
    keys[side]!, { scrub }));
  const client = (fetcher?: typeof fetch) => new SharedLedgerClient(importer, keys[0]!, { scrub, fetch: fetcher, timeoutMs: 1000 });
  const path = join(dirs[0]!, "ledger.sqlite"), db = openLedger(path), ctx = { actor: "owner" };
  db.run("INSERT INTO ledger_instance VALUES ('origin','c660')");
  createTask(db, ctx, { project: "local-project", id: "card-a", title: "Existing card", kind: "code" });
  const feature = createFeature(db, ctx, { project: "local-project", slug: "plan", title: "Imported plan" }).row;
  initDag(db, ctx, { id: feature.id, rev: 1, nodes: [{ key: "bound", taskId: "card-a", oneLine: "Existing card", fileGlobs: ["src/bound.ts"] },
    { key: "free", oneLine: "Unbound plan", fileGlobs: ["src/sample.ts"] }] });
  const options = { localProject: "local-project", projectId: "project", sourceInstanceId: "peer-a", featureIds: [feature.id],
    batchId: "batch", stateDir: dirs[0]!, scrub, summaries: {} };
  return { root, dirs, keys, members, connections, importer, db, options, client, port: server.port,
    get store() { return store; },
    stop() { server.stop(true); },
    restart() { const port = server.port; server.stop(true); store.close(); store = new Store(join(root, "shared.sqlite"));
      service = new LedgerService(store); server = startServer(service, { port }); },
    close() { server.stop(true); store.close(); closeLedger(path); rmSync(root, { recursive: true, force: true }); },
  };
}
