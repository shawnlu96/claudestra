/**
 * T39：会话管理类接口只给全权凭据（isFullScope = canManage）。以前的门只查 `agents.includes("*")`，
 * scope 为 "*" 的 guest（默认 guestGrant(["*"])）和 peer 都能进：列出全部会话 id、收编 owner 的会话，
 * 或 resume takeover 把 owner 正在跑的 CC 进程 SIGTERM 掉。
 *
 * 八种凭据 × 六个接口，全部走真实鉴权（api-auth：Bearer / 设备 cookie）。沙箱见 tests/api-runner-harness.ts。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { effectivePrincipal, guestGrant, hashDeviceToken, type DeviceCredential, type Grant } from "../src/lib/devices";
import type { Principal } from "../src/lib/principals";
import { visibleSessions, type NeutralSessionInfo } from "../src/bridge/sessions-inventory";

const at = "2026-01-01T00:00:00Z";
const device = (id: string, grant: Grant): DeviceCredential => ({
  id: `dev_${id}`, v: 1, type: "bearer", hash: hashDeviceToken(`dev_${id}`), deviceName: id, grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
});
const OWNER_GRANT: Grant = { agents: ["*", "master"], terminal: false, manage: true };
const token = (id: string, agents: string[], extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:tok_${id}`, role: "external", name: id, agents, secret: `s-${id}`, createdAt: at, ...extra }) as Principal;

const PRINCIPALS: Principal[] = [
  {
    id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at,
    credentials: [device("owner", OWNER_GRANT), device("owner_nomanage", { ...OWNER_GRANT, manage: false })],
  } as Principal,
  { id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device("guest_all", guestGrant(["*"]))] } as Principal,
  { id: "guest:cc", role: "external", name: "friend2", agents: ["cc"], createdAt: at, credentials: [device("guest_cc", guestGrant(["cc"]))] } as Principal,
  token("webui", ["*", "master"], { name: "web-ui" }),
  token("cc_only", ["cc"]),
  token("peer_all", ["*"], { peer: "alex" }),
  token("peer_cc", ["cc"], { peer: "alex" }),
];

/** 名字 → 请求凭据；ALLOWED 之外的一律 403 */
const CREDS: Record<string, { device?: string; bearer?: string }> = {
  "owner 设备": { device: "dev_owner" },
  "owner 设备 manage=false": { device: "dev_owner_nomanage" },
  "guest *": { device: "dev_guest_all" },
  "guest 部分 scope": { device: "dev_guest_cc" },
  "老的 * Bearer（web-ui）": { bearer: "s-webui" },
  "scoped token": { bearer: "s-cc_only" },
  "peer *": { bearer: "s-peer_all" },
  "peer 部分 scope": { bearer: "s-peer_cc" },
};
const ALLOWED = new Set(["owner 设备", "老的 * Bearer（web-ui）"]);

const ENDPOINTS: Record<string, { method: string; path: string; body?: string; ok: number[] }> = {
  "session-list": { method: "GET", path: "/api/v1/session-list", ok: [200] },
  runtimes: { method: "GET", path: "/api/v1/runtimes", ok: [200] },
  // 空 body 过了门就是 400：能走到参数校验 = 门放行了
  resume: { method: "POST", path: "/api/v1/agents/resume", body: "{}", ok: [400] },
  // 过了门以后假 tmux 抓不到屏：409 / 502 都说明走到了门后面
  clear: { method: "POST", path: "/api/v1/agents/cc/clear", body: "{}", ok: [409, 502] },
  // 机器网络盘点：过了门以后真去探测，结果随本机而定，只断言「不是 403」
  "remote-access": { method: "GET", path: "/api/v1/remote-access", ok: [] },
};

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];

beforeAll(() => {
  sandbox = runnerHome("session-gates-", { agents: { "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x" } } });
  const specs = Object.entries(CREDS).flatMap(([cred, auth]) =>
    Object.entries(ENDPOINTS).map(([ep, e]) => ({ name: `${cred} ${ep}`, method: e.method, path: e.path, body: e.body, auth })),
  );
  results = sandbox.run(specs, { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS) });
}, 120_000);

afterAll(() => sandbox?.cleanup());

describe("权限矩阵：八种凭据 × 会话管理类接口", () => {
  for (const cred of Object.keys(CREDS)) {
    test(`${cred}：${ALLOWED.has(cred) ? "过门" : "一律 403 requires a full-scope token"}`, () => {
      for (const [ep, e] of Object.entries(ENDPOINTS)) {
        const r = results.find((x) => x.name === `${cred} ${ep}`)!;
        if (!ALLOWED.has(cred)) {
          expect([ep, r.status, JSON.parse(r.body!).error]).toEqual([ep, 403, `${ep} requires a full-scope token`]);
        } else if (e.ok.length) {
          expect([ep, e.ok.includes(r.status!)]).toEqual([ep, true]);
        } else {
          expect([ep, r.status]).not.toEqual([ep, 403]);
        }
      }
    });
  }
});

describe("GET /sessions 的可见范围（visibleSessions）", () => {
  const list: NeutralSessionInfo[] = [
    { kind: "interactive", sessionId: "s-cc", status: "running", registeredAgent: "agent-cc" },
    { kind: "background", sessionId: "s-dopp", status: "running", doppelgangerOf: "agent-cc" },
    { kind: "interactive", sessionId: "s-wild", status: "running", cwd: "/Users/owner/secret" },
  ];
  const owner = PRINCIPALS[0];
  const viaDevice = (p: Principal, i: number) => effectivePrincipal({ principal: p, credential: p.credentials![i] });
  const ids = (p: Principal) => visibleSessions(list, p).map((s) => s.sessionId);

  test("全权凭据看全部，含野生会话", () => {
    expect(ids(viaDevice(owner, 0))).toEqual(["s-cc", "s-dopp", "s-wild"]);
    expect(ids(PRINCIPALS[3])).toEqual(["s-cc", "s-dopp", "s-wild"]);
  });

  test("其余只看 scope 内 agent 的正式会话及其分身，野生会话（本机手敲的 CC）一律看不到", () => {
    const others = [viaDevice(owner, 1), viaDevice(PRINCIPALS[1], 0), viaDevice(PRINCIPALS[2], 0), PRINCIPALS[4], PRINCIPALS[5], PRINCIPALS[6]];
    for (const p of others) expect([p.id, ids(p)]).toEqual([p.id, ["s-cc", "s-dopp"]]);
  });
});
