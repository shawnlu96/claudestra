"use client";
import { useEffect, useRef, useState } from "react";
import { fetchCardPause, setCardPause, type CardPauseView, type PauseTarget } from "@/lib/api/card-pause";
import { Icon } from "./collab-icons";
import type { Stage, Tr } from "./collab-model";
import { showCardPause } from "./detail-pause-model";
import s from "./collab.module.css";

export const PAUSE_TITLE = "暂停后调度器不再给这张卡派新活，当前这一轮照常做完；继续后从原处接上";

export function useCardPause(target: PauseTarget | null, snapshot: object) {
  const project = target?.project, id = target?.id;
  const key = JSON.stringify([project, id]);
  const [result, setResult] = useState<{ key: string; view: CardPauseView } | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    if (!project || !id) return;
    const ctrl = new AbortController(), version = ++epoch.current;
    fetchCardPause({ project, id }, ctrl.signal).then((view) => {
      if (!ctrl.signal.aborted && version === epoch.current) setResult({ key, view });
    }, () => {
      // Old bridges / unauthorized devices cannot offer this action. Leave it hidden; device repair is handled by the API client.
      if (!ctrl.signal.aborted && version === epoch.current) setResult(null);
    });
    return () => ctrl.abort();
  }, [project, id, key, snapshot]);
  const update = (view: CardPauseView) => { ++epoch.current; setResult({ key, view }); };
  return { view: result?.key === key ? result.view : null, update };
}

export function PauseCard({ target, view, stage, onChange, tr }: {
  target: PauseTarget; view: CardPauseView | null; stage: Stage; onChange(v: CardPauseView): void; tr: Tr;
}) {
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const deadline = useRef(0), busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); request.current?.abort(); }, []);
  if (!showCardPause(view, stage) || !view) return null;
  const disabled = sending || (!view.paused && !view.canPause);
  const click = async () => {
    if (busy.current || disabled) return;
    if (!view.paused && (!confirm || Date.now() >= deadline.current)) {
      deadline.current = Date.now() + 5_000;
      setConfirm(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirm(false), 5_000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setConfirm(false);
    const reason = view.paused ? null : window.prompt(tr("暂停理由"), tr("owner 在卡片详情暂停"))?.trim();
    if (!view.paused && (!reason || reason.length > 600)) return;
    busy.current = true;
    setSending(true);
    const ctrl = new AbortController();
    request.current = ctrl;
    try {
      const r = await setCardPause(target, reason ?? null, ctrl.signal);
      if (!ctrl.signal.aborted && r.ok && r.view) onChange(r.view);
    } catch {
      // A rejected pause/resume leaves the last confirmed server state intact so the user can retry without a false success.
    } finally {
      busy.current = false;
      if (!ctrl.signal.aborted) setSending(false);
    }
  };
  const label = view.paused ? "继续" : confirm ? "确认暂停" : "暂停调度";
  return <button type="button" className={`${s.btn} ${s.stopRound}`} data-card-pause={view.paused ? "paused" : confirm ? "confirm" : "idle"}
    disabled={disabled} title={tr(!view.paused && !view.canPause ? view.refusal ?? PAUSE_TITLE : PAUSE_TITLE)} onClick={() => void click()}
    style={{ marginLeft: 0, transition: "color 160ms, border-color 160ms, opacity 160ms", opacity: sending ? 0.5 : undefined }}>
    <Icon name={view.paused ? "play" : "pause"} size={13} />{tr(label)}
  </button>;
}
