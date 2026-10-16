/**
 * WXPASTE1 服务端：POST /api/v1/agents/:name/messages 的附件——零字节回 400「is empty」，读 / 存失败分开报，
 * 不再一律「invalid body」；正常附件照旧落 inbox。经真 serveApiRequest（真鉴权、真 multipart 解析），
 * manager list 换成只列本文件的 agent；整文件在独立状态目录的子进程里跑（tests/isolated-state.ts）。
 */
import { expect, mock } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_PATH } from "../src/lib/registry.ts";
import { isolatedStateSuite } from "./isolated-state.ts";

const { afterAll, beforeAll, describe, test } = isolatedStateSuite(import.meta.path);

const AGENT = "agent-wx";
const delivered: string[] = [];
let dir = "";
let inbox = "";
let secret = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wxpaste-"));
  inbox = join(dir, "inbox");
  const { setAttachmentDirsForTest } = await import("../src/bridge/local-api/attachments.ts");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(inbox);
  setAttachmentDirsForTest({ uploadDir: join(dir, "uploads"), inboxDirs: [inbox] });
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
  const p = newTokenPrincipal("wx", [AGENT]);
  secret = p.secret!;
  await updatePrincipals((f) => (f.principals.push(p), { changed: true, result: null }));
  initApiRoutes({
    clients: new Map([[`ch-${AGENT}`, { ws: {} as never, channelId: `ch-${AGENT}`, cwd: dir }]]),
    mirrorApiExchange: async () => {}, startTypingWithSafety: () => {}, lastMessageSource: new Map(),
    deliver: async (env: any) => (delivered.push(JSON.stringify(env.meta ?? {}) + env.content), { envelope: env, outcome: { kind: "sent" } }),
    handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
  } as never);
});

afterAll(async () => {
  const { setAttachmentDirsForTest } = await import("../src/bridge/local-api/attachments.ts");
  setAttachmentDirsForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function post(files: File[], text = "看图") {
  const { serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const fd = new FormData();
  fd.append("text", text);
  fd.append("wait", "0");
  for (const f of files) fd.append("files", f);
  const req = new Request(`http://b.local/api/v1/agents/${AGENT}/messages`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: fd });
  setRequestContext(req, { source: "loopback", clientIp: null, https: false });
  const r = await serveApiRequest(req, new URL(req.url));
  return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string } };
}

describe("[验收线 3] 入站附件的错误说清楚", () => {
  test("零字节附件 → 400，错误带 is empty，不投递、不落盘", async () => {
    const before = delivered.length;
    const r = await post([new File([], "微信图片.png", { type: "image/png" })]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^file "[^"]*" is empty$/); // Bun 解析 0 字节分片时丢文件名，名字可能是 (unnamed)
    expect(delivered.length).toBe(before);
    expect(readdirSync(inbox)).toEqual([]);
  });
  test("正常附件照旧落 inbox 并投递", async () => {
    const r = await post([new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" })]);
    expect(r.status).toBe(202);
    const saved = readdirSync(inbox).filter((n) => n.endsWith("shot.png"));
    expect(saved.length).toBe(1);
    expect([...readFileSync(join(inbox, saved[0]))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(delivered.at(-1)).toContain("看图");
  });
  test("saveUploadToInbox：读失败标 read（路由据此回「could not read」），不是存失败", async () => {
    const { saveUploadToInbox, uploadFailureStage } = await import("../src/bridge/local-api/media-refresh.ts");
    const f = new File([new Uint8Array(4)], "gone.png");
    Object.defineProperty(f, "arrayBuffer", { value: () => Promise.reject(new DOMException("gone", "NotReadableError")) });
    const err = await saveUploadToInbox(f, AGENT).then(() => null, (e: unknown) => e);
    expect(uploadFailureStage(err)).toBe("read");
    expect(uploadFailureStage(new Error("EACCES: permission denied, open '/x/inbox/a'"))).toBe("save");
  });
});
