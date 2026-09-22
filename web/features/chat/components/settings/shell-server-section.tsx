"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { nativeServerConfig } from "@/lib/native";
import { Section } from "./section";

/**
 * v2.21.3+ 原生壳的服务器地址(存在手机本机,不编进包——owner 2026-09-04 壳要分发给别人):
 * 显示当前地址 + 两步确认更换。独立组件:随设置面板打开而挂载,关掉即卸载,armed 态自然复位。
 */
export function ShellServerSection() {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const cfg = nativeServerConfig();
    if (!cfg) return;
    let dead = false;
    cfg.get().then((u) => { if (!dead) setUrl(u); }).catch(() => {});
    return () => { dead = true; };
  }, []);
  return (
    <Section
      title={t("App 连接的服务器")}
      desc={url || t("(读取中…)")}
      aside={
        armed ? (
          <div className="join">
            <button
              className="btn btn-error btn-sm join-item"
              onClick={() => {
                // clear 后原生侧重建 WebView 回到首次设置页,这里不会再有回调
                void nativeServerConfig()?.clear();
              }}
            >
              {t("确认更换")}
            </button>
            <button className="btn btn-ghost btn-sm join-item border-base-300" onClick={() => setArmed(false)}>
              {t("取消")}
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm border-base-300" onClick={() => setArmed(true)}>
            {t("更换服务器")}
          </button>
        )
      }
    />
  );
}
