/**
 * i28-W6 B 侧消息例外的路由行为：照 tests/peer-e2e-relay.test.ts 的搭法，在测试进程的 STATE_DIR（tests/preload.ts 给的临时目录）
 * 里放好 peer 记录、peer token、lend.json 与 journal，经真 serveApiRequest（真鉴权：验签 + 钉钥 + E2E 上下文）打消息路由。
 * 正例：A 的 peer token（scope 不含出借 worker）给替 A 跑着单的 worker 发 JSON 消息 → 过了 scope 闸、走到找 agent 那一步（这里没有
 * tmux 窗口，manager list 找不到它，回 404 而不是 403；之后的投递路径本卡没改）；反例各一条 → 403。manager 子进程的运行目录指到临时目录，
 * 不读线上 tmux。
 * 同一凭据打 history / interrupt / pending / bg-tasks 仍 403、事件流过滤不放行、GET /agents 不列它；源码断言例外只在消息路由那一行。
 */
import { expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initApiRoutes, serveApiRequest } from "../src/bridge/api-routes.ts";
import { ENV_WITH_BUN as BRIDGE_ENV } from "../src/bridge/config.ts";
import { sseEventAllow } from "../src/bridge/ledger-feed.ts";
import { setRequestContext } from "../src/bridge/request-context.ts";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.ts";
import { LEND_PATH } from "../src/lib/lend-config.ts";
import { workerName } from "../src/lib/lend-drive.ts";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked } from "../src/lib/lend-journal.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { newTokenPrincipal, readPrincipals, updatePrincipals, type Principal } from "../src/lib/principals.ts";
import { isolatedStateSuite } from "./isolated-state.ts";

// 路由内部读默认 journal / peers / principals，只能走默认路径：整文件在独立状态目录的子进程里跑（i28-TJ1）
const { afterAll, beforeAll, describe, test } = isolatedStateSuite(import.meta.path);

const PEER = "w6mate";
const ORDER = "w6-route:s1:r0:review:a0";
const WORKER = workerName(ORDER);
const OTHER = workerName("w6-route:s2:r0:review:a0");
const STATE_FILES = ["registry.json", "peers.json", "principals.json", "peer-keys.json", LEND_PATH,
  LEND_JOURNAL_PATH, LEND_JOURNAL_PATH + "-wal", LEND_JOURNAL_PATH + "-shm"];
// Preserve the SQLite files byte-for-byte so restoring route state cannot poison another test's journal.
const saved = new Map<string, Buffer | null>();
const dirA = mkdtempSync(join(tmpdir(), "w6-peer-a-"));
const ENV_WITH_BUN = BRIDGE_ENV as Record<string, string | undefined>; // bridge 起 manager 子进程用的 env（runManager）
const runtimeBefore = ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR;
const keyA = instanceKeySync(dirA)!;
const FP = keyFingerprint(keyA.publicKey);
const delivered: { agent: string; content: string }[] = [];
let secret = "";
let principal: Principal;
let n = 0;

const fileOf = (f: string) => (f.startsWith("/") ? f : join(STATE_DIR, f));

/** true = W1 一次授权（v2，到期 1 天后）；false = `lend revoke` 全部收回后落盘的样子。v1 条目读时迁成暂停、不生效，不能用在这里 */
function lendFile(granted: boolean): void {
  const now = Date.now();
  const entry = { peer: PEER, fp: FP, families: { codex: 1 }, roles: ["review"], repos: ["shawnlu96/claudestra"], ordersPerDay: 5,
    grantedAt: new Date(now).toISOString(), until: new Date(now + 86_400_000).toISOString() };
  writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: granted, lend: granted ? [entry] : [], borrow: [] }));
}

