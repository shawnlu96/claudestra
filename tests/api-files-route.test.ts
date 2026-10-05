/**
 * GET /api/v1/files/:id 对 peer 的取件（2026-10-05 实报：peer 拿回复里的 /api/v1/files/:id 一律 404，只能改走 /api/v1/media）。
 * 照 tests/lend-scope-route.test.ts 的搭法：独立状态目录里放好 peer 记录与 token，经真 serveApiRequest（真鉴权：验签 + 钉钥 + E2E
 * 会话上下文）取件；登记走真 stageApiReplyFiles（与 bridge.ts deliverToApi 同一个调用）。「bridge 重启」= 重新加载一份路由模块
 * （带查询串的 import 是一个全新的模块实例，模块级的登记表从头建），登记只在内存里的话这一步就 404。
 */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFileAllowed, type ApiFileEntry } from "../src/bridge/api-files.ts";
import { stageApiReplyFiles } from "../src/bridge/api-reply-files.ts";
import { apiFiles, initApiRoutes, serveApiRequest } from "../src/bridge/api-routes.ts";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments.ts";
import { setMediaForTest } from "../src/bridge/local-api/media-refresh.ts";
import { setRequestContext } from "../src/bridge/request-context.ts";
import { instanceKeySync, keyFingerprint, signedHeaders, type InstanceKey } from "../src/lib/instance-key.ts";
import { closeMediaIndex } from "../src/lib/media-index.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { newTokenPrincipal, tokenIdOf, updatePrincipals, type Principal } from "../src/lib/principals.ts";
import { isolatedStateSuite } from "./isolated-state.ts";

// 路由内部读默认 peers / principals / 登记表，只能走默认路径：整文件在独立状态目录的子进程里跑
const { afterAll, beforeAll, describe, test } = isolatedStateSuite(import.meta.path);

type Routes = { initApiRoutes: typeof initApiRoutes; serveApiRequest: typeof serveApiRequest };
type Machine = { key: InstanceKey; fp: string };

const root = mkdtempSync(join(tmpdir(), "api-files-route-"));
const machine = (name: string): Machine => {
  const key = instanceKeySync(join(root, name))!;
  return { key, fp: keyFingerprint(key.publicKey) };
};
const MATE = machine("mate");
const RIVAL = machine("rival");
const BYTES = "PK-zip-bytes-for-peer";
let n = 0;

const deps = {
  clients: new Map(),
  deliver: async (env: unknown) => ({ envelope: env, outcome: { kind: "sent" } }),
  mirrorApiExchange: async () => {}, startTypingWithSafety: () => {}, lastMessageSource: new Map(), handleEventsRequest: () => new Response("events"),
  scheduleClearRotation: () => {},
} as never;

function writePeers(mateFp = MATE.fp): void {
  const rec = (name: string, fp: string) => ({ name, baseUrl: `http://${name}.example`, addedAt: new Date(0).toISOString(), fp });
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [rec("mate", mateFp), rec("rival", RIVAL.fp)] }));
}

/** 签一张 token；rotate = 先把同名 peer 的有效 token 全禁用（manager issuePeerToken / peer-join 重新兑换的做法） */
async function issue(name: string, agents: string[], peer?: string, rotate = false): Promise<Principal> {
  const p = newTokenPrincipal(name, agents, peer ? { peer } : undefined);
  await updatePrincipals((f) => {
    if (rotate) for (const x of f.principals) if (x.peer === peer) x.disabled = true;
    f.principals.push(p);
    return { changed: true, result: null };
  });
  return p;
}

/** 照 E2E 解开后的内层请求：Bearer + 实例签名 + 会话上下文（会话发起方 = 签名的那台机器） */
async function get(routes: Routes, id: string, who: Principal, from: Machine): Promise<Response> {
  const path = `/api/v1/files/${id}?n=${++n}`; // 同一秒同路径的签名一样会被当成重放
  const req = new Request(`http://b.local${path}`, { headers: { Authorization: `Bearer ${who.secret}`, ...signedHeaders("GET", path, "", from.key) } });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false, e2e: { peerFp: from.fp } });
  return routes.serveApiRequest(req, new URL(req.url));
}

/** agent-x 回复 to 这张 token 时带了一个附件：返回登记的 id */
async function reply(to: Principal): Promise<string> {
  const src = join(root, `bundle-${++n}.zip`);
  writeFileSync(src, BYTES);
  const s = await stageApiReplyFiles([src], { agent: "agent-x", tokenId: tokenIdOf(to), table: apiFiles, acceptsFiles: true });
  expect(s.files).toHaveLength(1);
  return /^\/api\/v1\/files\/(.+)$/.exec(s.files[0]!.url)![1]!;
}

const live: Routes = { initApiRoutes, serveApiRequest };
/** bridge 重启：新的路由模块实例（模块级状态从头建），照 bridge 启动时那样 initApiRoutes */
async function restart(): Promise<Routes> {
  const fresh = (await import(`../src/bridge/api-routes.ts?restart=${++n}`)) as Routes; // 相对路径 + 查询串才是新实例（file:// URL 会被当成同一个）
  fresh.initApiRoutes(deps);
  return fresh;
}

