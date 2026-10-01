"use client";
import { useLang } from "@/lib/i18n";

const WORDS: Record<string, string> = {
  "把我的电脑借给别人": "Lend my machine", "授权": "Grant", "收回": "Revoke", "重新授权": "Re-grant", "借出中的单": "Lent orders", "近期已结束": "Recently ended",
  "还没有授权": "No grants yet", "暂无借出的单": "No lent orders", "对象": "Peer", "仓库": "Repos", "名额": "Slots", "每日单数": "Orders / day",
  "到期": "Expires in", "角色": "Role", "审查": "Review", "写代码": "Write", "提交授权": "Grant access", "取消": "Cancel", "添加": "Add",
  "没有可授权的 peer": "No peer available", "等待": "Waiting", "在跑": "Running", "停止中": "Stopping", "停不下来": "Not stopping",
  "已停": "Stopped", "已交付": "Delivered", "开跑": "Started", "交付": "Delivered", "停止": "Stopped", "待补发": "Notice pending",
  "已到期": "Expired", "加载失败": "Failed to load", "打开会话": "Open session",
  "这会让发起方的任务在你的用户下随时起 shell": "This lets the requester's tasks start a shell as your user at any time",
};

export function useLendT() {
  const lang = useLang();
  return (text: string) => (lang === "zh" ? text : WORDS[text] ?? text);
}

/** 剩余时间：zh「6天23小时」/ en「6d 23h」；不足一小时显示分钟 */
export function useRemainingText() {
  const lang = useLang();
  return ({ d, h, m }: { d: number; h: number; m: number }) => {
    if (lang === "zh") return d ? `${d}天${h}小时` : h ? `${h}小时${m}分` : `${m}分`;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
}
