"use client";
/**
 * 「团队」页（NAVBAR1，手机和电脑同一个组件）：团队项目一律列出（SharedProjectsEntry 不传 entries = 不因本机已有分组而藏起来），
 * 点一行和原团队区一样进协作视图；顶上「项目设置」照旧。下面两条入口复用协作视图现有的「团队」标签和「规划与提案」子标签，不另做名册。
 * 两条入口开的是本机第一个绑定了团队的项目（与项目分组里带「团队」小标的协作入口同一个选源）；一个都没有时灰掉、title 写原因。
 * 该项目已开着（电脑盖在主区 / 手机返回列表后仍挂着）时连续点、返回再点都要切过去：live 提示通知已挂着的视图。
 */
import { useChatStore } from "../chat/chat-store";
import { useCollabNav } from "../collab/collab-nav";
import { Icon } from "../collab/collab-icons";
import { SharedProjectsEntry } from "../collab/shared-projects/projects-entry";
import { ROW, ROW_ON, useOpeners, WithSource, type Source } from "../now/now-ui";
import { hintCollabTab, type CollabTabHint } from "./collab-tab-hint";
import { NavIcon } from "./nav-icons";
import { useNavT } from "./use-nav-t";

function TeamLinks({ source }: { source: Source }) {
  const tr = useNavT(), open = useOpeners();
  const projects = useChatStore((s) => s.state.projects);
  const showing = useCollabNav().project;
  const bound = projects.map((p) => source(p.id)).find((c) => c.kind === "center");
  const key = bound?.kind === "center" ? bound.key : null;
  const go = (tab: CollabTabHint) => {
    if (!key) return;
    hintCollabTab(tab, showing === key); // 同一项目已开着：视图不重挂，要通知它当场切
    open.project(key);
  };
  const links: [CollabTabHint, string, React.ReactNode][] = [
    ["members", "成员与位子", <NavIcon key="i" name="team" size={14} />],
    ["ops", "规划与提案", <Icon key="i" name="clipboard" size={14} />],
  ];
  return (
    <ul className="mt-1 flex list-none flex-col border-t border-base-300 p-0 pt-2" data-team-links>
      {links.map(([tab, label, icon]) => (
        <li key={tab}>
          <button type="button" className={key ? ROW_ON : `${ROW} cursor-not-allowed opacity-50`} aria-disabled={key ? undefined : true}
            title={key ? undefined : tr("本机还没有绑定团队的项目")} data-team-link={tab} onClick={() => go(tab)}>
            <span className="flex w-4 shrink-0 justify-center text-base-content/60">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{tr(label)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TeamPage() {
  const tr = useNavT();
  return (
    <div data-nav-page="team">
      {/* 没有团队绑定（403 / 404 / 501）时团队区整段不渲染，外层变空 → 下面那句空态出现 */}
      <div className="peer">
        <SharedProjectsEntry />
      </div>
      <p className="hidden px-2 py-3 text-[13px] text-base-content/50 peer-empty:block" data-team-empty>{tr("还没有团队项目，加入后会出现在这里")}</p>
      <WithSource render={({ source }) => <TeamLinks source={source} />} />
    </div>
  );
}
