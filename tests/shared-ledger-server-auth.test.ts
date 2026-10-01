import { test, expect } from "bun:test";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { fixture } from "./shared-ledger-server-fixture.test.js";

test("membership, instance, project, claimed role and revoked credentials cannot broaden authority", () => {
  const f = fixture();
  try {
    const id = f.create();
    f.add("outsider", "member", "project-other");
    const cross = f.call("outsider", null, `features/${id}`, "GET");
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toContain("Shared plan");
    expect(f.call("outsider", { type: "feature.set", projectId: "project-other", featureId: id,
      requestId: "cross", expectedRev: 1, patch: { title: "Stolen" } }).status).toBe(403);
    const wrong = f.signed("alice", null, "features", "GET");
    wrong.instanceId = "instance-bob";
    expect(f.service.handle(wrong, f.now).status).toBe(401);
    const claim = { type: "feature.set", projectId: "project-a", featureId: id, expectedRev: 1, requestId: "claim", patch: { title: "Claim" }, actor: "owner" };
    expect(f.call("alice", claim).body.code).toBe("invalid_field");
    const m = f.manifest();
    expect(f.call("alice", { mode: "commit", batchId: "unauthorized", manifestDigest: "0".repeat(64), manifest: m }, "imports").status).not.toBe(200);
    f.store.run("UPDATE credentials SET revokedAt=? WHERE personId='alice'", f.now);
    expect(f.call("alice", null, "features", "GET").body.code).toBe("not_member");
    f.store.run("UPDATE members SET status='removed' WHERE personId='bob'");
    expect(f.call("bob", null, "features", "GET").body.code).toBe("not_member");
    f.store.run("DELETE FROM credentials WHERE personId='outsider'");
    expect(f.call("outsider", null, "features", "GET").body.code).toBe("not_member");
  } finally { f.cleanup(); }
});

test("valid member import and wrong registered service projection are forbidden", () => {
  const f = fixture();
  try {
    const m = f.manifest();
    m.sourceInstanceId = "instance-alice";
    expect(f.call("alice", { mode: "commit", batchId: "member", manifest: m, manifestDigest: sharedLedgerManifestDigest(m) }, "imports").status).toBe(403);
    const { id } = f.imported();
    f.add("other-service", "service");
    const p = { ...f.projection(id), sourceInstanceId: "instance-other-service" };
    const wrong = f.call("other-service", p, "projections");
    expect(wrong.status).toBe(403);
    expect(wrong.body.latest).toBeUndefined();
  } finally { f.cleanup(); }
});
