/**
 * Codex「免费额度重置」那一行的「使用」按钮（bridge POST /api/v1/quota/codex/reset-credit，真实消费、不可逆）：
 * 按钮能不能点、为什么不能点，以及结果的人话。纯函数；文案是 zh 原文，组件里再过 t()。单测 tests/web-quota-view.test.ts。
 * bridge 在发之前还会用现拉的数据再核对一遍，这里的判断只决定按钮状态，不是唯一的闸。
 */
import { fmtAt, reasonText, type EntryView } from "./quota-view";

export type ResetAction =
  | { enabled: true; key: string; at: number | null }
  | { enabled: false; why: string };

/** 只有 Codex 账户卡、持有 ≥ 1 才出这一行的按钮；此刻可用为 0 时置灰并写原因（原因取数据里给的 limitReached） */
export function codexResetAction(e: EntryView): ResetAction | null {
  const c = e.resetCredits;
  if (e.id !== "codex" || !c || c.ineligibleReason || c.held <= 0) return null;
  if (c.applicableNow < 1) {
    return { enabled: false, why: c.limitReached === false ? "额度还没到上限，现在不需要重置" : "接口说此刻没有能用的卡" };
  }
  // 默认最早到期的那张（bridge 已按到期排好）；明细没拿到就不知道用的是哪张、何时到期，不让点
  const first = c.expiries?.find((x) => x.key !== null);
  if (!first?.key) return { enabled: false, why: "重置卡明细还没拿到，稍后再试" };
  return { enabled: true, key: first.key, at: first.at };
}

/** 二次确认里那句话的参数：到期时间按本机时区 */
export function resetConfirmParams(a: Extract<ResetAction, { enabled: true }>): { key: string; params: Record<string, string> } {
  return a.at === null
    ? { key: "会消耗 1 次重置卡（无截止日），不可撤销。确定使用？", params: {} }
    : { key: "会消耗 1 次重置卡（{at} 到期），不可撤销。确定使用？", params: { at: fmtAt(a.at) } };
}

export interface ResetOutcome {
  tone: "success" | "info" | "error";
  key: string;
  params: Record<string, string>;
}

const DONE: Record<string, Omit<ResetOutcome, "params">> = {
  reset: { tone: "success", key: "已使用 1 次重置，额度已补满" },
  already_redeemed: { tone: "success", key: "已使用 1 次重置，额度已补满" },
  nothing_to_reset: { tone: "info", key: "接口说现在不需要重置，没有扣卡" },
  no_credit: { tone: "info", key: "这张卡已经不能用了，没有扣卡" },
};

const REFUSED: Record<string, string> = {
  not_applicable: "此刻没有可用的卡，没有发出使用请求",
  credit_unavailable: "这张卡已不在可用列表里，没有发出使用请求",
  disabled: "实时读取已关闭（或刚被关过），没有发出使用请求",
  identity_changed: "账号或登录凭据刚变过，没有发出使用请求；刷新后重新确认",
};

const out = (tone: ResetOutcome["tone"], key: string, params: Record<string, string> = {}): ResetOutcome => ({ tone, key, params });

/**
 * POST 的结果 → 一句话。status = HTTP 状态（请求根本没回来 = 0）；body = 响应体（{ ok, result }）。
 * 没拿到答复的一律说「扣没扣以刷新后的数字为准」：请求可能已经到了上游，不能报成「没扣」。
 */
export function resetOutcome(status: number, body: unknown): ResetOutcome {
  if (status === 409) return out("info", "已有一个使用请求在进行中");
  if (status === 403) return out("error", "需要 owner 本人的设备才能使用重置卡");
  const r = (body && typeof body === "object" ? (body as { result?: unknown }).result : null) as { status?: unknown; code?: unknown } | null;
  const code = typeof r?.code === "string" ? r.code : "";
  if (status === 200 && r?.status === "done" && DONE[code]) return { ...DONE[code], params: {} };
  if (status === 200 && r?.status === "refused") {
    return REFUSED[code] ? out("info", REFUSED[code]) : out("error", "核对数据失败（{why}），没有发出使用请求", { why: reasonText(code) ?? code });
  }
  if (status === 200 && r?.status === "failed") return out("error", "使用请求没拿到确切答复（{why}），扣没扣以刷新后的数字为准", { why: reasonText(code) ?? code });
  return out("error", "请求没完成，扣没扣以刷新后的数字为准");
}
