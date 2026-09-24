/**
 * 外源入站消息的来源标签解析（纯函数；渲染在 components/source-header.tsx）。
 * `from` 由 bridge 起名，两条路径两种写法（owner 2026-09-24 问「为何名字不同」）：
 *  - `peer-<token名>`：对方 bridge 拿我们签的 token 主动调 /api/v1 → 按 token principal 标 → 「通知」
 *  - `peer <peer名>/<agent>`：我们 send_to_agent 外呼后对方的 reply 由 http-peer.ts 推回 → 「回复」
 *  - `agent-<x>` / `<x>(agent)`：本地别的 agent；其余是 Discord / 其它 token 的真人用户。
 * 单测见 tests/web-source-label.test.ts。
 */
export type SourceKind = "peer-notify" | "peer-reply" | "agent" | "user";

export interface SourceLabel {
  kind: SourceKind;
  /** 去掉路径前缀后的显示名 */
  name: string;
  /** 只有 peer 两种带 badge（中文 key，渲染时过 t()） */
  badge?: "通知" | "回复";
}

export function parseSource(from: string): SourceLabel {
  if (from.startsWith("peer-")) return { kind: "peer-notify", name: from.slice(5), badge: "通知" };
  if (from.startsWith("peer ")) return { kind: "peer-reply", name: from.slice(5), badge: "回复" };
  if (from.startsWith("agent-")) return { kind: "agent", name: from.slice(6) };
  if (from.endsWith("(agent)")) return { kind: "agent", name: from.slice(0, -7).trim() };
  return { kind: "user", name: from };
}
