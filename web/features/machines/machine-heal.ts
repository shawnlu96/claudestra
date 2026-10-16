import { LOCAL_FP } from "@/lib/app-config";
import { pickCurrent, type MachineRecord } from "@/lib/machines";

/**
 * 中继模式自愈（peer-WEBLOCAL1）：老前端首次读配置遇到网络错误被当成 direct，写进了一条 LOCAL_FP 并设成当前机器，
 * 之后拿到 relay 配置也一直拼 `/m/local` → 中继回 machine_unknown。中继托管的源上 LOCAL_FP 永远不是真机器。
 *   keep   = 当前不是 LOCAL_FP，照常；
 *   switch = 删掉 LOCAL_FP，切到其余机器里 pickCurrent 选出的那台；
 *   pair   = 删掉 LOCAL_FP 后一台都不剩，去 /pair。
 * 只在 relay 分支调用：direct 模式（bridge 直托管 / 回环）的本机记录就是 LOCAL_FP 或真 fp，不归这里管。
 */
export type RelayHealPlan = { action: "keep" } | { action: "switch"; drop: string; to: string } | { action: "pair"; drop: string };

/** 纯函数（tests/web-machine-heal.test.ts） */
export function planRelayHeal(list: MachineRecord[], currentFp: string | null): RelayHealPlan {
  if (currentFp !== LOCAL_FP) return { action: "keep" };
  const next = pickCurrent(
    list.filter((m) => m.fp !== LOCAL_FP),
    null,
  );
  return next ? { action: "switch", drop: LOCAL_FP, to: next.fp } : { action: "pair", drop: LOCAL_FP };
}