beforeAll(async () => {
  ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR = join(dirA, "runtime"); // manager list 的 tmux socket 落到临时目录：没有服务器 = 没有窗口
  for (const f of STATE_FILES) saved.set(f, existsSync(fileOf(f)) ? readFileSync(fileOf(f)) : null);
  for (const f of ["peers.json", "principals.json", "peer-keys.json"]) rmSync(fileOf(f), { force: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: {
    [WORKER]: { name: WORKER, channelId: "ch-lend", cwd: dirA }, [OTHER]: { name: OTHER, channelId: "ch-other", cwd: dirA },
    "agent-x": { name: "agent-x", channelId: "ch-x", cwd: dirA, external: true }, "agent-home": { name: "agent-home", channelId: "ch-home", cwd: dirA },
  } }));
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [{ name: PEER, baseUrl: "http://a.example", addedAt: new Date(0).toISOString(), fp: FP }] }));
  principal = newTokenPrincipal(PEER, ["agent-x"], { peer: PEER });
  secret = principal.secret!;
  await updatePrincipals((f) => (f.principals.push(principal), { changed: true, result: null }));
  lendFile(true);
  const db = openLendJournal(LEND_JOURNAL_PATH);
  for (const [orderId, peer] of [[ORDER, PEER], ["w6-route:s2:r0:review:a0", "rival"]] as const) {
    recordAsked(db, { orderId, peer, fp: FP, family: "codex", preview: {} });
    advance(db, orderId, "asked", "claimed", { leaseGen: 1 });
    advance(db, orderId, "claimed", "cloned");
    advance(db, orderId, "cloned", "started", { agent: workerName(orderId) });
  }
  db.close();
  const ws = {} as never;
  initApiRoutes({
    clients: new Map(["ch-lend", "ch-other", "ch-x", "ch-home"].map((id) => [id, { ws, channelId: id, cwd: dirA }])) as never,
    deliver: async (env: any) => (delivered.push({ agent: env.to.agentName, content: env.content }), { envelope: env, outcome: { kind: "sent" } }),
    mirrorApiExchange: async () => {}, startTypingWithSafety: () => {}, lastMessageSource: new Map(), handleEventsRequest: () => new Response("events"),
    scheduleClearRotation: () => {},
  } as never);
});

afterAll(() => {
  if (runtimeBefore === undefined) delete ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR;
  else ENV_WITH_BUN.CLAUDESTRA_RUNTIME_DIR = runtimeBefore;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(LEND_JOURNAL_PATH + suffix, { force: true });
  for (const [f, v] of saved) v === null ? rmSync(fileOf(f), { force: true }) : writeFileSync(fileOf(f), v);
  rmSync(dirA, { recursive: true, force: true });
});

interface Call { method?: string; path: string; body?: string; contentType?: string; e2e?: boolean; sign?: boolean }
async function call(c: Call): Promise<Response> {
  const method = c.method ?? "POST";
  const body = c.body ?? (method === "POST" ? JSON.stringify({ text: `hi ${++n}`, wait: 0, nonce: crypto.randomUUID() }) : "");
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, ...(c.sign === false ? {} : signedHeaders(method, c.path, body, keyA)) };
  if (method === "POST") headers["Content-Type"] = c.contentType ?? "application/json";
  const req = new Request(`http://b.local${c.path}`, { method, headers, ...(method === "POST" ? { body } : {}) });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false, ...(c.e2e === false ? {} : { e2e: { peerFp: FP } }) });
  return serveApiRequest(req, new URL(req.url));
}
const msg = (agent: string, over: Partial<Call> = {}) => call({ path: `/api/v1/agents/${encodeURIComponent(agent)}/messages`, ...over });

