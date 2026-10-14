import type { CardPauseView } from "@/lib/api/card-pause";
import type { Stage } from "./collab-model";

const STAGES: ReadonlySet<string> = new Set(["spec", "restate", "build", "review", "fix"]);
export function showCardPause(view: CardPauseView | null, stage: Stage): boolean {
  return view?.mode === "on" && STAGES.has(stage) && STAGES.has(view.stage);
}
