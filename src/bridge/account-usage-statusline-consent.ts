/**
 * 自定义 statusLine 的包装批准（lib/statusline-usage-install.ts 的计划 → 本机 owner 点按钮 → applyWrapPlan）。
 *   - 按钮只由 bridge 按落盘的计划生成：id 带进程内密钥的 HMAC，绑定 planId、settings 原字节 hash、包装后 hash、有效期和频道；
 *     agent 贴不出这类按钮（lib/reserved-buttons.ts 拦保留前缀），bridge 重启后旧卡片作废（密钥不落盘）。
 *   - 点击时必须由可信回调证明点击者就是本机 owner（OWNER_PRINCIPAL_ID）；频道、manage 权限、id 存在都不算。
 *     拿不到可信身份就拒绝并说明缺口——不自动确认、不先写后问。
 *   - 写入本身由 applyWrapPlan 再做一次 CAS 与一次消费：错 hash、漂移、过期、重放都零写。
 * 单测 tests/account-usage-statusline-consent.test.ts（fixture settings，不碰真实配置）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import { applyWrapPlan, pendingWrapPlan, WRAP_PLAN_PATH, type WrapPlan } from "../lib/statusline-usage-install.js";

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
      "批准后改成用 Claudestra 脚本包住它：原命令照样跑、显示不变，只多把用量写进本机缓存（看板不再显示未知）。不批准什么都不改。",
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
