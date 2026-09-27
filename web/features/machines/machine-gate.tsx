"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LOCAL_FP } from "@/lib/app-config";
import { machines } from "@/lib/machines";
import { useT } from "@/lib/i18n";
import { bootMachines, useMachines } from "./use-machines";

/**
 * /chat 的门：配置与机器清单就位后才渲染应用（否则 store 一开机就打没有基址的请求）。
 *   direct → 这台 bridge 就是唯一机器，没记录就补一条（名字用 app-config 的 machineName）；
 *   relay  → 一台机器都没有就去 /pair。
 * 当前机器的凭据被拒（401 device_invalid）时压一条「重新配对」横幅，不清机器、不整页跳转——别的机器还能用。
 */
export function MachineGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    void bootMachines().then(async (cfg) => {
      if (cfg.mode === "direct") {
        const fp = cfg.fp || LOCAL_FP;
        if (!machines.get(fp)) await machines.add({ fp, name: cfg.machineName });
        if (machines.currentFp() !== fp) await machines.setCurrent(fp);
      } else if (!machines.currentFp()) {
        // 带上来处：/join#<邀请码> 这类页面配完机器要回来（# 只在浏览器里，一起带走）
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        router.replace(here === "/chat" ? "/pair" : `/pair?next=${encodeURIComponent(here)}`);
        return;
      }
      if (!dead) setReady(true);
    });
    return () => {
      dead = true;
    };
  }, [router]);
  if (!ready) return <div className="fixed inset-0 bg-base-100" aria-hidden />;
  return (
    <>
      {children}
      <RepairBanner />
    </>
  );
}

/** 凭据失效横幅（z 高于启动页）：点去 /pair，配对成功回来即恢复 */
function RepairBanner() {
  const t = useT();
  const { current, health } = useMachines();
  if (!current || health !== "repair") return null;
  return (
    <div className="fixed inset-x-0 z-[70] flex justify-center px-4" style={{ top: "calc(env(safe-area-inset-top) + 8px)" }}>
      <Link
        href={`/pair?fp=${encodeURIComponent(current.fp)}`}
        className="flex items-center gap-2 rounded-full bg-warning px-4 py-1.5 text-[12.5px] font-semibold text-warning-content shadow-lg"
      >
        🔑 {t("这台机器的配对已失效 · 点按重新配对")}
      </Link>
    </div>
  );
}
