/**
 * 前端 → 当前机器 client.log 的唯一打点出口（fire-and-forget）。
 * iOS 上看不到 console，「收不到消息」「点了没反应」这类事故只能对这份时间线取证；调用方自己加 [shell]/[pwa] 之类的前缀。
 * 基址取 machines 的 localStorage 镜像（public/boot.js 在 React 之前也用同一个键打点）。
 */
import { devEventFromLog } from "@/features/devtools/dev-events";
import { API_BASE_LS_KEY } from "@/lib/machines";
import { postClientLogLine } from "@/lib/api/system";

function apiBase(): string {
  try {
    return localStorage.getItem(API_BASE_LS_KEY) ?? "";
  } catch {
    return ""; // 隐私模式：按直托管同源打，打不到就丢
  }
}

export function postClientLog(msg: string): void {
  // 开发者模式的面板事件列表读同一份打点(features/devtools),关着时只是进个环形缓冲
  devEventFromLog(msg);
  postClientLogLine(apiBase(), msg);
}
