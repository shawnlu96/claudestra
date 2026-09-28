"use client";
/**
 * 侧栏项目组里的「协作视图」入口（每个项目一个，放组内第一行）。
 * 只在 bridge 报了 ledger 能力时出现；读台账被拒过（403：不是全 scope 的 owner 设备）就在本页收起，不留一个点了没用的入口。
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useChatNav } from "../chat/components/nav-context";
import { Icon } from "./collab-icons";
import { openCollab, useCollabNav } from "./collab-nav";

type Access = "unknown" | "yes" | "no";
let access: Access = "unknown";
let probing = false;
const subs = new Set<() => void>();
const setAccess = (a: Access) => {
  access = a;
  for (const cb of subs) cb();
};

/** use-collab 拿到 403 时调：这台设备读不了台账，入口收起 */
export const markLedgerForbidden = () => setAccess("no");

function probe() {
  if (probing || access !== "unknown") return;
  probing = true;
  api<{ features?: string[] }>("/capabilities", { timeoutMs: 4000 })
    .then((j) => setAccess(j.features?.includes("ledger") ? "yes" : "no"))
    .catch(() => undefined) // 探不到（老 bridge / 断网 / 限流）先不显示，下次挂载入口时再探
    .finally(() => {
      probing = false;
    });
}

function useLedgerAccess(): Access {
  useEffect(probe, []);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => access,
    () => "unknown",
  );
}

export function CollabEntry({ projectId }: { projectId: string }) {
  const t = useT();
  const nav = useChatNav();
  const cur = useCollabNav();
  if (useLedgerAccess() !== "yes") return null;
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
