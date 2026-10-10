/** S2T 验收线 1–3：签名传输对 S2K `V2_ROUTES` 每项的线形状、错误映射，以及 X7 / X9 / X8 三个适配器对 S2C fake center 的往返。
 * 只用合成夹具（fake fetch、tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { v2ObjectDigest, V2ContractError, type V2Actor, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_ROUTE_BAD_IDS, V2_ROUTE_FIXTURES } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";
import { V2_ROUTE_NAMES, V2_ROUTES } from "../src/lib/shared-ledger-contract-v2-routes.js";
import { execOperationId } from "../src/lib/shared-ledger-exec-client.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import { ACTORS, EXEC_TASK, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const BEARER = "s2t-bearer-secret-0123456789";
const H = "b".repeat(40), D = "a".repeat(64);
const key = () => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const KEY = key();
type Fetch = NonNullable<Stage2Connection["fetch"]>;
function conn(actor: V2Actor, fetch: Fetch, extra: Partial<Stage2Connection> = {}): Stage2Connection {
  return { connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team", personId: actor.personId,
    instanceId: actor.instanceId, bearer: BEARER }, key: KEY, projectId: "project", fetch, ...extra };
}
interface Sent { method: string; path: string; body: string; headers: Headers }
/** Fake fetch: records each request and answers with `reply`. */
function recorder(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as Request, init), url = new URL(req.url);
    const s = { method: req.method, path: url.pathname + url.search, body: await req.text(), headers: req.headers };
    sent.push(s);
    return reply(s);
  }) as Fetch;
  return { sent, fetch };
}
/** Recomputes the V1 shared-ledger signature over method, raw path + query, body hash, nonce, instance and bearer hash. */
function signedBy(s: Sent, publicKey = KEY.publicKey): boolean {
  const h = SHARED_LEDGER_AUTH_HEADERS, get = (k: string) => s.headers.get(k) ?? "";
  return get(h.key) === publicKey && get("authorization") === `Bearer ${BEARER}` && verifyPurpose(get(h.key), "claudestra-shared-ledger-v1",
    [s.method, s.path, get(h.ts), sharedLedgerCredentialHash(s.body), get(h.nonce), get(h.instance), sharedLedgerCredentialHash(BEARER)], get(h.sig));
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof V2ContractError) return e.code; throw e; }
  return "resolved";
}
const routeParams = (params: Record<string, unknown>) => { const { teamId: _t, projectId: _p, ...rest } = params; return rest; };

describe("S2T 验收线 1：V2_ROUTES 每项的方法、路径、签名头、body，回包过 S2K parse", () => {
  for (const name of V2_ROUTE_NAMES) {
    const fx = V2_ROUTE_FIXTURES[name];
    test(`${name}：${V2_ROUTES[name].method} ${fx.path}`, async () => {
      const { sent, fetch } = recorder(() => Response.json(fx.response.valid));
      const t = createStage2Transport(conn(ACTORS.owner, fetch));
      const out = await t.call(name, routeParams(fx.params) as never, fx.request.valid);
      expect(out).toEqual(V2_ROUTES[name].parseResponse(structuredClone(fx.response.valid), fx.params as never) as never);
      expect(sent).toHaveLength(1);
      const s = sent[0]!;
      expect([s.method, s.path]).toEqual([V2_ROUTES[name].method, fx.path]);
      expect(signedBy(s)).toBe(true);
      expect(s.headers.get(SHARED_LEDGER_AUTH_HEADERS.instance)).toBe("local");
      if (s.method === "GET") expect(s.body).toBe("");
      else expect(JSON.parse(s.body)).toEqual(fx.request.valid as object);
      expect(s.body).not.toContain("actor");
      expect(s.body).not.toContain(BEARER);
    });
    test(`${name}：不合格回包一律 invalid_field`, async () => {
      for (const [label, bad] of [...Object.entries(fx.response.invalid), ["notJson", "<html>"]] as [string, unknown][]) {
        const { fetch } = recorder(() => label === "notJson" ? new Response("<html>", { status: 200 }) : Response.json(bad));
        const t = createStage2Transport(conn(ACTORS.owner, fetch));
        expect([label, await code(t.call(name, routeParams(fx.params) as never, fx.request.valid))]).toEqual([label, "invalid_field"]);
      }
    });
  }
  test("请求在发出前就过 S2K：带 actor / role、非法请求体、含 / 或 .. 的 id、改 scope 都 0 次请求", async () => {
    const { sent, fetch } = recorder(() => Response.json({}));
    const t = createStage2Transport(conn(ACTORS.owner, fetch));
    const command = V2_ROUTE_FIXTURES.commands.request.valid as Record<string, unknown>;
    expect(await code(t.call("commands", {}, { ...command, actor: ACTORS.owner }))).toBe("invalid_field");
    expect(await code(t.call("commands", {}, { ...command, role: "owner" }))).toBe("invalid_field");
    expect(await code(t.call("reverts", {}, V2_ROUTE_FIXTURES.reverts.request.invalid.carriesActor))).toBe("invalid_field");
    expect(await code(t.call("asks", { askId: "ask" }, {}))).toBe("invalid_field");
    for (const bad of V2_ROUTE_BAD_IDS) expect(await code(t.snapshot(bad))).toBe("invalid_field");
    expect(await code(t.call("features", { featureId: "feature", projectId: "project-other" } as never))).toBe("forbidden");
    expect(await code(t.scheduler.command({ ...command, projectId: "project-other" } as never))).toBe("forbidden");
    expect(sent).toHaveLength(0);
  });
});

