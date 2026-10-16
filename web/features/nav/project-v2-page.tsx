"use client";
/**
 * 新版「项目」入口页（NAVV2-SHELLA1 骨架）：挂原项目列表（NowProjectList，点一行照旧进协作视图）。
 * 单个项目的整页在 collab/project-v2-page.tsx（协作视图那一层里挂），两边不互相 import。
 */
import { NowProjectList } from "../now/now-projects";
import type { V2PageProps } from "./nav-v2";

export function ProjectsV2Page(p: V2PageProps) {
  return (
    <div className={p.narrow ? undefined : "@container mx-auto w-full max-w-3xl"} data-v2-page="projects">
      <NowProjectList fold={false} />
    </div>
  );
}
