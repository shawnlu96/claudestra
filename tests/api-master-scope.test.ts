/**
 * "*" 不含 master：/agents/:name/* 的 scope 门走 inScopeEitherName（src/bridge/api-respond.ts），它会再试一次加前缀的写法。
 * 以前 "agent-master" 加前缀成 "agent-agent-master" 就不算 master 了，"*" 放行，路由按名字解析又落到 master——
 * guest "*"（配对 guest 的默认授权）能读 master 的历史、打断 master（send-keys -t master:0 C-c）、给它发消息；
 * 老 "*" Bearer 还能过 claude-settings / clear 的门。走真实鉴权（沙箱见 tests/api-runner-harness.ts）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { guestGrant, hashDeviceToken, type DeviceCredential, type Grant } from "../src/lib/devices";
import { inScopeEitherName } from "../src/bridge/api-respond";
import type { Principal } from "../src/lib/principals";

const at = "2026-01-01T00:00:00Z";
const device = (id: string, grant: Grant): DeviceCredential => ({
  id: `dev_${id}`, v: 1, type: "bearer", hash: hashDeviceToken(`dev_${id}`), deviceName: id, grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
});
const PRINCIPALS = [
  { id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at, credentials: [device("owner", { agents: ["*", "master"], terminal: false, manage: true })] },
  { id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device("guest", guestGrant(["*"]))] },
  { id: "token:tok_star", role: "external", name: "legacy-star", agents: ["*"], secret: "s-star", createdAt: at },
  { id: "token:tok_cc", role: "external", name: "cc-only", agents: ["cc"], secret: "s-cc", createdAt: at },
];
const CREDS = { "guest *": { device: "dev_guest" }, "老 * Bearer": { bearer: "s-star" }, "scoped token": { bearer: "s-cc" } };
const MASTER_NAMES = ["master", "agent-master", "agent-agent-master", "__master__"];
const ENDPOINTS: [string, string, string?][] = [
  ["GET", "history"], ["GET", "skills"], ["GET", "pending"],
  ["POST", "interrupt", "{}"], ["POST", "messages", JSON.stringify({ text: "hi" })], ["POST", "notify-read", "{}"],
  ["POST", "claude-settings", JSON.stringify({ effort: "high" })], ["POST", "clear", "{}"],
];

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];

beforeAll(() => {
  // master 也放进假 manager 的 list：否则 agent-master 解析不到人，回 404 看不出门放没放行
  const agents = { "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x" }, master: { channelId: "api:master", status: "stopped", cwd: "/tmp/m" } };
  sandbox = runnerHome("api-master-scope-", { agents });
  const specs = [
    ...Object.entries(CREDS).flatMap(([cred, auth]) =>
      MASTER_NAMES.flatMap((name) =>
        ENDPOINTS.map(([method, ep, body]) => ({ name: `${cred} ${name} ${ep}`, method, path: `/api/v1/agents/${name}/${ep}`, auth, body })),
      ),
    ),
    { name: "owner agent-master pending", method: "GET", path: "/api/v1/agents/agent-master/pending", auth: { device: "dev_owner" } },
    { name: "guest cc pending", method: "GET", path: "/api/v1/agents/cc/pending", auth: CREDS["guest *"] },
    { name: "guest agent-cc pending", method: "GET", path: "/api/v1/agents/agent-cc/pending", auth: CREDS["guest *"] },
  ];
  results = sandbox.run(specs, { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS) });
}, 60_000);

afterAll(() => sandbox?.cleanup());

const status = (n: string) => results.find((r) => r.name === n)!.status;

describe("master 的各种写法：生产路由 + 假 tmux", () => {
  test("guest * / 老 * Bearer / scoped token × 4 种写法 × 8 个端点：一律 403", () => {
    const leaked = results.filter((r) => !/^owner |^guest (agent-)?cc /.test(r.name) && r.status !== 403).map((r) => `${r.name} → ${r.status}`);
    expect(leaked).toEqual([]);
    expect(results.length).toBe(3 * MASTER_NAMES.length * ENDPOINTS.length + 3);
  });

  test("scope 显式列了 master 的 owner 设备照常能用 agent-master 写法；普通 agent 两种写法照常放行", () => {
    expect(status("owner agent-master pending")).toBe(200);
    expect(status("guest cc pending")).toBe(200);
    expect(status("guest agent-cc pending")).toBe(200);
  });
});

describe("inScopeEitherName（纯函数）", () => {
  const p = (agents: string[]): Principal => ({ id: "token:x", role: "external", name: "x", agents, createdAt: at, secret: "s" });
  test("master 的写法只按 master 判", () => {
    for (const n of MASTER_NAMES) {
      for (const agents of [["*"], ["cc"], ["__master__"]]) expect([n, agents, inScopeEitherName(p(agents), n)]).toEqual([n, agents, false]);
      // 显式列 master（任一写法，lib/principals.ts agentInScope）才放行
      for (const agents of [["*", "master"], ["agent-master"]]) expect([n, agents, inScopeEitherName(p(agents), n)]).toEqual([n, agents, true]);
    }
  });
  test("普通 agent：裸名、agent- 前缀两种写法互认", () => {
    expect(inScopeEitherName(p(["*"]), "cc")).toBe(true);
    expect(inScopeEitherName(p(["*"]), "agent-cc")).toBe(true);
    expect(inScopeEitherName(p(["agent-cc"]), "cc")).toBe(true);
    expect(inScopeEitherName(p(["cc"]), "agent-cc")).toBe(true);
    expect(inScopeEitherName(p(["cc"]), "other")).toBe(false);
    expect(inScopeEitherName(p(["*"]), "mastermind")).toBe(true); // 名字里带 master 的普通 agent 不受影响
  });
});
