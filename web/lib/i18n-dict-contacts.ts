/** 侧栏联系人与输入框 @ 委托（features/chat/contacts-group.tsx、mention-layer.tsx、use-mention.ts）的字典条目，规则同 lib/i18n-dict.ts */
export const CONTACTS_DICT: Record<string, string> = {
  // peer 在线状态：Peer 面板与侧栏联系人共用
  "在线": "Online",
  "离线": "Offline",
  "每分钟检测一次": "checked every minute",
  "上次在线": "Last online",
  "联系人": "Contacts",
  "{n}/{total} 在线": "{n}/{total} online",
  "{ago}在线": "online {ago}",
  "{ago}来过": "visited {ago}",
  "单向": "one-way",
  "忙": "busy",
  "空闲": "idle",
  "本机": "local",
  "对方没有开放 agent 给你": "No agents shared with you",
  "单向连接：看不到对方开放了哪些 agent": "One-way link: can't see which agents they share",
  "发送时让 {me} 去找 {who}，并把回复带回来": "On send, {me} will contact {who} and bring back the reply",
  "取消转达": "Cancel delegation",
  "{name} 已经停止，没法转达": "{name} has stopped, can't relay",
  "{name} 已不在可联系的列表里（可能已撤销或改名），重新 @ 一次": "{name} is no longer reachable (access revoked or renamed) — @ it again",
};
