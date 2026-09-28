"use client";
/**
 * 侧栏项目组里的「协作视图」入口（每个项目一个，放组内第一行）。
 * 出现前先真的读一次这个项目的台账总览：能读才显示（顺手把结果放进缓存，点开就有数据）；
 * 403（guest / 部分 scope）、404（老 bridge 没有台账接口或项目不在）不显示；网络错误先不显示，下次挂载再探。
 */
import { useEffect } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchLedger } from "@/lib/api/ledger";
import { useT } from "@/lib/i18n";
import { useChatNav } from "../chat/components/nav-context";
import { cacheOverview, setLedgerAccess, useLedgerAccess } from "./collab-cache";
import { Icon } from "./collab-icons";
import { openCollab, useCollabNav } from "./collab-nav";

const probing = new Set<string>();
const retryMs = new Map<string, number>();
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 60_000;

/** 读一次总览定入口去留；网络 / bridge 重启这类临时失败按 10s → 60s 退避重探，只在第一次失败时打一行日志 */
function probe(project: string) {
  if (probing.has(project)) return;
  probing.add(project);
  fetchLedger(project)
    .then((ov) => {
      retryMs.delete(project);
      cacheOverview(project, ov, ov.now - Date.now());
    })
    .catch((e) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return setLedgerAccess(project, "no");
      const wait = retryMs.get(project);
      if (wait === undefined) console.warn(`[collab] 探测台账 ${project} 失败，入口先不显示、稍后重试：${(e as Error).message}`);
      const next = Math.min((wait ?? RETRY_MIN_MS / 2) * 2, RETRY_MAX_MS);
      retryMs.set(project, next);
      setTimeout(() => probe(project), next);
    })
    .finally(() => probing.delete(project));
}

export function CollabEntry({ projectId }: { projectId: string }) {
  const t = useT();
  const nav = useChatNav();
  const cur = useCollabNav();
  const access = useLedgerAccess(projectId);
  useEffect(() => {
    if (access === "unknown") probe(projectId);
  }, [access, projectId]);
  if (access !== "yes") return null;
  const on = cur.project === projectId;
  return (
    <li>
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
    </li>
  );
}
