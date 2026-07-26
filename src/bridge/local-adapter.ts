/**
 * Web-only: Local ChatAdapter —— 无 Discord 模式下的会话地址供给 + 出站落空。
 *
 * 设计（对齐 upstream docs/design-multi-frontend.md §3.3 的「纯 API agent =
 * 一个返回虚拟地址的 provisioner，create 流程零改动」预留）：
 *
 * - provisionConversation → 返回 `local-<uuid>` 合成 channelId。manager create
 *   经 bridge ws `create_channel` 走到这里，registry / clients / pending 全部
 *   把它当不透明字符串用，核心零改动。
 * - send / edit / typing → no-op。Web 前端不消费 adapter 出站：实时内容走
 *   event-bus 的 SSE（chat_message / assistant_text / tool_* 事件在核心统一
 *   发射，与 adapter 无关），历史走只读历史 API。
 * - provisionThread → 返回 `local-thr-<uuid>`，让 bg-activity-watcher 在
 *   web-only 下也能跑（它 provisionThread 拿地址后 send 流水 → 这里落空，
 *   但 bg_task_* 事件照发，web 端靠事件渲染任务行）。
 *
 * parseChatId 对 `local-` 前缀返回 transport "local"（router.ts fork 补丁），
 * deliverToUser 按 transport 分发到这里。Discord 模式下本 adapter 也注册着，
 * 但没有 local-* 地址流通时永远不会被命中，无副作用。
 */

import type { ChatAdapter, NeutralMessage } from "./adapters.js";

export function createLocalChatAdapter(): ChatAdapter {
  return {
    transport: "local",
    caps: {
      maxTextLen: 1_000_000, // 无平台面，不分块
      buttons: false,
      edit: false,
      files: false,
      typing: false,
    },

    async send(_destId: string, _msg: NeutralMessage): Promise<{ messageIds: string[] }> {
      // 出站落空：web 前端从 /events SSE + 历史 API 拿内容
      return { messageIds: [] };
    },

    async provisionConversation(_name: string): Promise<{ chatId: string }> {
      return { chatId: `local-${crypto.randomUUID()}` };
    },

    async provisionThread(_parentChatId: string, _title: string): Promise<{ chatId: string }> {
      return { chatId: `local-thr-${crypto.randomUUID()}` };
    },

    async archiveThread(_chatId: string): Promise<void> {
      /* no-op */
    },
  };
}
