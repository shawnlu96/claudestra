/**
 * CBUDGET2: the bridge merges page reads of the center feature list / detail. Same credential subject + resource within
 * 10 seconds goes out once; concurrent callers share one in-flight read; a center 429 answers the same key with 429 +
 * Retry-After without going out until it passes; a successful write by the same subject drops its cached list.
 */
import { afterEach, expect, test } from "bun:test";
import type { Principal } from "../src/lib/principals.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSharedLedgerApi } from "../src/bridge/local-api/shared-ledger.js";
import { clearSharedLedgerReadCache, sharedLedgerReadClock } from "../src/bridge/local-api/shared-ledger-read-cache.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import {
  SHARED_LEDGER_COMMAND_FIXTURES, SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_LIST_FIXTURE, SHARED_LEDGER_RESULT_FIXTURE,
} from "../src/lib/shared-ledger-contract-fixtures.js";
import { fakeConnection, fakeKey } from "./shared-ledger-client.test.js";

const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "fake-date" } as Principal;
const guest = { ...owner, id: "guest:other", role: "external" } as Principal;
const realNow = sharedLedgerReadClock.now;
afterEach(() => { sharedLedgerReadClock.now = realNow; clearSharedLedgerReadCache(); });

type Answer = (method: string, resource: string) => Response | Promise<Response>;
const ok: Answer = (method, resource) => {
  if (resource === "features") return Response.json(SHARED_LEDGER_LIST_FIXTURE);
  if (resource === "features/feature-a") return Response.json(SHARED_LEDGER_FEATURE_FIXTURE);
  if (method === "GET" && resource.startsWith("commands/")) return Response.json({ status: "unknown", requestId: resource.slice(9) });
  if (method === "POST" && resource === "commands") return Response.json(SHARED_LEDGER_RESULT_FIXTURE);
  return Response.json({ error: "not found" }, { status: 404 });
};

