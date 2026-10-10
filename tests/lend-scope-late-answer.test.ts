/**
 * W6 晚到的答复：出借 worker 交了结论（result_pending）之后还活着、还在等 A 的回执，也还能 ask（lib/lend-tools.ts）；A 的 PM
 * 用 send_to_agent 回 worker@B 走的就是这条消息路由。经真 serveApiRequest（真鉴权：验签 + 钉钥 + E2E 上下文）打：
 * started / result_pending 放行且真的投到 worker（deliver 收到正文）；结束态 403 不投；钥匙不对、没签名照旧拒。
 * manager list 换成只列本文件登记的 worker（不起子进程、不碰 tmux）；整文件在独立状态目录的子进程里跑（tests/isolated-state.ts）。
 */
import { expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders, type InstanceKey } from "../src/lib/instance-key.ts";
import { LEND_PATH } from "../src/lib/lend-config.ts";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked, type LendState } from "../src/lib/lend-journal.ts";
import { workerName } from "../src/lib/lend-worker-name.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { isolatedStateSuite } from "./isolated-state.ts";

const { afterAll, beforeAll, describe, test } = isolatedStateSuite(import.meta.path);

const PEER = "lateMate";
const listed: string[] = [];
const clients = new Map<string, { ws: never; channelId: string; cwd: string }>();
const delivered: { agent: string; content: string }[] = [];
// 临时目录和钥匙只在子进程的 beforeAll 里建：父进程里 afterAll 是空操作，顶层建的会泄漏
let dirA = "";
let dirX = "";
let keyA: InstanceKey;
let keyX: InstanceKey;
let FP = "";
let secret = "";
let n = 0;

/** 一单走到 started（写 agent），再按 to 往后推；worker 登记进 manager list 和在线连接 */
function seed(orderId: string, to: LendState[] = []): string {
  const agent = workerName(orderId);
  const db = openLendJournal(LEND_JOURNAL_PATH);
  recordAsked(db, { orderId, peer: PEER, fp: FP, family: "codex", preview: {} });
  advance(db, orderId, "asked", "claimed", { leaseGen: 1 });
  advance(db, orderId, "claimed", "cloned");
  advance(db, orderId, "cloned", "started", { agent, sessionId: "s-1" });
  let cur: LendState = "started";
  for (const s of to) { advance(db, orderId, cur, s); cur = s; }
  db.close();
  listed.push(agent);
  clients.set(`ch-${agent}`, { ws: {} as never, channelId: `ch-${agent}`, cwd: dirA });
  return agent;
}

function move(orderId: string, from: LendState, to: LendState): void {
  const db = openLendJournal(LEND_JOURNAL_PATH);
  advance(db, orderId, from, to);
  db.close();
}

beforeAll(async () => {
  dirA = mkdtempSync(join(tmpdir(), "w6-late-a-"));
  dirX = mkdtempSync(join(tmpdir(), "w6-late-x-"));
  keyA = instanceKeySync(dirA)!;
  keyX = instanceKeySync(dirX)!;
  FP = keyFingerprint(keyA.publicKey);
  const realMgmt = await import("../src/bridge/management.ts");
  mock.module(join(import.meta.dir, "../src/bridge/management.ts"), () => ({
    ...realMgmt,
    runManager: async (...args: string[]) => (args[0] === "list"
      ? { ok: true, agents: listed.map((name) => ({ name, channelId: `ch-${name}`, status: "active", cwd: dirA })) }
      : { ok: false, error: `manager ${args[0]} 不在本测试里` }),
  }));
  const { initApiRoutes } = await import("../src/bridge/api-routes.ts");
  const { newTokenPrincipal, updatePrincipals } = await import("../src/lib/principals.ts");
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [{ name: PEER, baseUrl: "http://a.example", addedAt: new Date(0).toISOString(), fp: FP }] }));
  const principal = newTokenPrincipal(PEER, ["agent-x"], { peer: PEER });
  secret = principal.secret!;
  await updatePrincipals((f) => (f.principals.push(principal), { changed: true, result: null }));
  const now = Date.now();
  writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ peer: PEER, fp: FP, families: { codex: 1 }, roles: ["review"],
    repos: ["shawnlu96/claudestra"], ordersPerDay: 5, grantedAt: new Date(now).toISOString(), until: new Date(now + 86_400_000).toISOString() }] }));
  initApiRoutes({
    clients, mirrorApiExchange: async () => {}, startTypingWithSafety: () => {}, lastMessageSource: new Map(),
    deliver: async (env: any) => (delivered.push({ agent: env.to.agentName, content: env.content }), { envelope: env, outcome: { kind: "sent" } }),
    handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
  } as never);
});

afterAll(() => {
  for (const d of [dirA, dirX]) rmSync(d, { recursive: true, force: true });
});

/** A 的 owner / PM 发给 worker 的一句话：默认用 A 的钥匙签名、带 E2E 上下文。返回状态码和这条有没有投到 */
async function send(agent: string, o: { key?: InstanceKey; sign?: boolean } = {}): Promise<{ status: number; delivered: boolean }> {
  const { serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const path = `/api/v1/agents/${encodeURIComponent(agent)}/messages`;
  const text = `PM 答复 ask-${++n}：按方案 B 做`;
  const body = JSON.stringify({ text, wait: 0, nonce: crypto.randomUUID() });
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json",
    ...(o.sign === false ? {} : signedHeaders("POST", path, body, o.key ?? keyA)) };
  const req = new Request(`http://b.local${path}`, { method: "POST", headers, body });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false, e2e: { peerFp: FP } });
  const r = await serveApiRequest(req, new URL(req.url));
  return { status: r.status, delivered: delivered.some((d) => d.agent === agent && d.content === text) };
}

describe("W6：worker 还活着、单还归 A 的状态都收 A 的消息", () => {
  test("started → 投到 worker；交了结论进 result_pending 后晚到的答复照样投到", async () => {
    const order = "late:s1:r0:review:a0";
    const agent = seed(order);
    expect(await send(agent)).toEqual({ status: 202, delivered: true });
    move(order, "started", "result_pending");
    expect(await send(agent)).toEqual({ status: 202, delivered: true });
    move(order, "result_pending", "acked");
    expect(await send(agent)).toEqual({ status: 403, delivered: false });
  }, 30_000);

  test("单已结束（stopped / cancelled，result_pending 之后的也一样）→ 403，不投", async () => {
    const ends: LendState[][] = [["stopped"], ["cancelled"], ["result_pending", "stopped"], ["result_pending", "cancelled"]];
    for (const [i, to] of ends.entries()) expect(await send(seed(`late:s2:r${i}:review:a0`, to))).toEqual({ status: 403, delivered: false });
  }, 30_000);

  test("result_pending 下钥匙不对 / 没签名照旧拒，不投", async () => {
    const agent = seed("late:s3:r0:review:a0", ["result_pending"]);
    expect(await send(agent)).toEqual({ status: 202, delivered: true }); // 先用 A 的钥匙打一次：钉住的是 A 的
    const wrongKey = await send(agent, { key: keyX });
    expect([401, 403]).toContain(wrongKey.status);
    expect(wrongKey.delivered).toBe(false);
    expect(await send(agent, { sign: false })).toEqual({ status: 401, delivered: false });
  }, 30_000);
});
