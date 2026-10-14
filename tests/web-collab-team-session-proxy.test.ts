/** 团队会话页代理（src/bridge/local-api/team-body-session.ts，TEAMVIS8）：登记取页 / 按 requestId 读页，person 凭据签名，错误归成固定 code。 */
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTeamBodyCapabilityCache, teamBodyRead } from "../src/bridge/local-api/team-body.js";
import { teamBodySessionPage, type TeamBodyGate } from "../src/bridge/local-api/team-body-session.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { teamBodyDigest } from "../src/lib/shared-ledger-contract-team-body.js";

const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
};
const conn = { centerId: "fake-center", baseUrl: "http://127.0.0.1/", teamId: "fake-team", personId: "fake-member",
  instanceId: "fake-instance", bearer: "obviously-fake-credential" };
const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
const ROOT = "/shared-ledger/team-body/features/feat-1/tasks/task-1/session-pages";
const CENTER = "/v1/teams/fake-team/team-body";
const rec = (sourceKey: string, text: string, over: Record<string, unknown> = {}) =>
  ({ featureId: "feat-1", taskId: "task-1", kind: "session-page", sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text), ...over });
const ready = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, requestId: "req-1", status: "ready", expiresAt: 1_700_000_600_000, homeOnline: true,
  result: { kind: "page", records: [rec("sess-1:4", "[用户]\n先写测试"), rec("sess-1:5", "[助手]\n好的\n[工具]\nBash: bun test")], nextCursor: "v1:sess-1:4" }, ...over });
const err = (code: string, status: number) => Response.json({ schemaVersion: 1, code, status, message: "fake" }, { status });
const capability = (on: boolean) => Response.json({ schemaVersion: 1, teamId: "fake-team", teamBody: on });

let dir = "";
afterEach(() => { resetTeamBodyCapabilityCache(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

async function setup(answer: (path: string, method: string) => Response) {
  resetTeamBodyCapabilityCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "team-session-proxy-"));
  await writeSharedLedgerCredential({ ...conn, localSubject: "owner:self", kind: "person", projects: [{ projectId: "fake-project", actions: ["read"] }] }, dir);
  const calls: { path: string; method: string; auth: string; body: unknown }[] = [];
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init!.method!, auth: (init!.headers as Record<string, string>).authorization!, body: init!.body ? JSON.parse(String(init!.body)) : null });
    return path.endsWith("/capability") ? capability(true) : answer(path, init!.method!);
  }) as typeof fetch;
  const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: key(), fetch: fetcher };
  // 能力位：真的走 team-body.ts 的缓存太绕（它不导出），这里按同一条中心路径问一次
  const gate: TeamBodyGate = {
    supported: async () => {
      const res = await fetcher(`http://127.0.0.1${CENTER}/capability`, { method: "GET", headers: { authorization: `Bearer ${conn.bearer}` } });
      return ((await res.json()) as { teamBody: boolean }).teamBody;
    },
    rejection: async (status, response) => { try { return { code: ((await response.json()) as { code?: unknown; status?: unknown }).code }; } catch { return { code: null, status }; } },
  };
  const call = (path: string, init: RequestInit = {}, who: typeof principal = principal) =>
    teamBodySessionPage(new Request(`https://fake.invalid/api/v1${path}`, init), path, who, deps, gate);
  const post = (body: unknown = { cursor: null }, path = ROOT) => call(path, { method: "POST", body: JSON.stringify(body) });
  return { calls, call, post, deps };
}

