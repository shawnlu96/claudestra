/**
 * agents-PEERLEVEL1 入站：经真 serveApiRequest（真鉴权：peer 验签 + 钉钥 + E2E 上下文）打 POST /agents/:name/messages。
 * 只有已认证的 peer principal 标 info 时信封才带 meta.pmLevel="info"；peer action / 缺省 / 非法值、普通 API token 标 info 都不带。
 * 摘要收下（deliver 回 note:"digest"）的 peer info 不挂 pending、不起 typing，wait>0 也直接回 202。
 * manager list 换成只列本文件的 agent（不起子进程、不碰 tmux）；整文件在独立状态目录的子进程里跑（tests/isolated-state.ts）。
 */
import { expect, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders, type InstanceKey } from "../src/lib/instance-key.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { REGISTRY_PATH } from "../src/lib/registry.ts";
import { isolatedStateSuite } from "./isolated-state.ts";

const { afterAll, beforeAll, describe, test } = isolatedStateSuite(import.meta.path);

const PEER = "levelMate", AGENT = "agent-pm";
const delivered: { content: string; pmLevel?: string }[] = [];
let typing = 0;
let dir = "";
let key: InstanceKey;
let FP = "";
const secrets = { peer: "", plain: "" };
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "peer-level-"));
  key = instanceKeySync(dir)!;
  FP = keyFingerprint(key.publicKey);
  const realMgmt = await import("../src/bridge/management.ts");
  mock.module(join(import.meta.dir, "../src/bridge/management.ts"), () => ({
    ...realMgmt,
    runManager: async (...args: string[]) => (args[0] === "list"
      ? { ok: true, agents: [{ name: AGENT, channelId: `ch-${AGENT}`, status: "active", cwd: dir }] }
      : { ok: false, error: `manager ${args[0]} 不在本测试里` }),
  }));
  if (!existsSync(REGISTRY_PATH)) writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {} }));
  const t = new Date(Date.now() + 5_000);
  utimesSync(REGISTRY_PATH, t, t); // 名单缓存认 registry mtime 作废（lib/agent-lookup-cache.ts）
  const { initApiRoutes } = await import("../src/bridge/api-routes.ts");
  const { newTokenPrincipal, updatePrincipals } = await import("../src/lib/principals.ts");
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [{ name: PEER, baseUrl: "http://a.example", addedAt: new Date(0).toISOString(), fp: FP }] }));
  const peer = newTokenPrincipal(PEER, [AGENT], { peer: PEER }), plain = newTokenPrincipal("plain", [AGENT]);
  secrets.peer = peer.secret!;
  secrets.plain = plain.secret!;
  await updatePrincipals((f) => (f.principals.push(peer, plain), { changed: true, result: null }));
  initApiRoutes({
    clients: new Map([[`ch-${AGENT}`, { ws: {} as never, channelId: `ch-${AGENT}`, cwd: dir }]]),
    mirrorApiExchange: async () => {}, startTypingWithSafety: () => void typing++, lastMessageSource: new Map(),
    // 当班 PM 的摘要收下 info（bridge/pm-digest.ts 回 note:"digest"）；其余照常送到
    deliver: async (env: any) => (delivered.push({ content: env.content, ...(env.meta.pmLevel ? { pmLevel: env.meta.pmLevel } : {}) }),
      { envelope: env, outcome: { kind: "sent", ...(env.meta.pmLevel === "info" ? { note: "digest" } : {}) } }),
    handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
  } as never);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 发一条消息，返回状态码和投出去的信封 meta.pmLevel；peer 默认带签名和 E2E 上下文 */
async function send(o: { level?: unknown; peer?: boolean; wait?: number }) {
  const { serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const path = `/api/v1/agents/${AGENT}/messages`, peer = o.peer !== false;
  const text = `进度 ${++n}`;
  const body = JSON.stringify({ text, wait: o.wait ?? 0, nonce: crypto.randomUUID(), ...(o.level !== undefined ? { level: o.level } : {}) });
  const headers: Record<string, string> = { Authorization: `Bearer ${peer ? secrets.peer : secrets.plain}`, "Content-Type": "application/json",
    ...(peer ? signedHeaders("POST", path, body, key) : {}) };
  const req = new Request(`http://b.local${path}`, { method: "POST", headers, body });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false, ...(peer ? { e2e: { peerFp: FP } } : {}) });
  const r = await serveApiRequest(req, new URL(req.url));
  const d = delivered.find((x) => x.content.includes(text));
  return { status: r.status, delivered: !!d, pmLevel: d?.pmLevel };
}

describe("[验收线 2] 入站只认已认证 peer 的 info", () => {
  test("peer principal + info → meta.pmLevel === \"info\"", async () => {
    expect(await send({ level: "info" })).toEqual({ status: 202, delivered: true, pmLevel: "info" });
  }, 30_000);

  test("peer + action / 缺省 / 非法值、普通 API token + info → 都没有 pmLevel", async () => {
    for (const level of ["action", undefined, "INFO", 1, { level: "info" }]) {
      expect(await send({ level })).toEqual({ status: 202, delivered: true, pmLevel: undefined });
    }
    expect(await send({ level: "info", peer: false })).toEqual({ status: 202, delivered: true, pmLevel: undefined });
  }, 30_000);
});

describe("[验收线 4] 摘要收下的 peer info：不挂 pending、不起 typing", () => {
  test("wait>0 的 peer info 被摘要收下 → 直接 202、pending 清空、typing 不起；action 照旧挂 pending、起 typing", async () => {
    const { pendingApiRequests } = await import("../src/bridge/api-routes.ts");
    pendingApiRequests.clear();
    const before = typing, t0 = Date.now();
    expect(await send({ level: "info", wait: 5 })).toEqual({ status: 202, delivered: true, pmLevel: "info" });
    expect(Date.now() - t0).toBeLessThan(4_000); // 没在 wait 窗口里干等
    expect([...pendingApiRequests.values()].flat()).toEqual([]);
    expect(typing).toBe(before);
    expect((await send({ level: "action" })).status).toBe(202);
    expect([...pendingApiRequests.values()].flat()).toHaveLength(1);
    expect(typing).toBe(before + 1);
  }, 30_000);
});
