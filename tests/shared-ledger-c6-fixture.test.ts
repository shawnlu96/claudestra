import { c6Responses, RecordedResponses } from "./shared-ledger-migration-http-fixture.ts";
import { writeProjects } from "../src/lib/projects.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { writeSharedLedgerCredential, resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";

export async function c6Fixture(caseId: string) {
  const root = mkdtempSync(join(tmpdir(), "c6-http-"));
  const dirs = [join(root, "peer-a"), join(root, "peer-b")];
  dirs.forEach((dir) => mkdirSync(dir));
  for (const dir of dirs) await writeProjects({ projects: [{ id: "local-project", name: "Local project", dirs: [], createdAt: "" }] }, join(dir, "projects.json"));
  const keys = dirs.map((dir) => instanceKeySync(dir)!);
  const tape = new RecordedResponses(c6Responses(caseId));
  const people = new Map<string, string>();
  const fetcher = (request: Request) => tape.respond(request, people.get(request.headers.get("authorization")!.slice(7)) ?? null);
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetcher });
  const baseUrl = server.url.origin;
  const scrub = { identity: { username: "private-user", hostname: "private-host" } };
  function credential(person: string, side: number, role: "member" | "service", actions: ("read" | "plan" | "import" | "project")[]) {
    const bearer = randomBytes(24).toString("hex"), instanceId = side === 0 ? "peer-a" : "peer-b";
    people.set(bearer, person);
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
    stop() { server.stop(true); },
    restart() { const port = server.port; server.stop(true); server = Bun.serve({ hostname: "127.0.0.1", port, fetch: fetcher }); },
    close() { server.stop(true); closeLedger(path); rmSync(root, { recursive: true, force: true }); },
  };
}
