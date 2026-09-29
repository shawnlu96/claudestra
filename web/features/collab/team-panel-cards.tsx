"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { openCollabTask } from "./collab-nav";
import { useTeamT } from "./team-panel-i18n";
import s from "./team-panel.module.css";

/** Remounted for each selection; failure is unknown, never an empty success. */
export function TeamPanelCards({ project, peer, agent }: { project: string; peer: string; agent: string }) {
  const t = useTeamT();
  const [tasks, setTasks] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const query = new URLSearchParams({ project, peer, agent });
    api<{ tasks: { id: string; title: string }[] }>(`/team/tasks?${query}`, { signal: ctrl.signal }).then(
      (r) => { if (!ctrl.signal.aborted) setTasks(r.tasks); },
      () => { if (!ctrl.signal.aborted) setTasks(null); }, // Missing endpoint/ledger stays unknown; it is not evidence of no work.
    );
    return () => ctrl.abort();
  }, [project, peer, agent]);
  return <div className={s.cards}>
    <h3>{agent}{peer ? `@${peer}` : ""} · {t("本项目的卡")}</h3>
    {tasks?.map((task) => <button key={task.id} type="button" onClick={() => openCollabTask(task.id)}>{task.id} · {task.title}</button>)}
    {!tasks?.length && <p className={s.hint}>{t(tasks ? "暂无关联卡" : "未知")}</p>}
  </div>;
}
