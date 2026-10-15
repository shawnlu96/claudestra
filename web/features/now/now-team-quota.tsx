"use client";
/**
 * 「团队与额度」里的额度行：现有 useWeekQuota（/lend/quota-lines，不碰用量看板的 GET /quota 心跳），写「Claude 本周 N% · Codex N%」。
 * 读不到整行不出。QUOTA1 在这个文件里统一说法、加链接。
 */
import { useWeekQuota } from "../collab/use-count-source";
import type { Translate } from "./now-ui";

export function NowTeamQuota({ tr }: { tr: Translate }) {
  const quota = useWeekQuota();
  if (!quota) return null;
  return (
    <p className="px-2 py-1 text-[13px] text-base-content/70" data-now-quota>
      {quota.map((q, i) => (i === 0 ? tr("{f} 本周 {n}%", { f: q.family, n: q.pct }) : `${q.family} ${q.pct}%`)).join(" · ")}
    </p>
  );
}
