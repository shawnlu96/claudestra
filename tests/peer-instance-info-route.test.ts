/** PEERINFO1 [验收线 2]：GET /api/v1/agents 只对 peer 凭据、开关 on 时带 instance；其余回包与改前逐字相同。 */
import { beforeEach, expect, test } from "bun:test";
import { handleAgentsList } from "../src/bridge/agents-list-route.ts";
import { peerInstanceBlock, resetInstanceObserveLog, type PeerInstanceInfo } from "../src/lib/peer-instance-info.ts";
import type { RecoveryMode } from "../src/lib/recovery-policy.ts";
import type { Principal } from "../src/lib/principals.ts";

const INFO: PeerInstanceInfo = { version: "2.33.0", commit: "d9427176deff576232a2b47e0c0dc3a6bb0afd31", channel: "release", switches: { lendUiUpload: "off" } };
const PEER = { id: "token:tok_p", role: "external", name: "peer-x", agents: ["*"], peer: "peer-x", createdAt: "" } as Principal;
/** 未兑换的邀请 token：兑换前允许只读 GET 列表（peer-signature / peer-trust），但还不是已配对 peer */
const INVITE = { id: "token:tok_i", role: "external", name: "invite", agents: [], peer: "invite:pending", createdAt: "" } as Principal;
const OWNER = { id: "token:tok_o", role: "owner", name: "owner", agents: ["*"], createdAt: "" } as Principal;
const WEB = { id: "token:tok_w", role: "external", name: "web", agents: ["*"], createdAt: "" } as Principal;
/** 改前的回包：manager list 是空表时 handleAgentsList 回的正文 */
const BEFORE = JSON.stringify({ ok: true, agents: [] });

let logs: string[] = [];
let calls = 0;
beforeEach(() => { logs = []; calls = 0; resetInstanceObserveLog(); });

async function get(principal: Principal, mode: RecoveryMode): Promise<string> {
  const res = await handleAgentsList(new URL("http://x/api/v1/agents"), principal, {
    runManager: async () => ({ agents: [] }), clients: new Map(), controlChannelId: "",
    peerInstance: (peer) => peerInstanceBlock(peer, { mode: () => mode, info: () => { calls++; return INFO; }, log: (l) => logs.push(l) }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

test("peer 凭据 + on：回包有 instance，其余字段照旧", async () => {
  const body = JSON.parse(await get(PEER, "on"));
  expect(body).toEqual({ ok: true, agents: [], instance: INFO });
});

test("owner / web 凭据：无论开关在哪档，回包与改前逐字相同，组装都不跑", async () => {
  for (const p of [OWNER, WEB]) for (const m of ["on", "observe", "off"] as const) expect(await get(p, m)).toBe(BEFORE);
  expect(calls).toBe(0);
  expect(logs).toEqual([]);
});

test("peer 凭据 + off / observe：回包与改前逐字相同；observe 只多一行键名日志", async () => {
  expect(await get(PEER, "off")).toBe(BEFORE);
  expect(logs).toEqual([]);
  expect(await get(PEER, "observe")).toBe(BEFORE);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("version, commit, channel, switches.lendUiUpload");
  expect(logs[0]).not.toContain(INFO.commit!.slice(0, 7));
});

test("未兑换邀请凭据（invite:）：即使开关 on，回包与改前逐字相同，组装与日志都不跑", async () => {
  for (const m of ["on", "observe", "off"] as const) expect(await get(INVITE, m)).toBe(BEFORE);
  expect(calls).toBe(0);
  expect(logs).toEqual([]);
});
