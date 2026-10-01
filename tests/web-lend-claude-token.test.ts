import { expect, test } from "bun:test";
import { makeLendClaudeTokenApi } from "../src/bridge/local-api/lend-claude-token.js";
import { effectivePrincipal, type DeviceCredential } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
const base: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01", terminal: true };
const device = (manage: boolean, agents = ["*"], terminal = true) => effectivePrincipal({ principal: base, credential: {
  id: "d", v: 1, type: "bearer", hash: "fake", deviceName: "test", createdAt: "2026-01-01",
  grant: { agents, terminal, manage },
} as DeviceCredential });
const path = "/lend/claude-token";
test("owner/full credential before any IO; response never reflects token", async () => {
  let calls = 0;
  const api = makeLendClaudeTokenApi({ status: () => { calls++; return { configured: true, savedAt: "2026-01-01" }; },
    save: async () => { calls++; return { configured: true, savedAt: "2026-01-01" }; } });
  for (const p of [device(false), device(true, ["worker"]), { ...base, id: "guest:x", role: "external" } as Principal]) {
    expect((await api(new Request("http://test", { method: "POST", body: "invalid" }), path, p))?.status).toBe(403);
  }
  expect(calls).toBe(0);
  const response = await api(new Request("http://test", { method: "POST", body: JSON.stringify({ token: "fake-secret-cl3" }) }), path, device(true));
  expect(response?.status).toBe(200);
  expect(await response?.text()).not.toContain("fake-secret-cl3");
  expect((await api(new Request("http://test", { method: "POST", body: "x".repeat(16385) }), path, device(true)))?.status).toBe(413);
  expect(calls).toBe(1);
});

test("unknown-length stream is bounded; IO errors cannot reflect secret", async () => {
  let io = 0;
  const api = makeLendClaudeTokenApi({ status: () => { io++; throw new Error("fake-secret-cl3"); },
    save: async () => { io++; throw new Error("fake-secret-cl3"); } });
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); c.close(); } });
  expect((await api(new Request("http://test", { method: "POST", body: stream }), path, device(true)))?.status).toBe(413);
  expect(io).toBe(0);
  const r = await api(new Request("http://test"), path, device(true));
  expect(r?.status).toBe(503);
  expect(await r?.text()).not.toContain("fake-secret-cl3");
});

test("real persistence does not mutate lend config/journal or expose credentials", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { claudeTokenPath, claudeTokenStatus, saveClaudeToken } = await import("../src/lib/lend-claude-token.js");
  const root = mkdtempSync(join(tmpdir(), "cl3-api-"));
  const file = claudeTokenPath({ CLAUDESTRA_STATE_DIR: root });
  const lend = join(root, "lend.json");
  const ledger = join(root, "ledger-events.jsonl");
  writeFileSync(lend, "{\"enabled\":false}");
  writeFileSync(ledger, "");
  try {
    const api = makeLendClaudeTokenApi({ status: () => claudeTokenStatus(file), save: (token) => saveClaudeToken(token, file) });
    const secret = "fake-secret-cl3";
    const r = await api(new Request("http://test", { method: "POST", body: JSON.stringify({ token: secret }) }), path, device(true));
    expect(r?.status).toBe(200);
    expect(await r?.text()).not.toContain(secret);
    const get = await api(new Request("http://test"), path, device(true));
    expect(await get?.json()).toEqual({ configured: true, savedAt: expect.any(String) });
    expect(readFileSync(lend, "utf8")).toBe("{\"enabled\":false}");
    expect(readFileSync(ledger, "utf8")).toBe("");
    expect(readdirSync(join(root, "lend-credentials"))).toEqual(["claude-token.json"]);
    expect((await api(new Request("http://test", { method: "DELETE" }), path, device(true)))?.status).toBe(200);
    expect(readFileSync(file, "utf8")).not.toContain(secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
