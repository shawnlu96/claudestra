"use client";
import { createContext, useContext } from "react";

/**
 * 「正在为导出渲染」的开关（分享 → 导出 HTML / PDF）。导出树复用会话里的同一套消息组件，
 * 只在几处按此开关改行为：旁白强制展开、不渲染收起条；💭 进度句不渲染；不播入场动画。
 * 工具卡本来就默认折叠，不用管。
 */
export const ExportContext = createContext(false);

export function useIsExport(): boolean {
  return useContext(ExportContext);
}
