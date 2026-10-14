"use client";
import { SharedEntry } from "./dag/shared-navigation";
import { probe, cancelRetry, mounted, retryNow, useProbeFailed, useProbing } from "./dag/shared-entry-probe";
/**
 * 侧栏项目组里的「协作视图」入口（每个项目一个，放组内第一行）。
 * 出现前先真的读一次这个项目的台账总览（顺手把结果放进缓存，点开就有数据）：读的时候先占一个同高的灰条行，读到再换成正常行，
 * 下面的会话行不跳；403（guest / 部分 scope）、404（老 bridge 没有台账接口或项目不在）不显示；
 * 网络错误 / bridge 重启时出灰行 + 重试按钮，后台照旧按退避重探，点重试立刻再探（不叠第二条重探）。
 */
import { useEffect } from "react";
import { useLang } from "@/lib/i18n";
import { useCollabT } from "./collab-i18n";
import { entryText } from "./collab-entry-words";
import { useChatNav } from "../chat/components/nav-context";
import { useLedgerAccess } from "./collab-cache";
import { Icon } from "./collab-icons";
import { openCollab, useCollabNav } from "./collab-nav";

const ROW = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]";

/** team：打开的是团队中心键（team-view-entry.tsx 传），行尾多一个文字小标「团队」；本机项目不带 */
export function CollabEntry({ projectId, team = false }: { projectId: string; team?: boolean }) {
  const t = useCollabT();
  const nav = useChatNav();
  const cur = useCollabNav();
  const access = useLedgerAccess(projectId);
  const failed = useProbeFailed(projectId);
  useEffect(() => {
    if (access !== "unknown") return; // 已经定了（能读 / 不能读）就不再探
    mounted.set(projectId, (mounted.get(projectId) ?? 0) + 1);
    probe(projectId);
    return () => {
      const left = (mounted.get(projectId) ?? 1) - 1;
      mounted.set(projectId, left);
      if (!left) cancelRetry(projectId); // 同一项目还有别的入口挂着，就不撤它等着的那条重探
    };
  }, [access, projectId]);
  if (access === "unknown") return <><SharedEntry projectId={projectId} />{failed ? <FailedRow projectId={projectId} /> : <PendingRow />}</>;
  if (access !== "yes") return <SharedEntry projectId={projectId} />;
  const on = cur.project === projectId;
  return (
    <><SharedEntry projectId={projectId} /><li>
      <button
        type="button"
        data-collab-entry="ready"
        className={`${ROW} transition-colors ${
          on ? "bg-base-300 text-base-content" : "text-base-content/75 hover:bg-base-300/50 hover:text-base-content"
        }`}
        onClick={() => {
          openCollab(projectId);
          nav.toContent();
        }}
      >
        <Icon name="listTree" size={14} className="text-accent" />
        <span className="truncate font-medium">{t("协作视图")}</span>
        {team && <span data-collab-team-badge className="ml-auto shrink-0 rounded border border-base-300 px-1 text-[11px] leading-4 text-base-content/55">{t("团队")}</span>}
      </button>
    </li></>
  );
}

/** 探测中：和正常行同高（零宽字撑出同一行高），只有图标 + 一条闪动灰条，不写字、点不动 */
function PendingRow() {
  return <li aria-hidden="true" data-collab-entry="pending">
    <div className={ROW}>
      <Icon name="listTree" size={14} className="text-base-content/25" />
      <span className="h-3 w-16 animate-pulse rounded bg-base-content/15" />
      <span className="w-0">{"​"}</span>
    </div>
  </li>;
}

/** 读失败、正等重探：行变灰不能开，右边一个重试图标；在途时图标转（只用动效） */
function FailedRow({ projectId }: { projectId: string }) {
  const t = useCollabT();
  const lang = useLang();
  const busy = useProbing(projectId);
  const label = entryText(lang, "没读到，点一下重试");
  return <li data-collab-entry="failed">
    <div className={`${ROW} text-base-content/40`}>
      <Icon name="listTree" size={14} />
      <span className="truncate font-medium">{t("协作视图")}</span>
      <button type="button" aria-label={label} title={label} aria-busy={busy || undefined}
        className="-my-1 ml-auto shrink-0 rounded p-1 text-base-content/60 hover:bg-base-300/60 hover:text-base-content"
        onClick={() => retryNow(projectId)}>
        <Icon name="rotateCcw" size={14} className={busy ? "animate-spin" : undefined} />
      </button>
    </div>
  </li>;
}