test("登记取页：POST 带本绑定的项目和这张卡，回 requestId / expiresAt；轮询 GET 原样回这张卡的页", async () => {
  const { calls, post, call } = await setup((path, method) => method === "POST"
    ? Response.json({ schemaVersion: 1, requestId: "req-1", expiresAt: 1_700_000_600_000 }) : Response.json(ready()));
  const ticket = (await post({ cursor: "v1:sess-1:9", limit: 20 }))!;
  expect(ticket.status).toBe(200);
  expect(await ticket.json()).toEqual({ requestId: "req-1", expiresAt: 1_700_000_600_000 });
  const sent = calls.find((c) => c.method === "POST")!;
  expect(sent.path).toBe(`${CENTER}/session-pages`);
  expect(sent.auth).toBe(`Bearer ${conn.bearer}`);
  expect((sent.body as { payload: unknown }).payload).toEqual({ schemaVersion: 1, projectId: "fake-project", featureId: "feat-1", taskId: "task-1", cursor: "v1:sess-1:9", limit: 20 });

  const page = (await call(`${ROOT}/req-1`))!;
  expect(page.status).toBe(200);
  const body = (await page.json()) as { status: string; homeOnline: boolean; result: { records: { sourceKey: string }[]; nextCursor: string } };
  expect(body.status).toBe("ready");
  expect(body.result.records.map((r) => r.sourceKey)).toEqual(["sess-1:4", "sess-1:5"]);
  expect(body.result.nextCursor).toBe("v1:sess-1:4");
  expect(calls.at(-1)!.path).toBe(`${CENTER}/session-pages/req-1`);
  // 一次登记只发一个 POST：轮询不重发
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("主场还没回传 → pending；主场回的拒绝（not_open / gate_refused）随页结果带回", async () => {
  const pending = await setup(() => Response.json(ready({ status: "pending", result: null, homeOnline: false })));
  expect(await (await pending.call(`${ROOT}/req-1`))!.json()).toEqual({ requestId: "req-1", status: "pending", expiresAt: 1_700_000_600_000, homeOnline: false, result: null });
  const refused = await setup(() => Response.json(ready({ result: { kind: "refused", code: "not_open" } })));
  expect(((await (await refused.call(`${ROOT}/req-1`))!.json()) as { result: unknown }).result).toEqual({ kind: "refused", code: "not_open" });
});

test("中心的拒绝归成固定 code：403 / 409 / 410 / 503 home_offline / 429 / 其他 5xx，不带中心原文", async () => {
  const cases: [() => Response, number, Record<string, unknown>][] = [
    [() => err("not_member", 403), 403, { code: "not_member" }],
    [() => err("gate_refused", 403), 403, { code: "gate_refused" }],
    [() => new Response("<html>proxy 403</html>", { status: 403 }), 403, { code: "not_member" }],
    [() => err("not_open", 409), 409, { code: "not_open" }],
    [() => err("expired", 410), 410, { code: "expired" }],
    [() => err("home_offline", 503), 503, { code: "home_offline" }],
    [() => new Response("<html>bad gateway</html>", { status: 503 }), 503, { code: "unavailable" }],
    [() => new Response("slow", { status: 429, headers: { "retry-after": "7" } }), 429, { code: "rate_limited", retryAfter: 7 }],
  ];
  for (const [answer, status, body] of cases) {
    for (const polling of [false, true]) {
      const { post, call } = await setup(answer);
      const res = (polling ? await call(`${ROOT}/req-1`) : await post())!;
      expect({ polling, status: res.status, body: await res.json() }).toEqual({ polling, status, body });
    }
  }
  // 能力位问过了中心还 404：登记时是取页口没开，轮询时是这个请求中心已经不认得（过期）
  const gone = await setup(() => new Response("nf", { status: 404 }));
  expect(await (await gone.post())!.json()).toEqual({ code: "unsupported" });
  expect((await gone.call(`${ROOT}/req-1`))!.status).toBe(410);
});

test("回来的不是这张卡 / 这个请求的页 → 403；契约外的形状 → 503", async () => {
  const other = await setup(() => Response.json(ready({ result: { kind: "page", records: [rec("sess-1:4", "[用户]\nx", { taskId: "task-2" })], nextCursor: null } })));
  expect((await other.call(`${ROOT}/req-1`))!.status).toBe(403);
  const swapped = await setup(() => Response.json(ready({ requestId: "req-2" })));
  expect((await swapped.call(`${ROOT}/req-1`))!.status).toBe(403);
  const event = await setup(() => Response.json(ready({ result: { kind: "page", records: [rec("4", "x", { kind: "event" })], nextCursor: null } })));
  expect((await event.call(`${ROOT}/req-1`))!.status).toBe(503);
  const digest = await setup(() => Response.json(ready({ result: { kind: "page", records: [rec("sess-1:4", "x", { digest: "0".repeat(64) })], nextCursor: null } })));
  expect((await digest.call(`${ROOT}/req-1`))!.status).toBe(503);
});

test("只认这两条路由：方法不对、查询串、多余的键、坏 cursor / limit → 400，不发请求；没有凭据 / peer → 403", async () => {
  const { calls, call, post, deps } = await setup(() => Response.json(ready()));
  const bad: (Response | null)[] = [
    await call(ROOT),
    await call(`${ROOT}/req-1`, { method: "POST", body: "{}" }),
    await teamBodySessionPage(new Request(`https://fake.invalid/api/v1${ROOT}?x=1`, { method: "POST", body: "{}" }), ROOT, principal, deps,
      { supported: async () => true, rejection: async () => null }),
    await call(`${ROOT}/req-1/extra`),
    await post({ cursor: null, text: "hello" }),
    await post({ cursor: 7 }),
    await post({ cursor: null, limit: 201 }),
    await post({ cursor: "" }),
    await call(ROOT, { method: "POST", body: "not json" }),
  ];
  expect(bad.map((r) => r!.status)).toEqual(bad.map(() => 400));
  expect(await call("/shared-ledger/team-body/features/feat-1/tasks/task-1")).toBeNull();
  const gate: TeamBodyGate = { supported: async () => true, rejection: async () => null };
  const as = (who: unknown) => teamBodySessionPage(new Request(`https://fake.invalid/api/v1${ROOT}/req-1`), `${ROOT}/req-1`, who as never, deps, gate);
  expect((await as({ ...principal, id: "fake-stranger" }))!.status).toBe(403);
  expect((await as({ ...principal, peer: "fake-peer" }))!.status).toBe(403);
  expect(calls).toHaveLength(0);
  // 原来的正文读口不受影响：同前缀下的 POST 仍是 400
  const PATH = "/shared-ledger/team-body/features/feat-1/tasks/task-1";
  expect((await teamBodyRead(new Request(`https://fake.invalid/api/v1${PATH}`, { method: "POST", body: "{}" }), PATH, principal, deps))!.status).toBe(400);
});
