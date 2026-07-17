"use client";
import { useEffect, useState } from "react";
import { pushSupported, getPushSubscription, enablePush } from "@/lib/push/client";
import { useT } from "@/lib/i18n";

/**
 * 「开启推送」引导横幅(owner 2026-07-16:「pwa 不能引导用户允许推送权限么」)。
 * 与 InstallBanner 同款形态。浏览器规定权限弹窗必须由用户手势触发——引导条
 * 给按钮,点了才 requestPermission。
 * 显示条件:支持推送(iOS 非主屏时 PushManager 不存在 → 自然不显示,与安装
 * 引导互斥)&& 没问过权限(default)&& 未订阅 && 没被「不再提示」。
 * permission=denied 不显示(弹了也没用,设置页开关那里给指引)。
 */
export function PushBanner() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("cstra_push_prompt_dismissed")) return;
    } catch {
      return;
    }
    if (!pushSupported() || Notification.permission !== "default") return;
    void getPushSubscription().then((sub) => {
      if (!sub) setShow(true);
    });
  }, []);

  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem("cstra_push_prompt_dismissed", "1");
    } catch {
      /* 隐私模式 */
    }
  };

  return (
    <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/[0.07] px-3 py-2.5 text-xs">
      <span className="text-base leading-none">🔔</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("开启推送通知")}</div>
        <div className="mt-0.5 leading-relaxed text-base-content/60">
          {t("Web 端发起的对话有回复时通知你(页面开着时不打扰)")}
        </div>
        {msg && <div className="mt-1 text-warning">{t(msg)}</div>}
        <button
          className="btn btn-primary btn-xs mt-1.5"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void enablePush().then((r) => {
              setBusy(false);
              if (r.ok) {
                setShow(false); // 已订阅,条件不再成立,无需记 dismissed
              } else {
                setMsg(r.msg);
              }
            });
          }}
        >
          {busy && <span className="loading loading-spinner loading-xs" />}
          {t("开启")}
        </button>
      </div>
      <button className="shrink-0 px-1 opacity-40 hover:opacity-80" aria-label={t("不再提示")} onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
