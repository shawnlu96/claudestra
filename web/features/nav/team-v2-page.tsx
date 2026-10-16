"use client";
/**
 * 新版「团队」页（NAVV2-SHELLA1 骨架）：挂 NAVBAR1 的团队页（团队项目、成员与位子、规划与提案），下面是资源 / 运行 / 消息三个插槽。
 */
import TeamMessagesSection from "./team-messages-section";
import TeamResourcesSection from "./team-resources-section";
import TeamRuntimeSection from "./team-runtime-section";
import { TeamPage } from "./team-page";
import type { V2PageProps } from "./nav-v2";

export function TeamV2Page(p: V2PageProps) {
  return (
    <div className={p.narrow ? undefined : "mx-auto w-full max-w-3xl"} data-v2-page="team">
      <TeamPage />
      <TeamResourcesSection {...p} />
      <TeamRuntimeSection {...p} />
      <TeamMessagesSection {...p} />
    </div>
  );
}
