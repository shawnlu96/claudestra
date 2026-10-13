"use client";
import type { ReactNode } from "react";
import { asksStore, useAsks } from "@/features/asks/asks-store";
import { groupAsks } from "@/features/asks/asks-model";
import { splitTeamProject } from "@/features/asks/team-project-asks";
import type { SharedProjectsPort } from "@/lib/shared-projects-model";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { useLang } from "@/lib/i18n";

type ProjectCardsProps = { port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void> };

/**
 * 项目设置对话框底部的一行入口（UXASK2）：团队项目确认卡统一在全站收件箱（AsksDrawer）里作答，这里只数开着的几张、点了去抽屉定位第一张。
 * 数据读 asks store，不再自己轮询 /asks、不再自己作答；props 签名保留（projects-panel 挂载那行、夹具不动），但不读：port.cards / answer 不再调用。
 */
export const ProjectCards: (props: ProjectCardsProps) => ReactNode = () => {
  const { asks } = useAsks();
  const tr = sharedProjectsTr(useLang());
  const team = splitTeamProject(groupAsks(asks).waiting).team;
  return <section className="flex flex-wrap items-center gap-2 border-t border-base-300 pt-4" aria-label="项目确认卡">
    {team.length ? <>
      <p className="text-sm">{tr("有 {n} 张团队项目确认待你处理", { n: team.length })}</p>
      <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={() => asksStore.openDrawer(team[0]!.id)}>{tr("去处理")}</button>
    </> : <p className="text-sm opacity-60">{tr("暂无待确认的项目操作。")}</p>}
  </section>;
};
