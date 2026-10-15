import { agentExtraSig } from "@/lib/chat/agents";
import type { AgentSession } from "./type";

/**
 * roster 变化指纹：捕获会影响渲染的字段（成员 + 状态 + 展示名 + 置顶/mock 标记
 * + busy/contextTokens/lastActivityTs）。轮询用它判断列表是否真的变了，只有变了
 * 才更新 state。⚠ 后三个易变字段必须入指纹——contextTokens 不入的话，compact 后
 * 轮询拉回的新值会被「列表没变」挡掉，ctx 徽章/用量面板永远停在压缩前的旧值
 *（2026-07-16 真机实锤）；busy/lastActivityTs 同理（黄点与时间标签靠轮询回落）。
 */
export function agentsSignature(list: AgentSession[]): string {
  return list
    .map(
      (a) =>
        `${a.name}${a.status}${a.displayName}${a.pinnedMaster ? 1 : 0}${a.mock ? 1 : 0}` +
        `${a.busy ? 1 : 0}${a.projectId ?? ""}${a.contextTokens ?? ""}${a.lastActivityTs ?? ""}${a.model ?? ""}${a.effort ?? ""}${a.unread ?? 0}${a.label ?? ""}${a.external ? 1 : 0}${a.sharedPeers ?? 0}` +
        `${a.chatGuard ? 1 : 0}${(a.sharedWith ?? []).join(",")}${agentExtraSig(a)}`
    )
    .join("");
}

/**
 * GET /projects 回包里随 roster 变的部分（成员名 / 状态 / 归属 / purpose，见 manager project-list）：只有它变了轮询才重拉 projects，
 * 忙闲、上下文、未读这些一拍一变的字段不算（SYN-2）。
 */
export function projectsSignature(list: AgentSession[]): string {
  return list.map((a) => `${a.name}\u0000${a.status}\u0000${a.projectId ?? ""}\u0000${a.purpose ?? ""}`).join("\u0001");
}
