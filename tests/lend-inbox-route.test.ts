/**
 * i28-W3 B 侧收单入口 POST /api/v1/lend/offer（src/bridge/local-api/lend-inbox.ts）：照 tests/lend-scope-route.test.ts（同 peer-e2e-relay 的搭法）
 * 在测试进程的 STATE_DIR 里放好 peer 记录、peer token、lend.json 与 journal，经真 serveApiRequest（真鉴权：验签 + 钉钥 + E2E 上下文）打这条路由，
 * 成功路径真起 `manager lend inbox` 子进程。非 peer、invite、非 E2E、没签名 → 401 且 CLI 一次都没起（journal 里没有行）；成功回包恰好四个字段。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initApiRoutes, serveApiRequest } from "../src/bridge/api-routes.ts";
import { ENV_WITH_BUN as BRIDGE_ENV } from "../src/bridge/config.ts";
import { handleLendInbox } from "../src/bridge/local-api/lend-inbox.ts";
import { setRequestContext } from "../src/bridge/request-context.ts";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.ts";
import { LEND_PATH } from "../src/lib/lend-config.ts";
import { TICK_KEY } from "../src/lib/lend-inbox.ts";
import { getOrder, LEND_JOURNAL_PATH, openLendJournal, setMeta } from "../src/lib/lend-journal.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { newTokenPrincipal, updatePrincipals, type Principal } from "../src/lib/principals.ts";

const PEER = "w3mate";
const STATE_FILES = ["registry.json", "peers.json", "principals.json", "peer-keys.json", LEND_PATH, LEND_JOURNAL_PATH];
const saved = new Map<string, string | null>();
const dirA = mkdtempSync(join(tmpdir(), "w3-peer-a-"));
const ENV_WITH_BUN = BRIDGE_ENV as Record<string, string | undefined>;
const runtimeBefore = ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR;
const keyA = instanceKeySync(dirA)!;
const FP = keyFingerprint(keyA.publicKey);
const HEAD = "e".repeat(40);
let peerSecret = "";
let webSecret = "";

const fileOf = (f: string) => (f.startsWith("/") ? f : join(STATE_DIR, f));
const summary = (orderId: string) => ({ orderId, taskId: "T93", step: "review", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
const offer = (...ids: string[]) => JSON.stringify({ v: 1, proto: 2, orders: ids.map(summary) });

beforeAll(async () => {
  ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR = join(dirA, "runtime");
  for (const f of STATE_FILES) saved.set(f, existsSync(fileOf(f)) ? readFileSync(fileOf(f), "utf8") : null);
  for (const f of ["peers.json", "principals.json", "peer-keys.json"]) rmSync(fileOf(f), { force: true });
  rmSync(LEND_JOURNAL_PATH, { force: true });
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: {} }));
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [{ name: PEER, baseUrl: "http://a.example", addedAt: new Date(0).toISOString(), fp: FP,
    outToken: "token-to-a", publicKey: keyA.publicKey, e2e: { idk: "i", ek: {} } }] }));
  const peer = newTokenPrincipal(PEER, [], { peer: PEER });
  const web = newTokenPrincipal("w3-frontend", ["*"]);
  peerSecret = peer.secret!;
  webSecret = web.secret!;
  await updatePrincipals((f) => (f.principals.push(peer, web), { changed: true, result: null }));
  const now = Date.now();
  writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ peer: PEER, fp: FP, families: { codex: 1 }, roles: ["review"],
    repos: ["shawnlu96/claudestra"], ordersPerDay: 5, grantedAt: new Date(now - 1000).toISOString(), until: new Date(now + 86_400_000).toISOString() }] }));
  const db = openLendJournal(LEND_JOURNAL_PATH);
  setMeta(db, TICK_KEY, String(now + 600_000)); // 调度服务「刚跑过」：整个用例期间都不算 lender_idle
  db.close();
  initApiRoutes({ clients: new Map(), deliver: async () => ({}), mirrorApiExchange: async () => {}, startTypingWithSafety: () => {}, lastMessageSource: new Map(),
    handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {} } as never);
});

afterAll(() => {
  if (runtimeBefore === undefined) delete ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR;
  else ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR = runtimeBefore;
  for (const [f, v] of saved) v === null ? rmSync(fileOf(f), { force: true }) : writeFileSync(fileOf(f), v);
  rmSync(dirA, { recursive: true, force: true });
});

interface Call { body: string; secret?: string; e2e?: boolean; sign?: boolean; method?: string }
async function call(c: Call): Promise<Response> {
  const path = "/api/v1/lend/offer";
  const method = c.method ?? "POST";
  const body = method === "POST" ? c.body : "";
  const headers: Record<string, string> = { Authorization: `Bearer ${c.secret ?? peerSecret}`, ...(c.sign === false ? {} : signedHeaders(method, path, body, keyA)) };
  if (method === "POST") headers["Content-Type"] = "application/json";
  const req = new Request(`http://b.local${path}`, { method, headers, ...(method === "POST" ? { body } : {}) });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false, ...(c.e2e === false ? {} : { e2e: { peerFp: FP } }) });
  return serveApiRequest(req, new URL(req.url));
}
const rowOf = (id: string) => {
  const db = openLendJournal(LEND_JOURNAL_PATH);
  try { return getOrder(db, id); } finally { db.close(); }
};

describe("POST /api/v1/lend/offer", () => {
  test("没签名、非 peer 的 token → 401；非 E2E / E2E 里用非 peer token 在 peer 闸就被拒（403），走到这条路由也是 401；CLI 一次都没起", async () => {
    for (const [c, id] of [[{ sign: false }, "x2"], [{ secret: webSecret, e2e: false }, "x3"]] as const) {
      expect((await call({ body: offer(id), ...c })).status).toBe(401);
      expect(rowOf(id)).toBeNull();
    }
    expect((await call({ body: offer("x1"), e2e: false })).status).toBe(403);
    expect((await call({ body: offer("x3"), secret: webSecret })).status).toBe(403); // E2E 会话里只收 peer token
    const plain = new Request("http://b.local/api/v1/lend/offer", { method: "POST", body: offer("x1"), headers: signedHeaders("POST", "/api/v1/lend/offer", offer("x1"), keyA) });
    setRequestContext(plain, { source: "loopback", clientIp: null, https: false });
    const peer = { id: "p", name: PEER, agents: [], peer: PEER } as unknown as Principal;
    expect((await handleLendInbox(plain, "/lend/offer", peer))!.status).toBe(401);
    expect(rowOf("x1")).toBeNull();
  }, 30_000);

  test("未兑换的邀请 token（invite:）→ 401；只精确匹配这一条路径；GET → 405", async () => {
    const req = new Request("http://b.local/api/v1/lend/offer", { method: "POST", body: offer("x4") });
    setRequestContext(req, { source: "loopback", clientIp: null, https: false, e2e: { peerFp: FP } });
    const invite = { id: "p", name: "invite", agents: [], peer: "invite:abc" } as unknown as Principal;
    expect((await handleLendInbox(req, "/lend/offer", invite))!.status).toBe(401);
    expect(await handleLendInbox(req, "/lend/offerx", invite)).toBeNull();
    expect(await handleLendInbox(req, "/lend/offer/x", invite)).toBeNull();
    expect((await call({ body: "", method: "GET" })).status).toBe(405);
    expect(rowOf("x4")).toBeNull();
  }, 30_000);

  test("正文不合格 → 400 invalid，不记", async () => {
    const r = await call({ body: JSON.stringify({ v: 1, proto: 2, orders: [summary("x5")], extra: true }) });
    expect(r.status).toBe(400);
    expect(rowOf("x5")).toBeNull();
  }, 30_000);

  test("成功：真起 manager lend inbox，回包恰好 ok / v / accepted / refused 四个字段；位满的那张 200 + refused", async () => {
    const r = await call({ body: offer("o1", "o2") });
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["accepted", "ok", "refused", "v"]);
    expect(body).toEqual({ ok: true, v: 1, accepted: ["o1"], refused: [{ orderId: "o2", code: "no_slot" }] });
    expect(rowOf("o1")).toMatchObject({ state: "asked", peer: PEER, fp: FP, preview: { source: "push" } });
    expect(rowOf("o2")).toBeNull();
  }, 60_000);

  test("收回之后再推：200 + no_grant（不回 404，A 立刻撤回重排）", async () => {
    const file = JSON.parse(readFileSync(LEND_PATH, "utf8"));
    writeFileSync(LEND_PATH, JSON.stringify({ ...file, lend: [] }));
    const r = await call({ body: offer("o3") });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, v: 1, accepted: [], refused: [{ orderId: "o3", code: "no_grant" }] });
  }, 60_000);
});
