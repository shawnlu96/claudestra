import { api } from "./client";

export interface CardPauseView {
  mode: "on" | "observe" | "off";
  paused: boolean;
  actor: string | null;
  at: number | null;
  reason: string | null;
  stage: string;
  canPause: boolean;
  refusal: string | null;
}
export interface PauseTarget { project: string; id: string }
const path = (t: PauseTarget, verb: string) => `/ledger/${encodeURIComponent(t.project)}/tasks/${encodeURIComponent(t.id)}/${verb}`;
export function fetchCardPause(t: PauseTarget, signal?: AbortSignal): Promise<CardPauseView> {
  return api(path(t, "pause"), { signal });
}
export function setCardPause(t: PauseTarget, reason: string | null, signal?: AbortSignal): Promise<{ ok: boolean; view: CardPauseView }> {
  return api(path(t, reason === null ? "resume" : "pause"), { method: "POST", ...(reason === null ? {} : { json: { reason } }), signal });
}
