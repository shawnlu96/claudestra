import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";

test("all HTTP business responses conform to frozen C1 parsers", () => {
  const f = fixture();
  try {
    const command = { type: "feature.new", requestId: "contract", projectId: "project-a", title: "Contract",
      description: "Plan", homeInstanceId: "instance-home" };
    const r = f.call("alice", command);
    expect(parseSharedLedgerResponse("command", r.body).requestId).toBe("contract");
    expect(parseSharedLedgerResponse("receipt", f.call("alice", null, "commands/contract", "GET").body).status).toBe("committed");
    expect(parseSharedLedgerResponse("features", f.call("bob", null, "features", "GET").body).features).toHaveLength(1);
    const m = f.manifest();
    const imp = f.call("home", { mode: "commit", batchId: "contract-import", manifest: m,
      manifestDigest: sharedLedgerManifestDigest(m) }, "imports");
    const imported = parseSharedLedgerResponse("import", imp.body);
    const id = imported.mappings.find((v) => v.kind === "feature")!.id;
    const d = parseSharedLedgerResponse("feature", f.call("bob", null, `features/${id}`, "GET").body);
    expect(d.dag.version).toBe(1);
    expect(d.dag.bindings[0]!.taskId).toBe(d.tasks[0]!.taskId);
    const conflict = f.call("bob", { type: "feature.set", requestId: "conflict", projectId: "project-a", featureId: id,
      expectedRev: 99, patch: { title: "Changed" } });
    expect(parseSharedLedgerResponse("error", conflict.body).code).toBe("conflict");
    const p = f.call("home", f.projection(id, m), "projections");
    expect(parseSharedLedgerResponse("projection", p.body).sourceSeq).toBe(11);
  } finally { f.cleanup(); }
});
