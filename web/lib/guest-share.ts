/**
 * 「添加设备 · 给别人」签码的纯逻辑（T42）：名字、会话都要写明，"*" 要第二次确认才带 confirmAllAgents；
 * bridge 的校验码换成界面上的话。bridge 那边同一套规则（checkGuestAgents、guest_name_required），单测见 tests/web-guest-share.test.ts。
 * 不碰 window / api：根目录 tsc 也会检查它（测试直接 import）。
 */
import type { ApiError } from "@/lib/api/client";

/** 给 guest 开放 "*" 时的提醒（发码前的二次确认、批准时的警告共用） */
export const GUEST_ALL_WARNING = "这等于开放全部非大总管 agent，以后新建的也算";
const NAME_HINT = "写一下是给谁的，比如「Alex 的手机」";

export type ShareOpts = { guest?: string; agents?: string[]; confirmAllAgents?: boolean };

/** grant 是不是「全部会话」（"*"）：给 guest 时要单独提醒 */
export function grantsAllAgents(grant: { agents: string[] | "*" }): boolean {
  return grant.agents === "*" || grant.agents.includes("*");
}

/**
 * 「给别人」的签码请求：名字、会话都要写明（bridge 同样拒：guest_name_required / guest_agents_required），
 * 选了「全部会话」还没确认过 = confirm（界面亮提醒、等第二次点）。error 是中文 key。
 */
export function guestShareOpts(name: string, picked: string[], confirmed: boolean): { opts: ShareOpts } | { error: string } | { confirm: true } {
  const guest = name.trim();
  if (!guest) return { error: NAME_HINT };
  if (!picked.length) return { error: "至少选一个会话" };
  if (!picked.includes("*")) return { opts: { guest, agents: picked } };
  return confirmed ? { opts: { guest, agents: ["*"], confirmAllAgents: true } } : { confirm: true };
}

/** 签码失败给用户看的文案（中文 key，渲染点 t()）：bridge 的校验码换成界面上的话，其它原样 */
export function shareCodeErrorText(e: unknown): string {
  const code = (e as ApiError)?.code;
  if (code === "guest_name_required") return NAME_HINT;
  if (code === "guest_agents_required") return "至少选一个会话";
  if (code === "guest_all_needs_confirm") return GUEST_ALL_WARNING;
  return (e as Error)?.message || "配对码生成失败";
}
