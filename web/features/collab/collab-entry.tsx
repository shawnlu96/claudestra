"use client";
import { SharedEntry } from "./dag/shared-navigation";
import { probe, cancelRetry, mounted } from "./dag/shared-entry-probe";
/**
 * 侧栏项目组里的「协作视图」入口（每个项目一个，放组内第一行）。
 * 出现前先真的读一次这个项目的台账总览：能读才显示（顺手把结果放进缓存，点开就有数据）；
 * 403（guest / 部分 scope）、404（老 bridge 没有台账接口或项目不在）不显示；网络错误先不显示，下次挂载再探。
 */
import { useEffect } from "react";
import { useCollabT } from "./collab-i18n";
import { useChatNav } from "../chat/components/nav-context";
import { useLedgerAccess } from "./collab-cache";
import { Icon } from "./collab-icons";
import { openCollab, useCollabNav } from "./collab-nav";

export function CollabEntry({ projectId }: { projectId: string }) {
  const t = useCollabT();
  const nav = useChatNav();
  const cur = useCollabNav();
  const access = useLedgerAccess(projectId);
  useEffect(() => {
    if (access !== "unknown") return; // 已经定了（能读 / 不能读）就不再探
    mounted.set(projectId, (mounted.get(projectId) ?? 0) + 1);
    probe(projectId);
    return () => {
      mounted.set(projectId, (mounted.get(projectId) ?? 1) - 1);
      cancelRetry(projectId);
    };
  }, [access, projectId]);
  if (access !== "yes") return <SharedEntry projectId={projectId} />;
  const on = cur.project === projectId;
  return (
    <><SharedEntry projectId={projectId} /><li>
      <button
        type="button"
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${
          on ? "bg-base-300 text-base-content" : "text-base-content/75 hover:bg-base-300/50 hover:text-base-content"
        }`}
        onClick={() => {
          openCollab(projectId);
          nav.toContent();
        }}
      >
        <Icon name="listTree" size={14} className="text-accent" />
        <span className="truncate font-medium">{t("协作视图")}</span>
      </button>
    </li></>
  );
}
