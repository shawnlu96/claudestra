"use client";
/** 数据源注入：团队视图在 CollabView 外面包一层 Provider；没包就是本机台账（team-source.ts 的 localCollabSource）。 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { localCollabSource, type CollabSource } from "./team-source";

export interface InjectedSource extends CollabSource {
  /** 团队特有的操作：taskId = null 放在「团队」标签里（feature 级），否则放在任务详情里 */
  ops?: (taskId: string | null) => ReactNode;
}

export const CollabSourceContext = createContext<InjectedSource | null>(null);

export function useCollabSource(project: string): InjectedSource {
  const injected = useContext(CollabSourceContext);
  return useMemo(() => injected ?? localCollabSource(project), [injected, project]);
}
