/**
 * 自定义 statusLine 的包装批准（lib/statusline-usage-install.ts 的计划 → 本机 owner 点按钮 → applyWrapPlan）。
 *   - 按钮只由 bridge 按落盘的计划生成：id 带进程内密钥的 HMAC，绑定 planId、settings 原字节 hash、包装后 hash、有效期和频道；
 *     agent 贴不出这类按钮（lib/reserved-buttons.ts 拦保留前缀），bridge 重启后旧卡片作废（密钥不落盘）。
 *   - 卡片由 bridge 按计划贴到控制频道（Envelope/deliver + 网页 SSE），同一计划本进程只贴一次（重启后密钥换了，旧卡作废、新卡重贴一次）。
 *   - 点击时必须由可信回调证明点击者就是本机 owner：网页点击在 /api/v1 扩展路由里截下，按 team-confirm 的 canConfirmTeam
 *     （owner 本人设备凭据、全 scope、非 peer）判；Discord 管理按钮入口不带点击者身份，一律拒绝。频道、manage 权限、id 存在都不算。
 *   - 写入本身由 applyWrapPlan 再做一次 CAS 与一次消费：错 hash、漂移、过期、重放都零写。
 * 单测 tests/account-usage-statusline-consent.test.ts（fixture settings，不碰真实配置）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import type { Principal } from "../lib/principals.js";
import { applyWrapPlan, pendingWrapPlan, WRAP_PLAN_PATH, type WrapPlan } from "../lib/statusline-usage-install.js";
import { apiJson } from "./api-respond.js";
import { emitEvent, getAgentStatus, isBusyStatus } from "./event-bus.js";
import { newMessageId, newThreadId, type Delivery, type Envelope } from "./router.js";
import { canConfirmTeam } from "./team-confirm.js";

export const SLWRAP_PREFIX = "slwrap_ok:";
const MAC_KEY = randomBytes(32);

/** 点在哪儿 + 谁点的。owner 只能来自可信回调（核过的 principal id），不能由调用方凭频道推断 */
export interface ConsentClick {
  chatId: string;
  messageId?: string;
  /** 可信回调核出的点击者 principal id；没有可信回调 = undefined */
  principalId?: string;
}

export interface ConsentDeps {
  key?: Uint8Array;
  planPath?: string;
  now?: () => number;
}

function macOf(key: Uint8Array, p: WrapPlan, chatId: string): string {
  return createHmac("sha256", key).update([p.planId, p.origSha, p.newSha, p.expiresAt, chatId].join("|")).digest("hex").slice(0, 32);
}

/** bridge 自己生成批准卡片（只认落盘的未消费计划）；没有计划 = null */
export function statuslineConsentCard(chatId: string, deps: ConsentDeps = {}): { text: string; components: any[] } | null {
  const plan = pendingWrapPlan((deps.now ?? Date.now)(), deps.planPath ?? WRAP_PLAN_PATH);
  if (!plan) return null;
  const id = `${SLWRAP_PREFIX}${plan.planId}:${macOf(deps.key ?? MAC_KEY, plan, chatId)}`;
  return {
    text: `你的 Claude Code 已有自定义 statusLine：\n\`${plan.originalCommand.slice(0, 300)}\`\n` +
      "批准后改成用 Claudestra 脚本包住它：原命令照样跑、显示不变，只多把用量写进本机缓存（看板不再显示未知）。不批准什么都不改。\n" +
      "请在网页端（owner 本人的设备）点批准；Discord 里点会被拒绝。",
    components: [{ type: "buttons", buttons: [{ id, label: "✅ 批准包装", style: "success" }] }],
  };
}

const eq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 点击处理：返回给点击者看的一行；只有全部核对通过才会写 settings.json */
export async function handleStatuslineConsentButton(id: string, click: ConsentClick, deps: ConsentDeps = {}): Promise<string> {
  const m = id.slice(SLWRAP_PREFIX.length).match(/^([0-9a-f]{16}):([0-9a-f]{32})$/);
  if (!id.startsWith(SLWRAP_PREFIX) || !m) return "❌ 按钮格式不对，什么都没改";
  if (click.principalId === undefined) {
    return "❌ 拿不到可信的点击者身份（这个入口不带 owner 回调），已拒绝，settings.json 未改动";
  }
  if (click.principalId !== OWNER_PRINCIPAL_ID) return "❌ 只有本机 owner 能批准修改 statusLine，什么都没改";
  const planPath = deps.planPath ?? WRAP_PLAN_PATH;
  const plan = pendingWrapPlan((deps.now ?? Date.now)(), planPath);
  if (!plan || plan.planId !== m[1] || !eq(macOf(deps.key ?? MAC_KEY, plan, click.chatId), m[2]!)) {
    return "❌ 按钮已失效（计划已用过 / 过期 / 不是 bridge 贴出的卡片 / bridge 重启过），什么都没改；重跑 setup 会生成新计划";
  }
  const r = await applyWrapPlan(plan.planId, { planPath, now: deps.now });
  if (r.ok) return "✅ 已包装 statusLine：原命令与显示不变，用量开始写入本机缓存（原文件已备份为 settings.json.claudestra-statusline.bak）";
  return `❌ 没写（${r.reason}）：settings.json 在计划之后改过或计划已失效，原配置保持不变；重跑 setup 生成新计划`;
}

