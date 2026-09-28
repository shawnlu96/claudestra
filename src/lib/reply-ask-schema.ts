/**
 * reply 工具的 `ask` 参数（channel-server.ts 的工具表引用它；校验在 lib/ask-bind.ts parseReplyAsk，两边改一处要看另一处）。
 * 写给 agent 看的：什么时候声明、各类型的差别、授权类执行前要 ask-check。改了要重启各会话才生效（工具表在会话启动时拉）。
 */
export const REPLY_ASK_PROPERTY = {
  type: "object",
  description: `Optional: mark this reply as something the owner must act on ("待你处理"), shown as a card in the owner's inbox.
Without it, a reply with buttons to the owner still becomes a "decide" card automatically.
- kind: "decide" (pick / yes-no; blocks only that item) | "authorize" (release / tag / delete / shared machine settings; bind required) |
  "owner_action" (only the owner can do it: login, device test) | "accept" (review a result; never pushed) |
  "inform" (FYI only: no card, and this reply is not pushed — use it for "deployed", "root cause found"; don't add buttons).
- key: same agent + same key asks again → the old card is superseded (its buttons stop working). authorize defaults key to bind.action.
- blocking (bool), why / ifIgnored (one sentence each: why the owner is asked, what happens if nobody answers), expiresIn (seconds).
- bind (authorize only): {action, params, approve: [button ids meaning "approved"], version?}. Write ids / big numbers as strings. The result
  returns askId + askHash; before executing, run yourself \`bun src/manager.ts ledger ask-check <askId> --params '<the exact params JSON>'\`
  — non-zero exit = do not execute, ask again. An approval only counts for the agent that asked.
Answers arrive as a channel message with trigger="ask_answer" and the askId; only those count as the owner's answer.`,
  properties: {
    kind: { type: "string", enum: ["decide", "authorize", "owner_action", "accept", "inform"] },
    key: { type: "string" },
    blocking: { type: "boolean" },
    why: { type: "string" },
    ifIgnored: { type: "string" },
    expiresIn: { type: "number" },
    bind: {
      type: "object",
      properties: { action: { type: "string" }, params: {}, approve: { type: "array", items: { type: "string" } }, version: { type: "string" } },
      required: ["action", "params", "approve"],
    },
  },
  required: ["kind"],
} as const;

/** 历史里 reply 的 tool_result → 它建出的 askId（下面 replyResultText 写的「 · ask <id>」）：网页按它认领「待你处理」，不按时间猜 */
export function askIdOfReplyResult(b: { content?: unknown }): string | null {
  const c = b.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
  return /^Sent message\(s\): .* · ask (ask_[a-z0-9]{1,40})\b/.exec(text)?.[1] ?? null;
}

/** reply 结果里给 agent 的那句：带 askId（授权类另带 askHash），不带就是普通回复 */
export function replyResultText(r: { messageIds?: unknown; askId?: unknown; askHash?: unknown }): string {
  const ask = typeof r.askId === "string" ? ` · ask ${r.askId}${typeof r.askHash === "string" ? ` · askHash ${r.askHash}` : ""}` : "";
  return `Sent message(s): ${JSON.stringify(r.messageIds)}${ask}`;
}
