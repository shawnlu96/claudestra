"use client";
/**
 * 项目行（UXHOME1 的「各项目」行，TODAY1 拆出来）：项目名 + 团队小标 + 在干活 / 待你处理；点了按 resolveCollabSource 选源打开协作视图，
 * 绑定停用的行不可点、title 写原因。「正在做」的项目头用 ProjectRow；NAVBAR1 的「项目」入口直接用 NowProjectList。
 */
import { useMemo, useState } from "react";
import type { CollabSourceChoice } from "@/lib/collab-source-binding";
import { useLang } from "@/lib/i18n";
import { useAsks } from "../asks/asks-store";
import { useChatStore } from "../chat/chat-store";
import { fmtAgo } from "../chat/fmt-time";
import { Icon } from "../collab/collab-icons";
import { BLOCKED_REASON, useCollabChoice } from "../collab/team-view-entry";
import { nowView, PROJECT_FOLD, type NowProject } from "./now-model";
import { EMPTY, LOCAL, ROW, ROW_ON, useNowT, useOpeners, WithSource, type Source, type Translate } from "./now-ui";

function ProjectLine({ p, tr }: { p: NowProject; tr: Translate }) {
  return (
    <>
      <Icon name="listTree" size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
      {p.team && <span className="shrink-0 rounded border border-base-300 px-1 text-[11px] leading-4 text-base-content/55">{tr("团队")}</span>}
      {p.working > 0 && <span className="shrink-0 text-[11px] text-base-content/60" data-now-project-working>{tr("在干活 {n} 个 agent", { n: p.working })}</span>}
      {p.waits > 0 && <span className="shrink-0 text-[11px] font-medium text-warning" data-now-project-waits>{tr("待你处理 {n} 件", { n: p.waits })}</span>}
    </>
  );
}

/** 一行项目：choice = 最终选源（带撤权判断）。停用的行不可点，title 写原因 */
function ProjectRowView({ p, choice, tr, onOpen }: { p: NowProject; choice: CollabSourceChoice; tr: Translate; onOpen: (key: string) => void }) {
  if (choice.kind === "blocked") {
    return (
      <div className={`${ROW} cursor-not-allowed opacity-50`} role="button" aria-disabled data-now-project={p.id} data-collab-blocked={choice.reason}
        title={`${p.name} · ${BLOCKED_REASON[choice.reason]}`}>
        <ProjectLine p={p} tr={tr} />
      </div>
    );
  }
  const key = choice.kind === "center" ? choice.key : p.id;
  return (
    <button type="button" className={ROW_ON} data-now-project={p.id} title={tr("打开 {p} 的协作视图", { p: p.name })} onClick={() => onOpen(key)}>
      <ProjectLine p={p} tr={tr} />
    </button>
  );
}

function BoundProjectRow({ fp, ...rest }: { fp: string; p: NowProject; tr: Translate; onOpen: (key: string) => void }) {
  return <ProjectRowView {...rest} choice={useCollabChoice(fp, rest.p.id).choice} />;
}

/** fp = 当前机器（有就按团队绑定选源，没有全按本机） */
export function ProjectRow({ p, fp, tr, onOpen }: { p: NowProject; fp: string | null; tr: Translate; onOpen: (key: string) => void }) {
  return fp ? <BoundProjectRow fp={fp} p={p} tr={tr} onOpen={onOpen} /> : <ProjectRowView p={p} choice={LOCAL} tr={tr} onOpen={onOpen} />;
}

function ListBody({ source, fp, fold }: { source: Source; fp: string | null; fold: boolean }) {
  const tr = useNowT(), lang = useLang(), open = useOpeners();
  const agents = useChatStore((s) => s.state.agents);
  const projects = useChatStore((s) => s.state.projects);
  const { asks } = useAsks();
  const rows = useMemo(() => nowView({ agents, projects, asks }, { lang, t: tr, ago: fmtAgo, source }).projects, [agents, projects, asks, lang, tr, source]);
  const [all, setAll] = useState(false);
  const folded = fold && rows.length > PROJECT_FOLD;
  const shown = folded && !all ? rows.slice(0, PROJECT_FOLD) : rows;
  if (!rows.length) return <p className={EMPTY}>{tr("还没有项目")}</p>;
  return (
    <ul className="flex list-none flex-col p-0" data-now-projects>
      {shown.map((p) => <li key={p.id}><ProjectRow p={p} fp={fp} tr={tr} onOpen={open.project} /></li>)}
      {folded && (
        <li>
          <button type="button" className={`${ROW_ON} text-base-content/60`} aria-expanded={all} data-now-project-all onClick={() => setAll((v) => !v)}>
            {all ? tr("收起") : tr("其余 {n} 个项目", { n: rows.length - PROJECT_FOLD })}
          </button>
        </li>
      )}
    </ul>
  );
}

/** 各项目的行列表（自带数据与选源）；fold = 超过 PROJECT_FOLD 个时折成末行「其余 K 个项目」 */
export function NowProjectList({ fold }: { fold: boolean }) {
  return <WithSource render={({ source, fp }) => <ListBody source={source} fp={fp} fold={fold} />} />;
}
