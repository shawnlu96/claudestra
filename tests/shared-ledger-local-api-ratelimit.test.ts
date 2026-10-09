/**
 * team-project-N8A8: center rate limiting (nginx limit_req → 429 + Retry-After) reaches the page as 429 with the same
 * Retry-After header and body.retryAfter (the web api client only exposes status + JSON body). Other statuses are unchanged.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSharedLedgerApi } from "../src/bridge/local-api/shared-ledger.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { fakeKey, fakeConnection } from "./shared-ledger-client.test.js";

async function withCenter(answer: () => Response, run: (get: (resource: string) => Promise<Response>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-ratelimit-"));
  try {
    await writeSharedLedgerCredential({ ...fakeConnection, localSubject: "owner:self", kind: "person",
      projects: [{ projectId: "fake-project", actions: ["read"] }] }, dir);
    const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: fakeKey(),
      fetch: (async () => answer()) as unknown as typeof fetch, scrub: { identity: { username: "fake-user", hostname: "fake-host" } } };
    const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
    await run(async (resource) => (await handleSharedLedgerApi(
      new Request(`https://fake.invalid/api/v1/shared-ledger/${resource}`), `/shared-ledger/${resource}`, principal, deps))!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("N8A8 center 429 + Retry-After on a feature detail → page gets 429 with the same Retry-After (header and body.retryAfter)", async () => {
  const nginx = () => new Response("<html>429 Too Many Requests</html>", { status: 429, headers: { "Retry-After": "7", "content-type": "text/html" } });
  await withCenter(nginx, async (get) => {
    for (const resource of ["features/feature-1", "features"]) {
      const res = await get(resource);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("7");
      expect(((await res.json()) as { retryAfter?: unknown }).retryAfter).toBe(7);
    }
  });
});

test("N8A8 429 without Retry-After stays 429 with no header; other statuses pass through unchanged without Retry-After", async () => {
  await withCenter(() => Response.json({ error: "slow down" }, { status: 429 }), async (get) => {
    const res = await get("features/feature-1");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(((await res.json()) as { retryAfter?: unknown }).retryAfter).toBeUndefined();
  });
  await withCenter(() => Response.json({ code: "not_found" }, { status: 404, headers: { "Retry-After": "7" } }), async (get) => {
    const res = await get("features/feature-1");
    expect(res.status).toBe(404);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
