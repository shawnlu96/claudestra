/**
 * POST /api/v1/relay/setup 改的是本机 .env，防回退：从认证到路由整条链路走一遍（bridge/api-auth.ts authenticateApi →
 * local-api/control.ts handleControl）。没 cookie 401、没 CSRF 头 403、没 manage 403、坏请求体在动 .env 之前 400；
 * 「本机」只认真的回环 socket，伪造的 X-Forwarded-For 不算（relay-inbound.ts socketTrust）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { handleControl } from "../src/bridge/local-api/control.js";
import { socketTrust } from "../src/bridge/relay-inbound.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { attachCredential, DEVICE_COOKIE, DEVICE_HEADER, ensureOwnerPrincipal } from "../src/lib/devices.js";
import type { Principal, PrincipalsFile } from "../src/lib/principals.js";

const PATH = "/api/v1/relay/setup";
let dir: string;
let full: string, noManage: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-setup-auth-"));
  const file: PrincipalsFile = { principals: [] };
  const owner = ensureOwnerPrincipal(file);
  full = attachCredential(owner, "laptop", { agents: ["*", "master"], terminal: true, manage: true }).token;
  noManage = attachCredential(owner, "tablet", { agents: ["*", "master"], terminal: false, manage: false }).token;
  writeFileSync(join(dir, "principals.json"), JSON.stringify(file));
  setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
});
afterAll(() => {
  setApiAuthPrincipalsPathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function post(headers: Record<string, string>, body = "{}"): Request {
  const r = new Request(`http://bridge.local${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  setRequestContext(r, { source: "lan", clientIp: "192.168.1.9", https: false });
  return r;
}
async function through(r: Request): Promise<number> {
  const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
  if (p instanceof Response) return p.status;
  return (await handleControl(r, "/relay/setup", p as Principal))!.status;
}
const cookie = (token: string) => ({ cookie: `${DEVICE_COOKIE}=${token}` });

describe("/relay/setup 的门", () => {
  test("没有 cookie → 401", async () => {
    expect(await through(post({}))).toBe(401);
  });
  test("有 cookie 但没 CSRF 头 → 403", async () => {
    expect(await through(post(cookie(full)))).toBe(403);
  });
  test("凭据没给 manage → 403", async () => {
    expect(await through(post({ ...cookie(noManage), [DEVICE_HEADER]: "1" }))).toBe(403);
  });
  test("有 manage 的设备凭据、请求体不对 → 400，在碰 .env 之前就挡掉", async () => {
    for (const body of ["{", '{"url":"x"}', '{"relayUrl":false}']) expect(await through(post({ ...cookie(full), [DEVICE_HEADER]: "1" }, body))).toBe(400);
  });
});

describe("socketTrust 只认真的回环", () => {
  const req = (xff?: string) => new Request("http://127.0.0.1:3847/api/v1/relay/setup", { headers: xff ? { "x-forwarded-for": xff } : {} });
  test("外来 socket 伪造 X-Forwarded-For: 127.0.0.1 → 不是本机", () => {
    expect(socketTrust(req("127.0.0.1"), "203.0.113.9")).toBe(false);
  });
  test("回环 socket 但带了转发头（反代转进来的）→ 不是本机；干净的回环才是", () => {
    expect(socketTrust(req("203.0.113.9"), "127.0.0.1")).toBe(false);
    expect(socketTrust(req(), "127.0.0.1")).toBe(true);
  });
});
