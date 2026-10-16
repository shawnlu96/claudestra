"use client";
/**
 * 「团队与额度」里的额度行（QUOTA1）：「Claude 本周已用 62% · Codex 本周已用 18%」，到线 / 用完的族跟状态字（quota/quota-summary）。
 * 读数来自 quota-lines-store（与顶部额度卡同一份 /lend/quota-lines、/quota/wall 轮询），不碰用量看板的 GET /quota 心跳。
 * 读不到整行不出。行尾「看用量」打开用量看板：这里自己挂一个 StatsPanel，开关状态放在本地（关着时它不拉 /quota）。
 */
import { useState } from "react";
import { QUOTA_WORDS as Q } from "@/lib/owner-words";
import { StatsPanel } from "../chat/components/stats-panel";
import { QuotaSummary } from "../quota/quota-summary";
import type { Translate } from "./now-ui";

export function NowTeamQuota({ tr }: { tr: Translate }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <QuotaSummary className="flex flex-wrap items-baseline gap-x-2 px-2 py-1 text-[13px] text-base-content/70" hook="data-now-quota" trailing={
        <button type="button" className="ml-auto shrink-0 rounded px-1 text-[12px] text-primary transition-colors hover:bg-base-300/50" data-now-usage
          onClick={() => setOpen(true)}>
          {tr(Q.viewUsage)}
        </button>
      } />
      {open && <StatsPanel open onClose={() => setOpen(false)} />}
    </>
  );
}