async function withCenter(run: (w: {
  get: (resource: string, principal?: typeof owner) => Promise<Response>;
  post: (resource: string, body: unknown) => Promise<Response>;
  hits: string[]; answer: (a: Answer) => void; advance: (ms: number) => void;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-read-cache-"));
  let t = 1_000_000, answer = ok;
  sharedLedgerReadClock.now = () => t;
  const hits: string[] = [];
  try {
    const base = { ...fakeConnection, teamId: "team-a", kind: "person" as const };
    await writeSharedLedgerCredential({ ...base, localSubject: owner.id, projects: [{ projectId: "project-a", actions: ["read", "plan"] }] }, dir);
    await writeSharedLedgerCredential({ ...base, localSubject: guest.id, projects: [{ projectId: "project-a", actions: ["read"] }] }, dir);
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET", resource = new URL(String(input)).pathname.replace(/^\/v1\/teams\/team-a\//, "");
      hits.push(`${method} ${resource}`);
      await Bun.sleep(1); // in flight across callers
      return answer(method, resource);
    }) as unknown as typeof fetch;
    const deps = { stateDir: dir, centerId: "fake-center", teamId: "team-a", projectId: "project-a", key: fakeKey(), fetch: fetcher,
      scrub: { identity: { username: "fake-user", hostname: "fake-host" } } };
    const call = (req: Request, resource: string, principal = owner) =>
      handleSharedLedgerApi(req, `/shared-ledger/${resource}`, principal, deps).then((r) => r!);
    await run({
      get: (resource, principal = owner) => call(new Request(`https://fake.invalid/api/v1/shared-ledger/${resource}`), resource, principal),
      post: (resource, body) => call(new Request(`https://fake.invalid/api/v1/shared-ledger/${resource}`,
        { method: "POST", body: JSON.stringify(body) }), resource),
      hits, answer: (a) => { answer = a; }, advance: (ms) => { t += ms; },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const lists = (hits: string[]) => hits.filter((h) => h === "GET features").length;

test("[验收线 1] same credential reads features 5 times within 10s → center sees 1; the 11th second goes out once", async () => {
  await withCenter(async ({ get, hits, advance }) => {
    for (let i = 0; i < 5; i++) {
      const res = await get("features");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { features: unknown[] }).features).toHaveLength(1);
      advance(2_000);
    }
    expect(lists(hits)).toBe(1);
    advance(1_000); // 11s after the first read
    expect((await get("features")).status).toBe(200);
    expect(lists(hits)).toBe(2);
  });
});

test("[验收线 1] 5 concurrent reads of one feature detail → center sees 1, all get the detail", async () => {
  await withCenter(async ({ get, hits }) => {
    const all = await Promise.all(Array.from({ length: 5 }, () => get("features/feature-a")));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of all) expect(((await r.json()) as { feature: { id: string } }).feature.id).toBe("feature-a");
    expect(hits).toEqual(["GET features/feature-a"]);
  });
});

test("[验收线 1] different credential subjects never share a cached read", async () => {
  await withCenter(async ({ get, hits }) => {
    await get("features");
    await get("features", guest);
    await get("features");
    await get("features", guest);
    expect(lists(hits)).toBe(2);
  });
});

test("[验收线 2] center 429 (Retry-After: 20) → same key answers 429 + Retry-After for 20s without going out, then recovers", async () => {
  await withCenter(async ({ get, hits, answer, advance }) => {
    answer(() => new Response("<html>429</html>", { status: 429, headers: { "Retry-After": "20" } }));
    const first = await get("features/feature-a");
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("20");
    answer(ok);
    for (const step of [1_000, 9_000, 9_999]) {
      advance(step);
      const res = await get("features/feature-a");
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(((await res.json()) as { retryAfter?: unknown }).retryAfter).toBe(Number(res.headers.get("retry-after")));
    }
    expect(hits).toEqual(["GET features/feature-a"]);
    // another key is not blocked by this one
    expect((await get("features")).status).toBe(200);
    advance(1); // 20s after the 429
    expect((await get("features/feature-a")).status).toBe(200);
    expect(hits).toEqual(["GET features/feature-a", "GET features", "GET features/feature-a"]);
  });
});

test("[验收线 2] concurrent callers of a 429 all get the center's Retry-After; no Retry-After blocks 5s", async () => {
  await withCenter(async ({ get, hits, answer }) => {
    answer(() => new Response("slow", { status: 429, headers: { "Retry-After": "20" } }));
    const all = await Promise.all(Array.from({ length: 3 }, () => get("features")));
    expect(all.map((r) => [r.status, r.headers.get("retry-after")])).toEqual([[429, "20"], [429, "20"], [429, "20"]]);
    expect(lists(hits)).toBe(1);
  });
  await withCenter(async ({ get, hits, answer, advance }) => {
    answer(() => Response.json({ error: "slow down" }, { status: 429 }));
    const first = await get("features");
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBeNull();
    answer(ok);
    advance(4_999);
    const held = await get("features");
    expect([held.status, held.headers.get("retry-after")]).toEqual([429, "1"]);
    advance(1);
    expect((await get("features")).status).toBe(200);
    expect(lists(hits)).toBe(2);
  });
});

test("only 200 is cached: a 404 / 5xx read goes out again on the next call", async () => {
  await withCenter(async ({ get, hits, answer }) => {
    answer(() => Response.json({ error: "boom" }, { status: 500 }));
    expect((await get("features")).status).not.toBe(200);
    answer(ok);
    expect((await get("features")).status).toBe(200);
    expect(lists(hits)).toBeGreaterThanOrEqual(2);
  });
});

test("[验收线 3] a successful POST commands by the same credential → the next GET features goes out", async () => {
  await withCenter(async ({ get, post, hits }) => {
    await get("features");
    await get("features");
    expect(lists(hits)).toBe(1);
    const res = await post("commands", SHARED_LEDGER_COMMAND_FIXTURES[3]!.payload);
    expect(res.status).toBe(200);
    expect(hits).toContain("POST commands");
    await get("features");
    expect(lists(hits)).toBe(2);
  });
});