describe("消息路由的例外", () => {
  const passedGate = async (r: Response) => {
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain("not found");
  };

  test("正例：发起方给替它跑着单的出借 worker 发 JSON 消息 → 过闸（404 找不到窗口，不是 403）；去掉 agent- 前缀同样", async () => {
    for (const name of [WORKER, WORKER.replace(/^agent-/, "")]) await passedGate(await msg(name));
  }, 30_000);

  test("反例：B 本机别的 agent、别的 peer 那单的 worker、非 E2E、未签名、multipart、?ask= → 403，不投递", async () => {
    const before = delivered.length;
    const cases: [string, Partial<Call>][] = [
      ["agent-home", {}], [OTHER, {}], [WORKER, { e2e: false }], [WORKER, { sign: false }],
      [WORKER, { contentType: "multipart/form-data; boundary=x", body: "--x--" }],
    ];
    for (const [agent, over] of cases) {
      const r = await msg(agent, over);
      expect(over.sign === false ? 401 : 403).toBe(r.status); // 没签名的在鉴权那层就 401
    }
    expect((await call({ path: `/api/v1/agents/${WORKER}/messages?ask=a1` })).status).toBe(403);
    expect(delivered.length).toBe(before);
  }, 30_000);

  test("带文件的 multipart、参数里藏 application/json（或 JSON 头参数里藏 multipart）→ 403", async () => {
    // 每次 body 不同：同一秒内同 body 的签名一模一样，会被重放检查拒成 401
    const body = (text: string) => ["--x", 'Content-Disposition: form-data; name="text"', "", text, "--x",
      'Content-Disposition: form-data; name="files"; filename="a.txt"', "Content-Type: text/plain", "", "0123456789", "--x--", ""].join("\r\n");
    const sneaky = "multipart/form-data; boundary=x; note=application/json";
    const form = await new Request("http://x", { method: "POST", headers: { "Content-Type": sneaky }, body: body("hi") }).formData();
    expect(form.get("files")).toBeInstanceOf(File); // 前提：下游 req.formData() 真能从这条请求里拿到文件
    for (const contentType of [sneaky, "application/json; boundary=x; y=multipart/form-data"]) {
      expect((await msg(WORKER, { contentType, body: body(`hi ${++n}`) })).status).toBe(403);
    }
  }, 30_000);

  test("授权收回（lend.json 关掉）后立刻拒；再打开又放行（每次现读）", async () => {
    await passedGate(await msg(WORKER));
    lendFile(false);
    expect((await msg(WORKER)).status).toBe(403);
    lendFile(true);
    await passedGate(await msg(WORKER));
  }, 30_000);
});

describe("例外不扩散", () => {
  test("同一凭据打 history / interrupt / pending / bg-tasks / tasks 仍 403；事件流过滤不放行；GET /agents 不列出借 worker", async () => {
    for (const [method, sub] of [["GET", "history"], ["POST", "interrupt"], ["GET", "pending"], ["GET", "bg-tasks"], ["GET", "tasks"]] as const) {
      expect((await call({ method, path: `/api/v1/agents/${WORKER}/${sub}`, body: method === "POST" ? "{}" : "" })).status).toBe(403);
    }
    const p = (await readPrincipals()).principals.find((x) => x.peer === PEER)!;
    expect(sseEventAllow(p)({ agent: WORKER, chatId: "", type: "chat_message", data: {} } as never)).toBe(false);
    const list = await call({ method: "GET", path: "/api/v1/agents" });
    expect(JSON.stringify(await list.json())).not.toContain(WORKER.replace(/^agent-/, ""));
  }, 60_000);

  test("源码：lendScopeAllows 在 api-routes 里只出现在消息路由那一行（外加 import）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/bridge/api-routes.ts"), "utf8").split("\n");
    const uses = src.map((l, i) => [l, i] as const).filter(([l]) => l.includes("lendScopeAllows"));
    expect(uses.map(([l]) => l.trim())).toEqual([
      'import { lendScopeAllows } from "./lend-scope.js";',
      "if (!inScopeEitherName(principal, agentParam) && !(await lendScopeAllows(req, principal, agentParam))) return notInScope(agentParam);",
    ]);
    const routeLine = uses[1]![1];
    expect(src.slice(routeLine - 3, routeLine).join("\n")).toContain('path.match(/^\\/agents\\/([^/]+)\\/messages$/)');
    expect(src.length).toBeLessThanOrEqual(1892); // 1891 行 + 末尾换行
  });
});
