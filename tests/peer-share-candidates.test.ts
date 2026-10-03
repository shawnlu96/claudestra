/**
 * peer-share-F1：设置 → Peer 协作里的分享候选（GET /peers 的 localAgents，bridge/peers-routes.ts）不列一次性出借 worker。
 * 识别只用 lib/lend-workers-view.ts 的 isLendWorkerName（agent-lend-<10hex> / lend-<10hex>），不看项目名、不看状态。
 * 只改候选：peer 已有的 scope（exposedAgents）原样返回，GET 不调任何改授权的 manager 命令、不写 principals。
 * 三条入口（改 scope / 新邀请 / 双向加入）都用同一份 GET /peers 的 localAgents，这里对 web 源码做接线断言（不挂 React）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { handlePeersRoutes } from "../src/bridge/peers-routes.ts";
import { PEERS_PATH } from "../src/lib/peers.ts";
import { PRINCIPALS_PATH, type Principal } from "../src/lib/principals.ts";
import { REGISTRY_PATH } from "../src/lib/registry.ts";
import { REPO_ROOT } from "../src/lib/repo-root.ts";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const STATUSES = ["active", "creating", "stopped"] as const;
const hex10 = (i: number) => i.toString(16).padStart(10, "0");

/** 80 个 stopped 标准出借 worker（Sekai 报告的形状）+ 各状态、两种前缀的 worker + 普通会话（含名字相近但不规范的） */
function fixture() {
  const agents: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 80; i++) agents[`agent-lend-${hex10(0xa0000 + i)}`] = { status: "stopped", kind: "worker", purpose: "lend" };
  STATUSES.forEach((status, i) => {
    agents[`agent-lend-${hex10(0xb000 + i)}`] = { status };
    agents[`lend-${hex10(0xc000 + i)}`] = { status };
  });
  const ordinary: Record<string, Record<string, unknown>> = {
    "agent-alpha": { status: "active", external: true },
    "agent-beta": { status: "idle" },
    "agent-gamma": { status: "stopped", external: true },
    // 只差一点的普通名字：不是 10 位小写 hex / 多了前后缀 → 照常可见
    "agent-lend-review": { status: "active" },
    "agent-lend-0123456789a": { status: "stopped" },
    "agent-lend-ABCDEF0123": { status: "active" },
    "agent-my-lend-0123456789": { status: "active", external: true },
    "lending-desk": { status: "stopped" },
    // 项目名 / purpose 像出借也不算：只认名字
    "agent-pool-ops": { status: "active", projectId: "lend", purpose: "lend pool ops" },
  };
  return { agents: { ...agents, ...ordinary }, ordinary };
}

const EXPECTED_ORDINARY = [
  { name: "alpha", external: true, status: "active" },
  { name: "beta", external: false, status: "idle" },
  { name: "gamma", external: true, status: "stopped" },
  { name: "lend-review", external: false, status: "active" },
  { name: "lend-0123456789a", external: false, status: "stopped" },
  { name: "lend-ABCDEF0123", external: false, status: "active" },
  { name: "my-lend-0123456789", external: true, status: "active" },
  { name: "lending-desk", external: false, status: "stopped" },
  { name: "pool-ops", external: false, status: "active" },
];

// peer 已有的授权里故意带着出借 worker：刷新候选不能把它摘掉，也不能多给
const SEKAI: Principal = {
  id: "token:tok_sekai", role: "peer", peer: "sekai", createdAt: "2026-09-01T00:00:00Z",
  agents: ["alpha", `lend-${hex10(0xa0000)}`, `agent-lend-${hex10(0xb000)}`],
};

function recorder() {
  const calls: string[][] = [];
  return { calls, run: async (...args: string[]) => (calls.push(args), args[0] === "peer-invite-list" ? { ok: true, invites: [] } : { ok: true }) };
}

async function getPeers(run: (...a: string[]) => Promise<unknown>) {
  const req = new Request("http://bridge.local/api/v1/peers", { method: "GET" });
  const res = (await handlePeersRoutes(req, "/peers", OWNER, run))!;
  expect(res.status).toBe(200);
  return (await res.json()) as { localAgents: { name: string; external: boolean; status: string }[]; peers: { name: string; exposedAgents: string[] }[] };
}

const written = [REGISTRY_PATH, PRINCIPALS_PATH, PEERS_PATH];
beforeEach(async () => {
  for (const p of written) await mkdir(dirname(p), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: fixture().agents }));
  writeFileSync(PRINCIPALS_PATH, JSON.stringify({ principals: [SEKAI] }));
  writeFileSync(PEERS_PATH, JSON.stringify({ httpPeers: [{ name: "sekai", baseUrl: "http://100.64.0.7:3847", outToken: "o".repeat(40), addedAt: "2026-09-01T00:00:00Z" }], pendingInvites: [] }));
});
afterAll(async () => { for (const p of written) await rm(p, { force: true }); });

describe("GET /peers 的分享候选 localAgents", () => {
  test("80 个 stopped 出借 worker + active/creating/stopped 两种前缀的 worker 全不出现；普通会话按原映射全在", async () => {
    const body = await getPeers(recorder().run);
    expect(body.localAgents.some((a) => /^lend-[0-9a-f]{10}$/.test(a.name))).toBe(false);
    expect(body.localAgents).toEqual(EXPECTED_ORDINARY);
    expect(body.localAgents.length).toBe(Object.keys(fixture().ordinary).length); // 9 条，原来是 9 + 80 + 6 = 95
  });

  test("只改候选：peer 已有 scope（含出借 worker 名）原样返回，GET 只调 peer-invite-list，principals 不被改写", async () => {
    const before = readFileSync(PRINCIPALS_PATH, "utf8");
    const m = recorder();
    const body = await getPeers(m.run);
    expect(body.peers.find((p) => p.name === "sekai")?.exposedAgents).toEqual(SEKAI.agents);
    expect(m.calls).toEqual([["peer-invite-list"]]);
    expect(readFileSync(PRINCIPALS_PATH, "utf8")).toBe(before);
  });
});

describe("三条入口共用同一份过滤后的候选（web 接线）", () => {
  const src = (f: string) => readFileSync(join(REPO_ROOT, "web/features/chat/components", f), "utf8");
  const modal = src("peers-modal.tsx");
  const join_ = src("peers-join-confirm.tsx");

  test("改 scope（PeerCard）、新邀请（InvitePanel）、双向加入（JoinConfirm）都把 GET /peers 的 localAgents 原样交给 ScopePicker", () => {
    const pickers = [...modal.matchAll(/<ScopePicker localAgents=\{(\w+)\}/g), ...join_.matchAll(/<ScopePicker localAgents=\{(\w+)\}/g)].map((m) => m[1]);
    expect(pickers).toEqual(["localAgents", "localAgents", "localAgents"]);
    // 两处数据源都是 peersList() 的 localAgents，没有另一份候选
    expect(modal).toContain("setLocalAgents(j.localAgents || [])");
    expect(join_).toContain("setLocalAgents(j.localAgents || [])");
    expect(join_).toContain("peersList<");
    expect(modal).toContain("peersList<");
  });
});
