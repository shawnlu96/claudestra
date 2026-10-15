"use client";
/**
 * 正在做（UXHOME1「在干活」「各项目」并进来）：按项目分组，项目头是 UXHOME1 的项目行（点了照旧按 resolveCollabSource 选源打开）。
 * 有产品看板的项目下面每个在做模块一行：模块名、进度条（completed / total）、「N 个在做」、在做的人（最多 3 个首字头像，再多「+K」）；
 * 对不上模块的 agent 归到「其他」。没有看板 / 台账读不了的项目退回 UXHOME1 的 agent 行。没有在做事项、排在折叠数之外的项目折成「其余 K 个项目」。
 * 点模块行先落到项目页（PROJTABS1 合入后改为落到「模块进度」的该模块）。
 */
import { useState } from "react";
import { FACE_LIMIT, type NowWorker, type TodayFace, type TodayModule, type TodayProject, type TodayView } from "./now-model";
import { ProjectRow } from "./now-projects";
import { Block, EMPTY, Fold, ROW, ROW_ON, useOpeners, type Translate } from "./now-ui";

function Faces({ faces }: { faces: readonly TodayFace[] }) {
  const more = faces.length - FACE_LIMIT;
  return (
    <span className="flex shrink-0 items-center -space-x-1" data-now-faces>
      {faces.slice(0, FACE_LIMIT).map((f) => (
        <span key={f.name} className="grid size-5 place-items-center rounded-full border border-base-100 bg-base-300 text-[10px] font-medium text-base-content/75"
          title={f.doing ? `${f.label} · ${f.doing}` : f.label} data-now-face={f.name}>
          {Array.from(f.label)[0] ?? "?"}
        </span>
      ))}
      {more > 0 && <span className="pl-1.5 text-[11px] text-base-content/50">+{more}</span>}
    </span>
  );
}

function ModuleRow({ m, tr, onOpen }: { m: TodayModule; tr: Translate; onOpen: (() => void) | null }) {
  const pct = m.total ? Math.round((m.completed / m.total) * 100) : 0;
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{m.title}</span>
      {m.id !== null && (
        <>
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-base-300" role="progressbar" aria-valuemin={0} aria-valuemax={m.total} aria-valuenow={m.completed}
            aria-label={`${m.completed}/${m.total}`}>
            <span className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-base-content/50">{m.completed}/{m.total}</span>
          <span className="shrink-0 text-[11px] text-base-content/60" data-now-module-active>{tr("{n} 个在做", { n: m.active })}</span>
        </>
      )}
      {m.faces.length > 0 && <Faces faces={m.faces} />}
    </>
  );
  const hook = { "data-now-module": m.id ?? "" };
  return onOpen
    ? <button type="button" className={`${ROW_ON} pl-7`} {...hook} onClick={onOpen}>{body}</button>
    : <div className={`${ROW} pl-7`} {...hook}>{body}</div>;
}

function WorkerRow({ w, onOpen }: { w: NowWorker; onOpen: (name: string) => void }) {
  return (
    <button type="button" className={`${ROW_ON} pl-7`} data-now-worker={w.name} onClick={() => onOpen(w.name)}>
      <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="max-w-[45%] shrink-0 truncate font-medium">{w.label}</span>
      <span className="min-w-0 flex-1 truncate text-base-content/60" data-now-doing>{w.doing}</span>
      {w.ago && <span className="shrink-0 text-[11px] tabular-nums text-base-content/45" data-now-ago>{w.ago}</span>}
    </button>
  );
}

function ProjectGroup({ p, fp, tr }: { p: TodayProject; fp: string | null; tr: Translate }) {
  const open = useOpeners();
  const key = p.row.open;
  return (
    <li data-now-group={p.row.id}>
      <ProjectRow p={p.row} fp={fp} tr={tr} onOpen={open.project} />
      {p.modules
        ? p.modules.length > 0 && (
          <ul className="flex list-none flex-col p-0">
            {p.modules.map((m) => <li key={m.id ?? ""}><ModuleRow m={m} tr={tr} onOpen={key ? () => open.project(key) : null} /></li>)}
          </ul>
        )
        : p.workers.length > 0 && (
          <ul className="flex list-none flex-col p-0" data-now-workers>
            {p.workers.map((w) => <li key={w.name}><WorkerRow w={w} onOpen={open.agent} /></li>)}
          </ul>
        )}
    </li>
  );
}

export function NowDoing({ view, fp, tr }: { view: Pick<TodayView, "doing" | "rest" | "idle" | "team">; fp: string | null; tr: Translate }) {
  const [all, setAll] = useState(false);
  const empty = view.doing.length === 0 && view.rest.length === 0;
  return (
    <Block title={tr("正在做")} count={view.team.busy ? tr("{n} 个 agent 在干活", { n: view.team.busy }) : undefined} hook="doing">
      {view.idle && <p className={EMPTY} data-now-idle>{tr("现在没有 agent 在干活")}</p>}
      {empty ? <p className={EMPTY}>{tr("还没有项目")}</p> : (
        <ul className="flex list-none flex-col p-0" data-now-projects>
          {view.doing.map((p) => <ProjectGroup key={p.row.id} p={p} fp={fp} tr={tr} />)}
        </ul>
      )}
      {view.rest.length > 0 && (
        <>
          <Fold open={all}>
            <ul className="flex list-none flex-col p-0">
              {view.rest.map((p) => <ProjectGroup key={p.row.id} p={p} fp={fp} tr={tr} />)}
            </ul>
          </Fold>
          <button type="button" className={`${ROW_ON} text-base-content/60`} aria-expanded={all} data-now-project-all onClick={() => setAll((v) => !v)}>
            {all ? tr("收起") : tr("其余 {n} 个项目", { n: view.rest.length })}
          </button>
        </>
      )}
    </Block>
  );
}
