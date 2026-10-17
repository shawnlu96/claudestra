"use client";
/**
 * 新版单个项目页（NAVV2-SHELLA1 骨架）：协作视图那一层（collab-switch.tsx）在 navV2 开着时用它包住原内容。
 * progress = 原项目进度 / 协作视图（SharedCollabContent，原样挂），后面依次是协作图、更多、任务三个插槽。
 * 外层 display: contents：插槽都还空着时布局与旧版逐像素一致，原内容照旧是协作层 flex 行里的那一格。
 */
import type { ReactNode } from "react";
import type { V2PageProps } from "../nav/nav-v2";
import ProjectGraphSection from "./project-graph-section";
import ProjectMoreSection from "./project-more-section";
import ProjectTaskSection from "./project-task-section";

export function ProjectV2Page({ progress, ...p }: V2PageProps & { progress: ReactNode }) {
  return (
    <div className="contents" data-v2-page="project" data-v2-project={p.project ?? undefined}>
      {progress}
      <ProjectGraphSection {...p} />
      <ProjectMoreSection {...p} />
      <ProjectTaskSection {...p} />
    </div>
  );
}
