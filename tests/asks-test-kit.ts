/** 「待你处理」测试共用的凭据（asks-bridge / asks-v2 / ask-access 三个测试文件）：owner 设备、guest 设备、peer、老的「*」集成 token */
import { effectivePrincipal, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";

export const at = "2026-09-28T00:00:00Z";
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const credential = (id: string, grant: Grant) => ({ id, v: 1 as const, type: "bearer" as const, hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });

export const owner = (grant: Grant = { agents: ["*"], terminal: true, manage: true }, cid = "dev_1") => effectivePrincipal({ principal: OWNER_BASE, credential: credential(cid, grant) });
/** 授权含大总管的 owner 设备：发起方和派发者都不在、答复落到大总管的用例用它 */
export const ownerWithMaster = () => owner({ agents: ["*", "master"], terminal: true, manage: true });
/** 配对进来的 guest 设备（每配对一次一个 guest:<hex>，只看得到给它的几个 agent） */
export const guest = (hex: string, agents = ["agent-x"]) =>
  effectivePrincipal({ principal: { id: `guest:${hex}`, role: "external", agents, createdAt: at }, credential: credential(`dev_${hex}`, { agents, terminal: false, manage: false }) });
export const PEER: Principal = { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at };
export const LEGACY_STAR_TOKEN: Principal = { id: "token:tok_int", role: "external", name: "integration", agents: ["*"], createdAt: at };

/** principals.json 里存的样子：生效视图按 id 归回 principal，凭据挂在名下（按凭据认人的 principalView 读它） */
export function storedPrincipals(...views: Principal[]): { principals: Principal[] } {
  const byId = new Map<string, Principal>();
  for (const { credential: cid, ...v } of views) {
    const p = byId.get(v.id) ?? (v.id === OWNER_BASE.id ? { ...OWNER_BASE } : v);
    if (cid) p.credentials = [...(p.credentials ?? []), credential(cid, { agents: v.agents, terminal: !!v.terminal, manage: v.manage === true })];
    byId.set(v.id, p);
  }
  return { principals: [...byId.values()] };
}
