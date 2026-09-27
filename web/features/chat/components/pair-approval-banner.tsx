"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { listApprovals, type PendingApproval } from "@/lib/api/devices";
import { APPROVALS_CHANGED, ApprovalRow } from "./pair-share";

const POLL_MS = 10_000;

/**
 * 侧栏顶部的「有设备请求配对」横幅：有人在配对页手输了短码（不管码是网页还是终端 claudestra pair 发的），
 * 在任何一台有管理权限的设备上都能直接允许 / 拒绝，不用回电脑终端。页面可见时每 10 秒看一次；
 * 没有管理权限（403）就停，不再问。
 */
export function PairApprovalBanner() {
  const t = useT();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (stop || document.visibilityState !== "visible") return;
      listApprovals()
        .then(({ approvals }) => !stop && setPending(approvals))
        .catch((e: Error & { status?: number }) => {
          if (e.status === 403 || e.status === 404) {
            stop = true; // 没有管理权限 / 旧 bridge 没这个端点：这台设备不负责批准
            clearInterval(iv);
          } else console.warn("[pair] 查待确认失败，下一拍再试:", e.message);
        });
    };
    tick();
    const iv = setInterval(tick, POLL_MS); // tick 里只在异步 catch 中用到 iv，那时它早已赋值
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(APPROVALS_CHANGED, tick);
    return () => {
      stop = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(APPROVALS_CHANGED, tick);
    };
  }, []);
  if (pending.length === 0) return null;
  return (
    <div className="mx-4 mb-2 flex flex-col gap-1.5" role="status" aria-label={t("有设备请求配对")}>
      {pending.map((a) => (
        <ApprovalRow key={a.id} a={a} onDone={() => setPending((xs) => xs.filter((x) => x.id !== a.id))} />
      ))}
    </div>
  );
}
