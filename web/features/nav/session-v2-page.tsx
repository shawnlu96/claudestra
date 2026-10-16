"use client";
/**
 * 新版「会话」页（NAVV2-SHELLA1 骨架）：会话与项目永久平级，「会话」就是原侧栏标题、搜索与列表 + 原会话主区（页头返回 / 更多、正文、输入框），
 * 宿主不盖这一层、也不另画列表（注册表 covers = false），所以这里没有内容；草稿、滚动、来源机器都留在原组件里不丢。
 */
import type { V2PageProps } from "./nav-v2";

export function SessionV2Page(p: V2PageProps): null {
  void p;
  return null;
}
