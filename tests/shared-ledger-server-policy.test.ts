import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { createHandler, readBody, startServer } from "../src/shared-ledger/server.js";

test("bound nodes frozen; execution and arbitrary fields rejected; unbound edits allowed", () => {
  const f = fixture();
  try {
    const { id } = f.imported();
    const base = { type: "dag.rewrite", projectId: "project-a", featureId: id, expectedRev: 1, baseVersion: 1,
      requestId: "rewrite", nodes: [{ ...f.node(), oneLine: "Changed" }], reason: "Change" };
    for (const nodes of [base.nodes, [], [{ ...f.node(), estimate: "2h" }], [{ ...f.node(), deps: ["n2"] }, f.node("n2")]]) {
      expect(f.call("bob", { ...base, nodes }).body.code).toBe("execution_not_shared");
    }
    expect(f.call("bob", { ...base, nodes: [f.node(), f.node("n2")] }).status).toBe(200);
    for (const type of ["task.new", "dag.bind", "stage", "approval", "scopeChange"]) {
      expect(f.call("bob", { ...base, type }).body.code).toBe("execution_not_shared");
    }
    expect(f.call("alice", { ...base, owner: true }).body.code).toBe("invalid_field");
    expect(f.call("alice", { ...base, nodes: [{ ...f.node(), deps: ["n1"] }] }).body.code).toBe("invalid_field");
    const seq = f.store.seq();
    expect(f.call("bob", { type: "feature.set", projectId: "project-a", featureId: id, expectedRev: 2, requestId: "sensitive",
      patch: { description: "Contact demo@example.invalid" } }).body.code).toBe("invalid_field");
    expect(f.store.seq()).toBe(seq);
  } finally { f.cleanup(); }
});

test("HTTP size limit, streaming timeout, rate limit and loopback enforcement", async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.service, { maxBodyBytes: 32, requestsPerMinute: 1 });
    const large = await handler(new Request("http://localhost/v1/teams/team-a/commands", { method: "POST", body: "x".repeat(33) }));
    expect(large.status).toBe(413);
    expect((await handler(new Request("http://localhost/v1/teams/team-a/features"))).status).toBe(429);
    const stream = new ReadableStream<Uint8Array>({ start() { /* Deliberately never produce a chunk to exercise the read deadline. */ } });
    const request = new Request("http://localhost/v1/teams/team-a/commands", { method: "POST", body: stream });
    await expect(readBody(request, 100, 10)).rejects.toThrow("timed out");
    expect(() => startServer(f.service, { hostname: "0.0.0.0" })).toThrow("loopback");
  } finally { f.cleanup(); }
});

test("HTTP transport accepts signed loopback requests and returns durable receipts", async () => {
  const f = fixture();
  const server = startServer(f.service);
  try {
    const { SHARED_LEDGER_AUTH_HEADERS: H } = await import("../src/lib/shared-ledger-auth.js");
    const signed = f.signed("alice", { type: "feature.new", projectId: "project-a", requestId: "http",
      title: "HTTP feature", description: "Loopback transport", homeInstanceId: "instance-home" });
    const response = await fetch(new URL(signed.path, server.url), { method: "POST", body: signed.body,
      headers: { authorization: `Bearer ${signed.bearer}`, [H.key]: signed.publicKey, [H.ts]: signed.ts,
        [H.sig]: signed.signature, [H.instance]: signed.instanceId, [H.nonce]: signed.attemptNonce } });
    expect(response.status).toBe(200);
    const result = await response.json() as { requestId: string };
    expect(result.requestId).toBe("http");
  } finally { server.stop(true); f.cleanup(); }
});
