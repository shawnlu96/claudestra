"use client";
/**
 * 团队与额度：「本机 N 个 agent 活着 · M 个在干活」（chat store 的 agents，status=active 与本机 busy；借入单归机器行）+ 额度行 + 机器行。
 * 额度行、机器行各自一个文件（QUOTA1 改 now-team-quota.tsx，XMACH1 改 now-team-machines.tsx），这个文件只排顺序。
 * live = 页面版或侧栏条展开：收起时额度行不挂，不发 /lend/quota-lines。
 */
import { aliveLine, type TodayView } from "./now-model";
import { NowTeamMachines } from "./now-team-machines";
import { NowTeamQuota } from "./now-team-quota";
import { Block, type Translate } from "./now-ui";

export function NowTeam({ view, tr, live }: { view: Pick<TodayView, "team">; tr: Translate; live: boolean }) {
  return (
    <Block title={tr("团队与额度")} hook="team">
      <p className="px-2 py-1 text-[13px] text-base-content/70" data-now-agents>
        {aliveLine(view.team, tr)}
      </p>
      {live && <NowTeamQuota tr={tr} />}
      {live && <NowTeamMachines />}
    </Block>
  );
}
