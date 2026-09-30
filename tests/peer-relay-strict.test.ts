/**
 * 严格模式开关（bridge/peer-relay-strict.ts、manager peer-relay-strict）：只有 owner 设备能改；中继页面只能打开不能关；
 * manager 命令两个方向都能改，写的是同一个 config.json 键。路由层「开 / 关时加入放不放行」在 tests/peers-routes-relay-page.test.ts。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { handlePeersRoutes } from "../src/bridge/peers-routes.ts";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.ts";
import { readConfig, setPeerRelayJoinStrict } from "../src/lib/config-store.ts";
import type { Principal } from "../src/lib/principals.ts";
import { runPeerInviteCommand } from "../src/manager/peers-invite-cli.ts";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
/** 全 scope、带 manage 的别人的设备（guest）：能进 /peers，但不是 owner */
const GUEST: Principal = { id: "guest:a1b2", role: "external", agents: ["*"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_g1" };
const RELAY: RequestContext = { source: "relay", clientIp: null, https: true };
const LOCAL: RequestContext = { source: "loopback", clientIp: "127.0.0.1", https: false };
const PATH = "/peers/relay-strict";
const before = readConfig().then((c) => c.peerRelayJoinStrict === true);

function req(method: string, ctx: RequestContext, body?: unknown): Request {
  const r = new Request(`http://bridge.local/api/v1${PATH}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  setRequestContext(r, ctx);
  return r;
}
const noManager = async () => {
  throw new Error("开关不该起 manager 子进程");
};
async function call(p: Principal, method: string, ctx: RequestContext, body?: unknown) {
  const res = (await handlePeersRoutes(req(method, ctx, body), PATH, p, noManager))!;
  return { status: res.status, json: (await res.json()) as { ok?: boolean; strict?: boolean; viaRelayPage?: boolean; canSet?: boolean; code?: string } };
}
const strictNow = async () => (await readConfig()).peerRelayJoinStrict === true;

afterAll(async () => void (await setPeerRelayJoinStrict(await before)));

describe("网页开关", () => {
  beforeEach(async () => void (await setPeerRelayJoinStrict(false)));

  test("缺省关；GET 告诉页面自己是不是中继页面、能不能改", async () => {
    expect((await call(OWNER, "GET", RELAY)).json).toEqual({ ok: true, strict: false, viaRelayPage: true, canSet: true });
    expect((await call(GUEST, "GET", LOCAL)).json).toEqual({ ok: true, strict: false, viaRelayPage: false, canSet: false });
  });

  test("非 owner 设备改不了（开、关都 403），设置不变", async () => {
    for (const strict of [true, false]) {
      expect((await call(GUEST, "POST", LOCAL, { strict })).status).toBe(403);
      expect(await strictNow()).toBe(false);
    }
  });

  test("owner 在中继页面：能打开，关不掉（403，仍是开）", async () => {
    expect((await call(OWNER, "POST", RELAY, { strict: true })).json).toMatchObject({ ok: true, strict: true });
    const off = await call(OWNER, "POST", RELAY, { strict: false });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("relay_strict_off_local_only");
    expect(await strictNow()).toBe(true);
  });

  test("owner 在本机页面：开关两个方向都行；正文不对 400", async () => {
    expect((await call(OWNER, "POST", LOCAL, { strict: true })).json.strict).toBe(true);
    expect((await call(OWNER, "POST", LOCAL, { strict: false })).json.strict).toBe(false);
    expect((await call(OWNER, "POST", LOCAL, { strict: "yes" })).status).toBe(400);
    expect(await strictNow()).toBe(false);
  });
});

describe("manager peer-relay-strict", () => {
  async function manager(...args: string[]): Promise<any> {
    const out: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => void out.push(String(s));
    try {
      await runPeerInviteCommand("peer-relay-strict", args);
    } finally {
      console.log = orig;
    }
    return JSON.parse(out.at(-1) ?? "null");
  }

  test("status / on / off 读写同一个键；不认识的参数报错不改", async () => {
    await setPeerRelayJoinStrict(false);
    expect(await manager()).toMatchObject({ ok: true, strict: false });
    expect(await manager("on")).toMatchObject({ ok: true, strict: true });
    expect(await strictNow()).toBe(true);
    expect(await manager("bogus")).toMatchObject({ ok: false });
    expect(await manager("status")).toMatchObject({ ok: true, strict: true });
    expect(await manager("off")).toMatchObject({ ok: true, strict: false });
    expect(await strictNow()).toBe(false);
  });
});
