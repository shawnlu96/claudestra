import type { AutostartSwitch } from "./scheduler-autostart.js";

/** 项目关了，或这个 feature 关了；featureId 为 null 的卡（不在任何 feature 下）只看项目 */
export function switchOff(sw: AutostartSwitch, featureId: string | null): string | null {
  if (sw.off) return `项目的自动开卡关着：${sw.off.reason}`;
  const f = featureId ? sw.features?.[featureId] : undefined;
  return f?.off ? `feature ${featureId} 的自动开卡关着：${f.reason}` : null;
}
