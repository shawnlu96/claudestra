import { randomBytes, timingSafeEqual } from "node:crypto";
import { issueGrant } from "../../state-maintenance/grant.js";
import { openMaintenance, type MaintContext } from "../../state-maintenance/context.js";
import { productionHost, rawConfig, modes } from "./production.js";
import { ServiceStore } from "./store.js";
import { servicesBinding } from "./maintenance.js";
import type { ServicePlan } from "../plan/types.js";

type Mac = (action: string, arg: string) => string;
type Manager = (...args: string[]) => Promise<any>;
interface Button { id: string; label: string; style: string }
interface Reply { text: string; components?: { type: string; buttons: Button[] }[] }
interface View { config: unknown; plan(txId: string): ServicePlan; active(): { id: string; status: string } | null }
const PREFIX = "smaint:parts:";
const TTL_MS = 5 * 60_000;

function button(mac: Mac, action: string, item: string, txId: string, label: string, now: number): Button {
  const arg = [action, item, txId, (now + TTL_MS).toString(36)].join(":");
  return { id: `${PREFIX}${arg}:${mac("parts", arg)}`, label, style: action.endsWith("ask") ? "secondary" : "danger" };
}
export function partsEntry(mac: Mac, now = Date.now()) {
  return { type: "buttons", buttons: [button(mac, "panel", "", "", "CLI / 服务改名维护", now)] };
}

/** MAC comes from STATE2's bridge-only key. The outer Discord interaction has already verified owner. */
export async function handlePartButton(id: string, manager: Manager, ctx: MaintContext, mac: Mac, owner: boolean,
  view?: View, now = Date.now()): Promise<Reply> {
  if (!owner) return { text: "❌ 只有 owner 点击可以签发维护授权" };
  const m = /^smaint:parts:([a-z]+):(services|runtime|config|):([A-Za-z0-9_-]*):([a-z0-9]+):([a-f0-9]{20})$/.exec(id);
  if (!m) return { text: "❌ 维护按钮格式不对" };
  const arg = m.slice(1, 5).join(":"), expected = mac("parts", arg), expires = parseInt(m[4]!, 36);
  if (expected.length !== 20 || !timingSafeEqual(Buffer.from(expected), Buffer.from(m[5]!)) ||
      !Number.isSafeInteger(expires) || now > expires || expires > now + TTL_MS) return { text: "❌ 维护按钮伪造、过期或频道不符，请刷新面板" };
  const [, action, item, txId] = m;
  if (!["panel", "ask", "run", "rollbackask", "rollback", "retireask", "retire"].includes(action!)) return { text: "❌ 未知维护动作" };
  const store = new ServiceStore(ctx.maintRoot);
  const v = view ?? { config: rawConfig(), plan: (tx: string) => productionHost(ctx.maintRoot, ctx.home, tx).plan,
    active: () => { const s = store.active(); return s ? { id: s.plan.id, status: store.journal()?.status ?? "running" } : null; } };
  if (action === "panel") {
    const r = modes(v.config), active = v.active(), buttons: Button[] = [];
    const fresh = `svc-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    if (r.services === "on" || r.cli === "on") buttons.push(button(mac, "ask", "services", active?.id ?? fresh, "批准 CLI / 服务维护…", now));
    for (const part of ["runtime", "config"]) if (r[part] === "on") buttons.push(button(mac, "ask", part, `${part}-${fresh}`, `批准 ${part} 事务…`, now));
    if (active) buttons.push(button(mac, "rollbackask", "services", active.id, "回滚当前服务事务…", now));
    if (active && active.status !== "running") buttons.push(button(mac, "retireask", "services", active.id, "归档终态事务…", now));
    return { text: `CLI / 服务改名：services=${r.services}，cli=${r.cli}，runtime=${r.runtime}，config=${r.config}`,
      components: [{ type: "buttons", buttons: buttons.slice(0, 5) }] };
  }
  if (!item || !txId) return { text: "❌ 缺少维护动作和事务号" };
  const execution = action.startsWith("rollback") ? "rollback" : action.startsWith("retire") ? "retire" : "resume";
  if (action === "ask" || action.endsWith("ask")) return {
    text: `批准 ${item} / ${execution}，事务 ${txId}。服务切换会先卸旧并确认停写；失败保留日志供恢复或回滚。确认现在执行？`,
    components: [{ type: "buttons", buttons: [button(mac, action === "ask" ? "run" : execution, item, txId, "批准并执行", now)] }],
  };
  openMaintenance(ctx);
  const token = issueGrant(ctx.maintRoot, { action: item as "services" | "runtime" | "config", actor: "owner",
    binding: item === "services" ? servicesBinding(v.plan(txId), execution) : { txId } }, now);
  const args = [item, txId, ...(item === "services" ? [execution] : []), "--grant", token];
  const result = await manager("state-maintenance", ...args);
  return { text: `${result?.ok ? "✅" : "❌"} ${JSON.stringify(result)}` };
}