beforeAll(async () => {
  mkdirSync(join(root, "inbox"));
  setAttachmentDirsForTest({ uploadDir: join(root, "uploads"), inboxDirs: [join(root, "inbox")] });
  setMediaForTest({ db: join(root, "media.sqlite"), thumbs: join(root, "thumbs"), agents: async () => [{ name: "agent-x" }], sources: async () => [] });
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: {
    "agent-x": { name: "agent-x", channelId: "ch-x", cwd: root, external: true }, "agent-y": { name: "agent-y", channelId: "ch-y", cwd: root, external: true },
  } }));
  writePeers();
  initApiRoutes(deps);
});

afterAll(() => {
  setMediaForTest(undefined);
  setAttachmentDirsForTest(undefined);
  closeMediaIndex(join(root, "media.sqlite"));
  rmSync(root, { recursive: true, force: true });
});

describe("同一个 peer 经 E2E 取件", () => {
  test("登记的那张 token 当场取 → 200，字节就是附件", async () => {
    const mate = await issue("peer-mate", ["agent-x"], "mate");
    const r = await get(live, await reply(mate), mate, MATE);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BYTES);
  }, 30_000);

  test("bridge 重启之后同一个 peer 再来取 → 200（旧代码：登记只在内存，404）", async () => {
    const mate = await issue("peer-mate", ["agent-x"], "mate", true);
    const id = await reply(mate);
    const r = await get(await restart(), id, mate, MATE);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BYTES);
  }, 30_000);

  test("对方重新兑换换了 token（旧的禁用、同一台机器签新的）→ 新 token 取得到（旧代码：tokenId 不等，404）", async () => {
    const before = await issue("peer-mate", ["agent-x"], "mate", true);
    const id = await reply(before);
    const after = await issue("peer-mate", ["agent-x"], "mate", true);
    expect((await get(live, id, before, MATE)).status).toBe(401); // 旧 token 已禁用：连鉴权都过不了
    const r = await get(live, id, after, MATE);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BYTES);
  }, 30_000);
});

describe("别人拿到 id 也取不到（与没有这个 id 同一个 404）", () => {
  test("别的 peer（自己的 E2E 会话、scope 含发件 agent）→ 404", async () => {
    const mate = await issue("peer-mate", ["agent-x"], "mate", true);
    const id = await reply(mate);
    const rival = await issue("peer-rival", ["agent-x"], "rival", true);
    expect((await get(live, id, rival, RIVAL)).status).toBe(404);
    expect((await get(live, "f_nope", rival, RIVAL)).status).toBe(404);
  }, 30_000);

  test("同一个 peer 的新 token 但 scope 不含发件 agent → 404", async () => {
    const id = await reply(await issue("peer-mate", ["agent-x"], "mate", true));
    const narrow = await issue("peer-mate", ["agent-y"], "mate", true);
    expect((await get(live, id, narrow, MATE)).status).toBe(404);
  }, 30_000);

  test("peer 删掉后同名加回的是另一台机器（钥匙指纹变了）→ 404", async () => {
    const id = await reply(await issue("peer-mate", ["agent-x"], "mate", true));
    const other = machine("mate-reborn");
    writePeers(other.fp);
    try {
      const imposter = await issue("peer-mate", ["agent-x"], "mate", true);
      expect((await get(live, id, imposter, other)).status).toBe(404);
    } finally {
      writePeers();
    }
  }, 30_000);
});

describe("取件授权（apiFileAllowed）：非 peer 的凭据只认登记的那张", () => {
  const entry: ApiFileEntry = { path: "/x", tokenId: "tok_a", name: "a.zip", agent: "agent-x", peer: "mate", peerFp: MATE.fp };
  const anchor = async () => MATE.fp;
  const base = { role: "external" as const, agents: ["agent-x"], createdAt: "2026-01-01T00:00:00Z" };

  test("guest 设备、脚本 token（scope 都含发件 agent）→ 拒；登记的那张本人 → 放", async () => {
    expect(await apiFileAllowed(entry, { ...base, id: "guest:g1" }, anchor)).toBe(false);
    expect(await apiFileAllowed(entry, { ...base, id: "token:tok_script", name: "script" }, anchor)).toBe(false);
    expect(await apiFileAllowed(entry, { ...base, id: "token:tok_a" }, anchor)).toBe(true);
  });

  test("老登记（没记 peer 指纹）只认原 token，同名 peer 的别的 token 不放", async () => {
    const legacy: ApiFileEntry = { path: "/x", tokenId: "tok_a", name: "a.zip" };
    expect(await apiFileAllowed(legacy, { ...base, id: "token:tok_b", peer: "mate" }, anchor)).toBe(false);
    expect(await apiFileAllowed(entry, { ...base, id: "token:tok_b", peer: "mate" }, anchor)).toBe(true);
  });
});
