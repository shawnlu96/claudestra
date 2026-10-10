"use client";
/** 数据源注入：团队视图在 CollabView 外面包一层 Provider；没包就是本机台账（team-source.ts 的 localCollabSource）。 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { localCollabSource, type CollabSource } from "./team-source";

export interface InjectedSource extends CollabSource {
  /** 团队特有的操作：taskId = null 放在「团队」标签里（feature 级），否则放在任务详情里；now 是 use-collab 的走表时钟（时效文案与卡片同钟） */
  ops?: (taskId: string | null, now?: number) => ReactNode;
  /** 用户点进子 DAG 的 feature（关掉传 null）：共享源据此优先拉它的详情；本机源没有 */
  focus?: (featureId: string | null) => void;
}

export const CollabSourceContext = createContext<InjectedSource | null>(null);

export function useCollabSource(project: string): InjectedSource {
  const injected = useContext(CollabSourceContext);
  return useMemo(() => injected ?? localCollabSource(project), [injected, project]);
}

/** 把当前打开的 feature 告诉注入的源；featureId 变 null 或卸载时传 null。本机源（没注入 / 没有 focus）什么都不做 */
export function useFocusFeature(project: string, featureId: string | null): void {
  const focus = useCollabSource(project).focus;
  useEffect(() => {
    if (!focus) return;
    focus(featureId);
    return () => focus(null);
  }, [focus, featureId]);
}