describe("S2T 验收线 2：unavailable / 4xx 原样 / receipts 的 null", () => {
  const fx = V2_ROUTE_FIXTURES.features;
  const snapshot = (reply: (s: Sent) => Response | Promise<Response>, extra: Partial<Stage2Connection> = {}) =>
    code(createStage2Transport(conn(ACTORS.owner, recorder(reply).fetch, extra)).snapshot("feature"));
  test("fetch reject、超时、5xx、429 → unavailable；错误里不留凭据", async () => {
    const leaky = createStage2Transport(conn(ACTORS.owner, (async () => { throw new Error(`boom ${BEARER}`); }) as unknown as Fetch));
    const error = await leaky.snapshot("feature").catch(e => e);
    expect(error).toBeInstanceOf(V2ContractError);
    expect([error.code, String(error.message)]).toEqual(["unavailable", "unavailable"]);
    const hang: Fetch = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as Fetch;
    expect(await code(createStage2Transport(conn(ACTORS.owner, hang, { timeoutMs: 10 })).snapshot("feature"))).toBe("unavailable");
    expect(await snapshot(() => Response.json({ code: "unavailable", message: "", requestId: null }, { status: 503 }))).toBe("unavailable");
    expect(await snapshot(() => new Response("bad gateway", { status: 502 }))).toBe("unavailable");
    expect(await snapshot(() => new Response("", { status: 429, headers: { "retry-after": "1" } }))).toBe("unavailable");
    const torn = () => new Response(new ReadableStream({ start(c) { c.error(new Error(BEARER)); } }), { status: 200 });
    expect(await snapshot(torn)).toBe("unavailable");
    const tornReject = () => new Response(new ReadableStream({ start(c) { c.error(new Error(BEARER)); } }), { status: 409 });
    expect(await snapshot(tornReject)).toBe("unavailable");
    const abortedBody = (_: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(c) {
      init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    } }), { status: 409 });
    expect(await code(createStage2Transport(conn(ACTORS.owner, abortedBody as unknown as Fetch, { timeoutMs: 10 })).snapshot("feature")))
      .toBe("unavailable");
  });
  test("超限 2xx 回包 → invalid_field（不是 payload_too_large）", async () => {
    expect(await snapshot(() => Response.json({ padding: "x".repeat(16777217) }))).toBe("invalid_field");
  });
  test("403 → forbidden（体缺失 / 体不合格 / code 与状态不符都是 forbidden），其余 4xx 原样带回 code", async () => {
    const err = (code: string, status: number) => () => Response.json({ code, message: "", requestId: null }, { status });
    expect(await snapshot(err("forbidden", 403))).toBe("forbidden");
    expect(await snapshot(() => new Response("<html>", { status: 403 }))).toBe("forbidden");
    expect(await snapshot(err("conflict", 403))).toBe("forbidden");
    expect(await snapshot(err("execution_not_shared", 403))).toBe("execution_not_shared");
    expect(await snapshot(err("not_member", 403))).toBe("not_member");
    expect(await snapshot(err("stale_epoch", 409))).toBe("stale_epoch");
    expect(await snapshot(err("dedup_mismatch", 409))).toBe("dedup_mismatch");
    expect(await snapshot(err("bad_signature", 401))).toBe("bad_signature");
    expect(await snapshot(err("not_found", 404))).toBe("not_found");
    expect(await snapshot(() => new Response("", { status: 418 }))).toBe("invalid_field");
    expect(fx.path).toContain("/features/feature");
  });
  test("receipts：契约里的 status unknown 才是 null；404 不映射为 null", async () => {
    const r = V2_ROUTE_FIXTURES.receipts, q = { teamId: "team", projectId: "project", requestId: "request", operationId: "operation", commandDigest: D };
    const unknown = { teamId: "team", projectId: "project", requestId: "request", status: "unknown", receipt: null };
    const exec = (reply: () => Response) => createStage2Transport(conn(ACTORS.owner, recorder(reply).fetch)).exec;
    expect(await exec(() => Response.json(unknown)).receipt(q, ACTORS.owner)).toBeNull();
    expect(await exec(() => Response.json(r.response.valid)).receipt(q, ACTORS.owner))
      .toEqual((r.response.valid as { receipt: unknown }).receipt);
    expect(await code(exec(() => Response.json({ code: "not_found", message: "", requestId: null }, { status: 404 })).receipt(q, ACTORS.owner)))
      .toBe("not_found");
    expect(await code(exec(() => new Response("", { status: 404 })).receipt(q, ACTORS.owner))).toBe("not_found");
  });
  test("适配器只用签名身份：actor 与凭据不符 → unauthenticated，项目不在 actor 范围 → forbidden，均 0 次请求", async () => {
    const { sent, fetch } = recorder(() => Response.json({}));
    const t = createStage2Transport(conn(ACTORS.owner, fetch)), q = { teamId: "team", projectId: "project", askId: "ask" };
    expect(await code(t.exec.ask(q, ACTORS.member))).toBe("unauthenticated");
    expect(await code(t.exec.ask(q, { ...ACTORS.owner, personId: "member" }))).toBe("unauthenticated");
    expect(await code(t.exec.ask(q, { ...ACTORS.owner, projects: ["project-other"] }))).toBe("forbidden");
    expect(await code(t.exec.ask({ ...q, projectId: "project-other" }, ACTORS.owner))).toBe("forbidden");
    expect(sent).toHaveLength(0);
  });
});

