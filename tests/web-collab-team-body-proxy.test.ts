/** 团队正文只读代理（src/bridge/local-api/team-body.ts，TEAMVIS7）：person 凭据签名、先问能力位、错误归成固定 code。 */
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTeamBodyApi, resetTeamBodyCapabilityCache, teamBodyRead } from "../src/bridge/local-api/team-body.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { teamBodyDigest } from "../src/lib/shared-ledger-contract-team-body.js";

const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
};
const conn = { centerId: "fake-center", baseUrl: "http://127.0.0.1/", teamId: "fake-team", personId: "fake-member",
  instanceId: "fake-instance", bearer: "obviously-fake-credential" };
const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
const PATH = "/shared-ledger/team-body/features/feat-1/tasks/task-1";
const rec = (kind: "event" | "review" | "spec", sourceKey: string, text: string) =>
  ({ featureId: "feat-1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text) });
const read = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, teamId: "fake-team", projectId: "fake-project", featureId: "feat-1",
  taskId: "task-1", records: [rec("event", "3", "交付 PR"), rec("spec", "2", "# 规格")], syncedAt: 1_700_000_000_000, homeOnline: true, ...over });
const err = (code: string, status: number) => Response.json({ schemaVersion: 1, code, status, message: "fake" }, { status });

let dir = "";
afterEach(() => { resetTeamBodyCapabilityCache(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

async function setup(answer: (path: string) => Response) {
  dir = mkdtempSync(join(tmpdir(), "team-body-proxy-"));
  await writeSharedLedgerCredential({ ...conn, localSubject: "owner:self", kind: "person", projects: [{ projectId: "fake-project", actions: ["read"] }] }, dir);
  const calls: { path: string; method: string; auth: string }[] = [];
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init!.method!, auth: (init!.headers as Record<string, string>).authorization });
    return answer(path);
  }) as typeof fetch;
  const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: key(), fetch: fetcher };
  const get = (path = PATH, init: RequestInit = {}) => teamBodyRead(new Request(`https://fake.invalid/api/v1${path}`, init), path, principal, deps);
  return { calls, get };
}
const capability = (on: boolean) => Response.json({ schemaVersion: 1, teamId: "fake-team", teamBody: on });

test("读正文：先问能力位再读，person 凭据签名，契约原样回给网页；能力位缓存", async () => {
  const { calls, get } = await setup((p) => (p.endsWith("/capability") ? capability(true) : Response.json(read())));
  const res = (await get())!;
  expect(res.status).toBe(200);
  expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(2);
  expect(calls.map((c) => c.path)).toEqual(["/v1/teams/fake-team/team-body/capability", "/v1/teams/fake-team/team-body/features/feat-1/tasks/task-1"]);
  expect(calls.every((c) => c.method === "GET" && c.auth === `Bearer ${conn.bearer}`)).toBe(true);
  await get();
  expect(calls.filter((c) => c.path.endsWith("/capability"))).toHaveLength(1);
});

test("中心没能力位（404 / teamBody false）→ 404 unsupported，不发读请求", async () => {
  for (const cap of [() => new Response("nf", { status: 404 }), () => capability(false)]) {
    resetTeamBodyCapabilityCache();
    const { calls, get } = await setup((p) => (p.endsWith("/capability") ? cap() : Response.json(read())));
    const res = (await get())!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "unsupported" });
    expect(calls.some((c) => c.path.includes("/tasks/"))).toBe(false);
    rmSync(dir, { recursive: true, force: true }); dir = "";
  }
});

test("中心 403 not_member / 409 not_open / 429 / 5xx 归成固定形状，不带中心原文", async () => {
  const cases: [() => Response, number, Record<string, unknown>][] = [
    [() => err("not_member", 403), 403, { code: "not_member" }],
    [() => new Response("<html>proxy 403</html>", { status: 403 }), 403, { code: "not_member" }],
    [() => err("not_open", 409), 409, { code: "not_open" }],
    [() => new Response("slow", { status: 429, headers: { "retry-after": "7" } }), 429, { code: "rate_limited", retryAfter: 7 }],
    [() => err("home_offline", 503), 503, { code: "unavailable" }],
  ];
  for (const [answer, status, body] of cases) {
    resetTeamBodyCapabilityCache();
    const { get } = await setup((p) => (p.endsWith("/capability") ? capability(true) : answer()));
    const res = (await get())!;
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    rmSync(dir, { recursive: true, force: true }); dir = "";
  }
});

test("中心回的不是这张卡 / 这个项目 → 403；非 GET、查询串、别的路径不代理", async () => {
  const { calls, get } = await setup((p) => (p.endsWith("/capability") ? capability(true) : Response.json(read({ projectId: "other-project" }))));
  expect((await get())!.status).toBe(403);
  const n = calls.length;
  expect((await get(PATH, { method: "POST", body: "{}" }))!.status).toBe(400);
  expect((await teamBodyRead(new Request(`https://fake.invalid/api/v1${PATH}?x=1`), PATH, principal, {} as never))!.status).toBe(400);
  expect((await get("/shared-ledger/team-body/features/../x"))!.status).toBe(400);
  expect(await get("/shared-ledger/features")).toBeNull();
  expect(handleTeamBodyApi(new Request("https://fake.invalid/api/v1/shared-ledger/features"), "/shared-ledger/features", principal)).toBeNull();
  expect(calls.length).toBe(n);
});

test("没有 person 凭据 / peer 调用方 → 403，不发请求", async () => {
  const { calls } = await setup(() => capability(true));
  const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: key() };
  const req = () => new Request(`https://fake.invalid/api/v1${PATH}`);
  expect((await teamBodyRead(req(), PATH, { ...principal, id: "fake-stranger" }, deps))!.status).toBe(403);
  expect((await teamBodyRead(req(), PATH, { ...principal, peer: "fake-peer" } as never, deps))!.status).toBe(403);
  expect(calls).toHaveLength(0);
});
