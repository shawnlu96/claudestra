import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingressRequest } from "../src/bridge/peer-ingress.js";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { requestContextOf } from "../src/bridge/request-context.js";
import { relayMark, RELAY_MARK_HEADER, TUNNEL_MARK_HEADER } from "../src/bridge/relay-inbound.js";
import { attachCredential, ensureOwnerPrincipal, fullGrant } from "../src/lib/devices.js";
import type { PrincipalsFile } from "../src/lib/principals.js";

const dir = mkdtempSync(join(tmpdir(), "ingress-cookie-"));
const path = join(dir, "principals.json");
const file: PrincipalsFile = { principals: [] };
const { token } = attachCredential(ensureOwnerPrincipal(file), "test-browser", fullGrant());
writeFileSync(path, JSON.stringify(file));
beforeAll(() => setApiAuthPrincipalsPathForTest(path));
afterAll(() => { setApiAuthPrincipalsPathForTest(undefined); rmSync(dir, { recursive: true, force: true }); });

test("真入口 + 真鉴权：只有无标记回环反代保留设备 cookie；XFF 不产生回环豁免", async () => {
  const run = (addr: string, extra: Record<string, string> = {}) => ingressRequest(new Request("http://peer.test/api/v1/agents", {
    headers: { cookie: `cstra_dev=${token}`, "x-forwarded-for": "203.0.113.15", "x-forwarded-proto": "https", ...extra },
  }), async (req, url) => {
    const p = await authenticateApi(req, url, { rateLimit: false });
    return p instanceof Response ? p : Response.json({ id: p.id, source: requestContextOf(req).source });
  }, addr);
  const proxy = await run("127.0.0.1");
  expect(proxy.status).toBe(200);
  expect(await proxy.json()).toEqual({ id: "owner:self", source: "lan" });
  expect((await run("100.64.0.7")).status).toBe(403);
  expect((await run("127.0.0.1", { [TUNNEL_MARK_HEADER]: "untrusted" })).status).toBe(403);
  expect((await run("127.0.0.1", { [RELAY_MARK_HEADER]: relayMark(), "x-claudestra-relay-from": "1111-2222-3333-4444" })).status).toBe(403);
  expect((await run("127.0.0.1", { cookie: "cstra_dev=dev_invalid" })).status).toBe(401);
});
