import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canManage, canReadLedger } from "../src/lib/devices.js";
import { terminalAllowedFor } from "../src/bridge/terminal-auth.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SHARED_LEDGER_AUTH_HEADERS } from "../src/lib/shared-ledger-auth.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { registerCredential } from "../src/shared-ledger/identity.js";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import type { Principal } from "../src/lib/principals.js";

test("registered shared route authenticates a member at fake center without granting local owner capabilities", async () => {
  const center = fixture(), key = instanceKeySync(STATE_DIR)!;
  center.keys.set("alice", key);
  registerCredential(center.store, { ...center.credentials.get("alice")!, publicKey: key.publicKey }, "alice");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const h = SHARED_LEDGER_AUTH_HEADERS, body = await req.text();
    const result = center.service.handle({ method: req.method, path: new URL(req.url).pathname, body,
      bearer: req.headers.get("authorization")!.slice(7), publicKey: req.headers.get(h.key)!,
      instanceId: req.headers.get(h.instance)!, ts: req.headers.get(h.ts)!, signature: req.headers.get(h.sig)!,
      attemptNonce: req.headers.get(h.nonce)! }, Date.now());
    return Response.json(result.body, { status: result.status });
  } });
  const member: Principal = { id: "guest:c5-member", role: "external", agents: [], manage: false, terminal: false, createdAt: "test" };
  const local = (path: string, method = "GET", payload?: unknown, principal = member) => {
    const url = new URL(`/api/v1${path}`, "https://fixture.invalid");
    return handleLocalApi(new Request(url.toString(), { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), url, principal);
  };
  try {
    writeFileSync(join(STATE_DIR, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: "c5-center", teamId: "team-a", projectId: "project-a" }]), { mode: 0o600 });
    await writeSharedLedgerCredential({ centerId: "c5-center", baseUrl: server.url.origin, teamId: "team-a", personId: "alice",
      instanceId: "instance-alice", bearer: center.secrets.get("alice")!, localSubject: member.id, kind: "person",
      projects: [{ projectId: "project-a", actions: ["read", "plan"] }] });
    const context = await local("/shared-ledger/context");
    expect(context?.status).toBe(200);
    expect(await context!.json()).toEqual({ identities: [{ center: "c5-center", team: "team-a", person: "alice", project: "project-a", homeInstanceId: "instance-alice" }] });
    center.create("Integration feature");
    const list = await local("/shared-ledger/features");
    expect(list?.status).toBe(200);
    expect(((await list!.json()) as { features: unknown[] }).features).toHaveLength(1);
    const result = await local("/shared-ledger/commands", "POST", { type: "feature.new", requestId: "c5-forged-role",
      projectId: "project-a", title: "Member plan", description: "Shared", homeInstanceId: "instance-alice", actor: "owner", role: "owner" });
    expect(result?.status).toBe(200);
    expect(center.call("alice", null, "features", "GET").body.features.find((v: { title: string }) => v.title === "Member plan").updatedBy).toBe("alice");
    const stranger = await local("/shared-ledger/features", "GET", undefined, { ...member, id: "unregistered", role: "owner" });
    expect(stranger?.status).toBe(403);
    for (const [path, method] of [["/ledger/project-a", "GET"], ["/relay/status", "GET"], ["/projects/project-a/open", "POST"]]) {
      const response = await local(path!, method);
      expect(response?.status).toBe(403);
    }
    expect(canManage(member)).toBe(false);
    expect(canReadLedger(member)).toBe(false);
    expect(terminalAllowedFor(member, "agent-any")).toBe(false);
    expect(member).toMatchObject({ role: "external", agents: [], terminal: false, manage: false });
  } finally {
    server.stop(true); center.cleanup();
    for (const name of ["shared-ledger-bindings.json", "shared-ledger-credentials.json"]) rmSync(join(STATE_DIR, name), { force: true });
  }
});
