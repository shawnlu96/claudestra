import type { AutostartSwitch } from "./scheduler-autostart.js";

/** 项目关了，或这个 feature 关了；featureId 为 null 的卡（不在任何 feature 下）只看项目。后定为准：项目关之后单独打开的 feature 仍算开 */
export function switchOff(sw: AutostartSwitch, featureId: string | null): string | null {
  const f = featureId ? sw.features?.[featureId] : undefined;
  if (sw.off && !(f && !f.off && f.at > sw.off.at)) return `项目的自动开卡关着：${sw.off.reason}`;
  return f?.off ? `feature ${featureId} 的自动开卡关着：${f.reason}` : null;
}
