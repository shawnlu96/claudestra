"use client";
import { useEffect, useState } from "react";
import { CLIENT_COMMIT, CLIENT_VERSION, CLIENT_WEB_COMMIT } from "@/lib/build-info";
import { fetchMachineVersion, fetchVersion } from "@/lib/api/version";
import { bundleStale, clientTooOld, machineTooOld } from "@/lib/version-check";

export interface VersionVerdict {
  /** 托管方已发布更新的 bundle：值是服务端那个 commit（刷新时做 cache-busting） */
  stale: string | null;
  /** 当前机器的 bridge 太老，前端跟它说不上话 */
  machineOld: boolean;
}
const NONE: VersionVerdict = { stale: null, machineOld: false };

/**
 * 回到前台时查一次（每次最多 60s 一查）：bundle 是否滞后（直托管问 bridge，中继看 app-config）、机器是否太老 / 是否要求更新的前端。
 * 机器要求 minClient 比本 bundle 新也算 stale（刷新即拿到托管方的新前端）。
 */
export function useVersionCheck(enabled: boolean): VersionVerdict {
  const [v, setV] = useState<VersionVerdict>(NONE);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastCheck = 0;
    const client = { commit: CLIENT_COMMIT, webCommit: CLIENT_WEB_COMMIT, version: CLIENT_VERSION };
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void Promise.all([fetchVersion().catch(() => null), fetchMachineVersion().catch(() => null)]).then(([host, machine]) => {
        if (!alive) return;
        const stale = bundleStale(host, client) ?? (clientTooOld(machine, client.version) ? machine?.minClient ?? null : null);
        setV({ stale, machineOld: machineTooOld(machine) });
      });
    };
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, [enabled]);
  return v;
}
