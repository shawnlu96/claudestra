"use client";
import { isLegacySubdomain, type DirectConfig } from "@/lib/app-config";
import { nativeServerConfig } from "@/lib/native";

/**
 * 旧的子域名入口（https://<slug>.<中继>，中继 v2 的隧道）已废弃：bridge 直托管的页面经那条隧道打开时，换到新入口 https://<中继>。
 * iOS 壳里改壳的服务器地址——ServerConfig.set 会重建 WebView 从新地址加载；直接跳转会被壳当成站外、踢去系统浏览器。
 * 浏览器里整页跳到新入口的配对页。新入口是另一个网址，要重新配对一次（旧入口上的凭据带不过去）。
 */
/** 返回 true = 正在离开（调用方别再往下走） */
export async function leaveLegacySubdomain(cfg: DirectConfig): Promise<boolean> {
  if (!isLegacySubdomain(window.location.hostname, cfg.relayBase)) return false;
  const target = `https://${cfg.relayBase}`;
  const shell = nativeServerConfig();
  try {
    if (shell) await shell.set(target);
    else window.location.replace(`${target}/pair`);
    return true;
  } catch (e) {
    console.warn("[legacy-subdomain] 换到新入口失败，留在旧入口:", (e as Error).message);
    return false;
  }
}
