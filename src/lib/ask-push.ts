/**
 * 「待你处理」的推送规则（docs 13 §4.5 + 附录 owner 拍板 + T11b）：分 owner 和指派对象两路。owner：只有卡活的才推；验收类不推（知会类不建 ask）；
 * owner 正在用就不推，改发 SSE 由网页弹横幅；急的不管在不在都推一次。指派对象：指给他的开出时推、指派事项过期推。
 * 同一条 ask 每个状态最多推一次由调用方（dispatcher.onAsk）记。iOS 规矩：推了就必须显示，所以「不打扰」只能是不推。
 * 规则表逐行单测：tests/ask-push.test.ts。
 */
import { t } from "./i18n.js";
import type { Ask } from "./ledger-asks.js";
import type { Presence } from "./owner-presence.js";

export type AskPushDecision = "push" | "banner" | "none";

/** owner 那一路：卡活才推；急的或 owner 不在推，在就只弹横幅。指派事项开出时 owner 不是办事的人，不推；过期时要推（T28 §2.5 第 7 行） */
export function askPushDecision(a: Pick<Ask, "state" | "kind" | "blocking" | "urgency">, presence: Presence): AskPushDecision {
  if (a.kind === "assigned") return a.state === "expired" ? "push" : "none";
  if (a.state !== "open" || a.kind === "accept" || a.blocking !== true) return "none";
  if (a.urgency === "urgent" || presence === "away") return "push";
  return "banner";
}

/** 指派对象那一路：指给某个人的，开出时推给他；指派事项过期也推给他（他在不在我们不知道，一条最多推一次） */
export function askPushToAssignee(a: Pick<Ask, "state" | "kind" | "assignee">): boolean {
  if (!a.assignee?.startsWith("local:")) return false;
  return a.state === "open" || (a.kind === "assigned" && a.state === "expired");
}

/** 推送内容：标题「待你处理 · <谁发的>」（过期「已过期 · …」），点开直达卡片；tag 每条 ask 每个状态一个（同 tag 在 iOS 上是静默替换） */
export function askPushMessage(a: Pick<Ask, "id" | "fromAgent" | "title" | "state" | "kind">): { title: string; body: string; url: string; tag: string } {
  const who = a.fromAgent ?? (a.kind === "assigned" ? t("指派", "Assigned") : t("审核", "Review"));
  const head = a.state === "expired" ? t("已过期", "Expired") : t("待你处理", "Needs you");
  return { title: `${head} · ${who}`, body: a.title, url: `/chat?ask=${encodeURIComponent(a.id)}`, tag: `cstra-ask-${a.id}-${a.state}` };
}
