/**
 * 「待你处理」的推送规则（docs 13 §4.5 + 附录 owner 拍板）：只有卡活的才推；验收类、知会类不推；owner 正在用就不推，改发 SSE 由网页弹横幅。
 * 急的不管在不在都推一次。同一条 ask 最多推一次由调用方（dispatcher.onAsk）记。iOS 规矩：推了就必须显示，所以「不打扰」只能是不推。
 * 规则表逐行单测：tests/ask-push.test.ts。
 */
import { t } from "./i18n.js";
import type { Ask } from "./ledger-asks.js";
import type { Presence } from "./owner-presence.js";

export type AskPushDecision = "push" | "banner" | "none";

export function askPushDecision(a: Pick<Ask, "state" | "kind" | "blocking" | "urgency">, presence: Presence): AskPushDecision {
  if (a.state !== "open" || a.kind === "accept" || a.blocking !== true) return "none";
  if (a.urgency === "urgent" || presence === "away") return "push";
  return "banner";
}

/** 推送内容：标题「待你处理 · <agent>」，点开直达卡片；tag 每条 ask 一个（同 tag 在 iOS 上是静默替换） */
export function askPushMessage(a: Pick<Ask, "id" | "fromAgent" | "title">): { title: string; body: string; url: string; tag: string } {
  return { title: `${t("待你处理", "Needs you")} · ${a.fromAgent}`, body: a.title, url: `/chat?ask=${encodeURIComponent(a.id)}`, tag: `cstra-ask-${a.id}` };
}
