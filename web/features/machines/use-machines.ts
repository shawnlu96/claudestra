"use client";
import { useEffect, useSyncExternalStore } from "react";
import { loadAppConfig, machineBase, type AppConfig } from "@/lib/app-config";
import { machines, type MachineHealth, type MachineRecord } from "@/lib/machines";

export interface MachinesSnapshot {
  list: MachineRecord[];
  current: MachineRecord | null;
  health: MachineHealth;
  /** 中继模式才有「多台机器」这回事；直托管永远一台 */
  multi: boolean;
}

let cfg: AppConfig | null = null;
const EMPTY: MachinesSnapshot = { list: [], current: null, health: "ok", multi: false };
let snap: MachinesSnapshot = EMPTY;

function recompute(): void {
  const current = machines.current();
  snap = { list: machines.all(), current, health: current ? machines.healthOf(current.fp) : "ok", multi: cfg?.mode === "relay" };
}
machines.subscribe(recompute);

/** 页面壳启动时调一次：拉配置、装机器清单、给 machines 注入基址算法（切机器时写给 SW / boot.js 的镜像用） */
let booted: Promise<AppConfig> | null = null;
export function bootMachines(): Promise<AppConfig> {
  booted ??= loadAppConfig().then(async (c) => {
    cfg = c;
    machines.setBaseResolver((fp) => machineBase(c, fp));
    await machines.load();
    recompute();
    return c;
  });
  return booted;
}

export function useMachines(): MachinesSnapshot {
  useEffect(() => {
    void bootMachines();
  }, []);
  return useSyncExternalStore((cb) => machines.subscribe(cb), () => snap, () => EMPTY);
}
