/** peer 联系人（Peer 按钮摘要 / Peer 面板忙闲，features/chat/components/contacts-lines.tsx）与输入框 @ 委托（mention-layer.tsx、use-mention.ts）的字典条目，规则同 lib/i18n-dict.ts */
export const CONTACTS_DICT: Record<string, string> = {
  // peer 在线状态：Peer 面板与 Peer 按钮摘要共用
  "在线": "Online",
  "离线": "Offline",
  "每分钟检测一次": "checked every minute",
  "上次在线": "Last online",
  "{n}/{total} 在线": "{n}/{total} online",
  "忙": "busy",
  "空闲": "idle",
  "本机": "local",
  "发送时让 {me} 去找 {who}，并把回复带回来": "On send, {me} will contact {who} and bring back the reply",
  "取消转达": "Cancel delegation",
  "{name} 已经停止，没法转达": "{name} has stopped, can't relay",
  "{name} 已不在可联系的列表里（可能已撤销或改名），重新 @ 一次": "{name} is no longer reachable (access revoked or renamed) — @ it again",
  // Peer 面板 scope 勾选器里就地开闸（peers-shared.tsx ScopePicker）
  "开启后可共享给 peer；对方能看到该会话的全部上下文。关闭请到会话详情。": "When on, this session can be shared with peers, who then see its whole context. Turn it off from session details.",
  "开闸": "Turn on",
};
