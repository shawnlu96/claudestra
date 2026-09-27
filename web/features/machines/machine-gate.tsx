"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LOCAL_FP } from "@/lib/app-config";
import { ensureDirectCredential } from "@/lib/api/devices";
import { machines } from "@/lib/machines";
import { isLoopbackHost } from "@/lib/pairing";
import { useT } from "@/lib/i18n";
import { bootMachines, useMachines } from "./use-machines";
import { dismissLocalHop, hopToLocal, maybeHopToLocal, receiveHandoff, useLocalHopBanner } from "./local-hop";

/**
 * /chat 的门：配置与机器清单就位后才渲染应用（否则 store 一开机就打没有基址的请求）。
 *   direct → 这台 bridge 就是唯一机器，没记录就补一条（名字用 app-config 的 machineName）；凭据自动备好，收中继页面交过来的偏好；
 *   relay  → 一台机器都没有就去 /pair；渲染后探一次「是不是就在这台电脑上」，是就切到本机直连（local-hop.ts）。
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
        const ok = await ensureDirectCredential(fp, isLoopbackHost(window.location.hostname));
        if (ok && (await receiveHandoff())) return; // 带着中继那边的偏好过来：写入后整页重载一次
      } else if (!machines.currentFp()) {
        // 带上来处：/join#<邀请码> 这类页面配完机器要回来（# 只在浏览器里，一起带走）
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        router.replace(here === "/chat" ? "/pair" : `/pair?next=${encodeURIComponent(here)}`);
        return;
      } else {
        // 通知冷启动带来的 ?fp=（sw.js）：先切到发通知的那台机器，chat 再按 ?agent= 开会话；不认识的 fp 忽略
        const want = new URLSearchParams(window.location.search).get("fp");
        if (want && machines.get(want) && machines.currentFp() !== want) await machines.setCurrent(want);
        const fp = machines.currentFp();
        if (fp) void maybeHopToLocal(fp);
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
      <LocalHopBanner />
    </>
  );
}

/** 中继页面探不通本机（Safari 拦、授权被拒）但中继说同网时：给一个手动切到本机直连的入口，可永久关掉 */
function LocalHopBanner() {
  const t = useT();
  const hop = useLocalHopBanner();
  const { current } = useMachines();
  if (!hop || !current) return null;
  return (
    <div className="fixed inset-x-0 z-[69] flex justify-center px-4" style={{ bottom: "calc(env(safe-area-inset-bottom) + 12px)" }}>
      <div className="flex items-center gap-1 rounded-full bg-info py-1 pl-4 pr-1 text-[12.5px] font-semibold text-info-content shadow-lg">
        <button type="button" onClick={() => void hopToLocal(hop.port)}>
          🖥 {t("在这台电脑上？切到本机直连")} · {current.name}
        </button>
        <button type="button" aria-label={t("关闭")} className="btn btn-circle btn-ghost btn-xs" onClick={dismissLocalHop}>
          ✕
        </button>
      </div>
    </div>
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
