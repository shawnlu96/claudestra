import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";

test("receipt remains immutable after restart, fresh nonce retries; old signature stays blocked", () => {
  const f = fixture();
  try {
    const id = f.create();
    const cmd = { type: "feature.set", projectId: "project-a", featureId: id, expectedRev: 1, requestId: "persistent", patch: { title: "Revised" } };
    const wire = f.signed("bob", cmd);
    const result = f.service.handle(wire, f.now);
    expect(result.status).toBe(200);
    f.restart();
    expect(f.service.handle(wire, f.now).body).toMatchObject({ code: "replayed" });
    expect(f.call("bob", cmd).body).toEqual(result.body as Record<string, any>);
    expect(f.call("bob", null, "commands/persistent", "GET").body.receipt).toEqual(result.body as Record<string, any>);
    expect(f.call("alice", null, "commands/persistent", "GET").body.status).toBe("unknown");
    expect(f.call("bob", { ...cmd, patch: { title: "Different" } }).status).toBe(409);
    expect(f.call("alice", { ...cmd, requestId: "newer", expectedRev: 2, patch: { title: "Newest" } }).status).toBe(200);
    expect(f.call("bob", cmd).body).toEqual(result.body as Record<string, any>);
  } finally { f.cleanup(); }
});
