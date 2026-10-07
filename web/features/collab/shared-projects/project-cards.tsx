"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectFailure, projectErrorText, type ProjectCard, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { ProjectChoice } from "./project-choice";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

/** Use actual N4/N3 card IDs/options and the existing answer wire, independently of the global AskRow. */
export function ProjectCards({ port, refresh }: { port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void> }) {
  const [cards, setCards] = useState<ProjectCard[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const sequence = useRef(0);
  const load = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    // Advance expiry even when the response is unchanged or the next read is still pending.
    setNow(Date.now());
    if (!port.cards) return;
    const seq = ++sequence.current;
    try {
      const next = await port.cards(signal);
      if (!signal.aborted && seq === sequence.current) { setNow(Date.now()); setCards(next); setError(""); }
    } catch (e) {
      if (!signal.aborted && seq === sequence.current) { setCards([]); setError(projectErrorText(e instanceof ProjectFailure ? e.status : 0)); }
    }
  }, [port]);
  useEffect(() => {
    const ctrl = new AbortController();
    const initial = setTimeout(() => void load(ctrl.signal), 0);
    const timer = setInterval(() => void load(ctrl.signal), 2000);
    return () => { ctrl.abort(); clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  if (!port.cards || !port.answer) return null;
  return <section className="space-y-3 border-t border-base-300 pt-4" aria-label="项目确认卡">
    <h3 className="font-semibold">项目确认卡</h3>
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    {!cards.length && !error && <p className="text-sm opacity-60">暂无待确认的项目操作。</p>}
    {cards.map(card => <ProjectCardView key={card.id} card={card} now={now} port={port} refresh={async signal => {
      await refresh(signal); await load(signal);
    }} />)}
  </section>;
}

function ProjectCardView({ card, now, port, refresh }: {
  card: ProjectCard; now: number; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const action = useProjectAction(refresh);
  const busy = action.busy || !card.canAnswer || card.expiresAt <= now;
  const answer = (choices: string[]) => {
    if (busy || card.expiresAt <= Date.now() || !port.answer) return;
    void action.run(signal => port.answer!(card, choices, signal), "答复已记录，请刷新查看实际项目状态。");
  };
  return <article className="space-y-3 rounded-lg border border-base-300 p-3">
    <h4 className="break-words font-medium">{card.title}</h4>
    <p className="whitespace-pre-wrap break-words text-sm">{card.context}</p>
    {!card.canAnswer && <p className="text-sm opacity-60">当前设备无权确认此操作。</p>}
    {card.choice ? <ProjectChoice cardId={card.id} choice={card.choice} busy={busy} accept={card.accept} decline={card.decline} onAnswer={answer} />
      : <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => answer([`[button:${card.accept.id}]`])}>{card.accept.label}</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => answer([`[button:${card.decline.id}]`])}>{card.decline.label}</button>
      </div>}
    <ActionStatus {...action} />
  </article>;
}