/** S2C fake center behind a signature check: identity comes only from a valid V1 signature + the instance header. */
function centerFetch(k: ReturnType<typeof kit>, keys: Record<string, string>): Fetch {
  const byInstance = Object.fromEntries(Object.values(ACTORS).map(a => [a.instanceId, a]));
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as Request, init), url = new URL(req.url), body = await req.clone().text();
    const instance = req.headers.get(SHARED_LEDGER_AUTH_HEADERS.instance) ?? "";
    const ok = signedBy({ method: req.method, path: url.pathname + url.search, body, headers: req.headers }, keys[instance]);
    return k.center.fetch(() => ok ? byInstance[instance] ?? null : null)(req);
  }) as Fetch;
}

describe("S2T 验收线 3：三个适配器各对 S2C fake center 跑通一条命令往返", () => {
  const owner = { ...KEY }, peerA = key(), peerB = key();
  const keys = { local: owner.publicKey, "peer-a": peerA.publicKey, "peer-b": peerB.publicKey };
  const transport = (k: ReturnType<typeof kit>, actor: V2Actor, signing: typeof KEY) =>
    createStage2Transport({ ...conn(actor, centerFetch(k, keys)), key: signing });
  const leaseAndOrder = (k: ReturnType<typeof kit>) => {
    expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" })).status).toBe(200);
  };

  test("X7 ExecTransport：成员 task.set — 回执 null → submit → 回执命中；丢响应 = unavailable 且回执可查", async () => {
    const k = kit(), t = transport(k, ACTORS.member, peerA);
    const set = k.command("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title: "经传输改名" } });
    const q = { teamId: "team", projectId: "project", requestId: set.requestId, operationId: execOperationId(set), commandDigest: v2ObjectDigest(set) };
    expect(await t.exec.receipt(q, ACTORS.member)).toBeNull();
    const receipt = await t.exec.submit(set, ACTORS.member) as { requestId: string; personId: string; command: string };
    expect([receipt.requestId, receipt.personId, receipt.command]).toEqual([set.requestId, "member", "task.set"]);
    expect(await t.exec.receipt(q, ACTORS.member)).toEqual(receipt);
    expect(await t.exec.submit(set, ACTORS.member)).toEqual(receipt);
    expect((await t.snapshot("feature-exec")).tasks[0]).toMatchObject({ id: "task-exec", title: "经传输改名" });
    expect(await t.exec.ask({ teamId: "team", projectId: "project", askId: "ask-exec" }, ACTORS.member)).toMatchObject({ id: "ask-exec" });

    k.center.inject({ kind: "drop", command: "task.set" });
    const again = k.command("task.set", { taskId: "task-exec", expectedRev: 2, expectedSpecRev: 1, patch: { title: "丢响应" } });
    expect(await code(t.exec.submit(again, ACTORS.member))).toBe("unavailable");
    const lost = await t.exec.receipt({ ...q, requestId: again.requestId, commandDigest: v2ObjectDigest(again) }, ACTORS.member);
    expect(lost).toMatchObject({ requestId: again.requestId, command: "task.set" });
    // A forged key under the same instance header is unauthenticated at the center.
    expect(await code(transport(k, ACTORS.member, key()).snapshot("feature-exec"))).toBe("unauthenticated");
  });

  test("X8 SchedulerCentralClient：主场 intent.check 一次往返，回执带本实例与 operationId", async () => {
    const k = kit(), t = transport(k, ACTORS.owner, owner);
    leaseAndOrder(k);
    const created = k.post(ACTORS.owner, k.command("intent.create", { ...EXEC_TASK, action: "dispatch", node: "write", operationId: "op-1",
      head: H, round: 0, dependencyDigest: D, authorizationAskId: null, authorizationDigest: null,
      resources: [{ teamId: "team", projectId: "project", repository: "team/repository", kind: "file", path: "src/example.ts" }] }));
    const intentId = (created.body as { result: { entityId: string } }).result.entityId;
    const check = k.command("intent.check", { ...EXEC_TASK, intentId, operationId: "op-1", authorizationAskId: null, authorizationDigest: null });
    const receipt = await t.scheduler.command(check as never) as { command: string; instanceId: string; result: { operationId: string } };
    expect([receipt.command, receipt.instanceId, receipt.result.operationId]).toEqual(["intent.check", "local", "op-1"]);
    expect((await t.snapshot("feature-exec")).intents).toMatchObject([{ id: intentId, status: "submitted" }]);
    const wrong = transport(k, ACTORS.member, peerA);
    const recheck = k.command("intent.check", { ...EXEC_TASK, intentId, operationId: "op-1", authorizationAskId: null, authorizationDigest: null });
    expect(await code(wrong.scheduler.command(recheck as never))).toBe("wrong_home");
  });

  test("X9 LendCentralTransport：执行方 lend.claim — 回执 null → view → command → 回执命中", async () => {
    const k = kit(), t = transport(k, ACTORS.executor, peerB);
    leaseAndOrder(k);
    const created = k.post(ACTORS.owner, k.command("lend.create", { ...EXEC_TASK, featureId: "feature-exec", family: "codex", step: "review",
      executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0, branch: null, base: null, grantId: "grant", grantDigest: D }));
    const orderId = (created.body as { result: { entityId: string } }).result.entityId;
    const claim = k.command("lend.claim", { claim: { teamId: "team", projectId: "project", orderId, taskId: "task-exec", specRev: 1, round: 0,
      head: H, leaseGen: 1, serviceGeneration: 1, epoch: 1, bootId: "boot-local", executorInstanceId: "peer-b",
      worker: { kind: "peer_agent", instanceId: "peer-b", agentId: "worker" }, grantId: "grant", grantDigest: D, claimedAt: 10_000 } });
    const journal = new Map<string, V2Command>([[claim.requestId, claim]]);
    const lend = t.lend(id => journal.get(id) ?? null);
    expect(await lend.receipt(claim.requestId)).toBeNull();
    expect((await lend.view(orderId)).order).toMatchObject({ orderId, status: "pooled", leaseGen: 0 });
    const receipt = await lend.command(claim);
    expect(receipt).toMatchObject({ requestId: claim.requestId, command: "lend.claim", instanceId: "peer-b" });
    expect(await lend.receipt(claim.requestId)).toEqual(receipt);
    expect(await lend.view(orderId)).toMatchObject({ order: { status: "claimed", leaseGen: 1 }, lease: { leaseGen: 1 } });
    expect(await code(lend.receipt("request-not-journaled"))).toBe("unknown_operation");
    journal.set("request-other", claim);
    expect(await code(lend.receipt("request-other"))).toBe("dedup_mismatch");
  });
});