const FROM = "⚙️ statusline";
/** 本进程已贴过的计划：tick 反复调用不刷屏；重启清空（旧卡按钮随密钥作废，新进程重贴一次） */
const postedPlans = new Set<string>();

/** bridge 自己贴批准卡片到控制频道。没有待批计划 / 已贴过 / 没有控制频道都不贴 */
export async function postStatuslineConsentCard(
  deliver: (env: Envelope) => Promise<Delivery>,
  deps: ConsentDeps & { chatId?: string } = {},
): Promise<"posted" | "none" | "duplicate" | "no_channel" | "failed"> {
  const now = (deps.now ?? Date.now)();
  const plan = pendingWrapPlan(now, deps.planPath ?? WRAP_PLAN_PATH);
  if (!plan) return "none";
  if (postedPlans.has(plan.planId)) return "duplicate";
  const chatId = deps.chatId ?? process.env.CONTROL_CHANNEL_ID ?? "";
  if (!chatId) return "no_channel";
  const card = statuslineConsentCard(chatId, deps)!;
  const meta = { messageId: newMessageId("slwrap"), triggerKind: "bridge_synth" as const, ts: new Date(now).toISOString(), threadId: newThreadId(),
    components: card.components };
  const r = await deliver({ from: { kind: "bridge", label: "statusline-consent" }, to: { kind: "user", userId: "", channelId: chatId },
    intent: "notification", content: card.text, meta });
  if (r.outcome.kind !== "sent") return "failed";
  postedPlans.add(plan.planId);
  emitEvent({ agent: "master", chatId, type: "chat_message", data: { direction: "out", from: FROM, text: card.text, threadId: meta.threadId, components: card.components } });
  return "posted";
}

const BUTTON_WIRE = /^\s*\[button:(slwrap_ok:[0-9a-f]{16}:[0-9a-f]{32})\]\s*$/;

/**
 * /api/v1 扩展路由：网页在 master 聊天里点批准 = POST /agents/master/messages，正文恰好是本按钮 → 在这里结案，不投给 agent。
 * 只有 canConfirmTeam 判过的 owner 设备才把可信身份交给 handleStatuslineConsentButton；其余 403、零写。
 */
export function statuslineConsentRoute(deps: () => ConsentDeps = () => ({})) {
  return async (req: Request, url: URL, principal: Principal): Promise<Response | null> => {
    const agent = req.method === "POST" ? url.pathname.match(/\/agents\/([^/]+)\/messages$/)?.[1] : undefined;
    if (!agent || !(req.headers.get("Content-Type") ?? "").includes("application/json")) return null;
    const body = (await req.clone().json().catch(() => null)) as { text?: unknown } | null; // 不是 JSON 就不是按钮点击：交回原路由按它的规则报错
    const m = typeof body?.text === "string" ? body.text.match(BUTTON_WIRE) : null;
    if (!m) return null;
    if (!canConfirmTeam(principal)) return apiJson(403, { ok: false, error: "只有 owner 本人的设备能批准修改 statusLine" });
    // 卡片只贴在控制频道（master 的聊天）：别的频道里点，chatId 对不上 HMAC，按失效拒绝
    const chatId = decodeURIComponent(agent) === "master" ? (process.env.CONTROL_CHANNEL_ID ?? "") : "";
    const text = await handleStatuslineConsentButton(m[1]!, { chatId, principalId: OWNER_PRINCIPAL_ID }, deps());
    emitEvent({ agent: "master", chatId, type: "chat_message", data: { direction: "out", from: FROM, text } });
    if (!isBusyStatus(getAgentStatus("master"))) emitEvent({ agent: "master", chatId, type: "agent_status", data: { status: "done", trigger: "statusline-consent" } });
    return apiJson(200, { ok: true, handled: "statusline-consent", text });
  };
}
