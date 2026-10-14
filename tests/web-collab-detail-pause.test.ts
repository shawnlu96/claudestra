import { expect, test } from "bun:test";
import { showCardPause } from "../web/features/collab/detail-pause-model";
import { detailTarget, rememberDetailTarget } from "../web/features/collab/detail-pause-target";
import { nowSentence, type NowFacts } from "../web/features/collab/detail-now-model";
import { sharedCollabProject } from "../web/features/collab/team-source-key";
import type { CardPauseView } from "../web/lib/api/card-pause";
import type { TaskDetail } from "../web/features/collab/collab-detail-model";
import type { Stage } from "../web/features/collab/collab-model";

const view: CardPauseView = { mode: "on", paused: true, actor: "owner", at: 1_000, reason: "先核规格", stage: "review", canPause: false, refusal: "已暂停" };
test("pause button stage and effective-mode gates", () => {
  for (const stage of ["spec", "restate", "build", "review", "fix"] as Stage[]) expect(showCardPause({ ...view, stage }, stage)).toBe(true);
  for (const stage of ["merge", "live", "blocked", "done", "verified", "cancelled"] as Stage[]) expect(showCardPause({ ...view, stage }, stage)).toBe(false);
  expect(showCardPause(null, "review")).toBe(false);
  for (const mode of ["observe", "off"] as const) expect(showCardPause({ ...view, mode }, "review")).toBe(false);
  expect(showCardPause(view, "merge")).toBe(false);
});
test("now sentence reports effective pause, actor, time, reason and resume next step", () => {
  const facts: NowFacts = { stage: "review", round: 2, executor: "dev", pm: "pm", reviewer: null, dwellMs: 0,
    reason: "old reason", now: 601_000, awayMachine: null, pause: view };
  const s = nowSentence(facts);
  expect(s.who).toContain("已暂停 · owner 10分前 暂停 · 先核规格");
  expect(s.next).toBe("你点继续后，调度器接着派");
  expect(s.usedReason).toBe(true);
  for (const mode of ["observe", "off"] as const) expect(nowSentence({ ...facts, pause: { ...view, mode } }).who).not.toContain("已暂停");
  expect(nowSentence({ ...facts, awayMachine: "peer" }).who).not.toContain("已暂停");
});
test("team card display alias never becomes the pause/usage target", () => {
  const d = { task: { id: "CARD~2" } } as TaskDetail;
  const project = sharedCollabProject({ center: "c", team: "t", person: "p", project: "center-project", machine: "local" });
  expect(detailTarget(d, project, false)).toBeNull();
  rememberDetailTarget(d, "local-project", "CARD");
  expect(detailTarget(d, project, false)).toEqual({ project: "local-project", id: "CARD" });
  expect(detailTarget(d, project, true)).toBeNull();
  expect(detailTarget({ ...d }, project, false)).toBeNull();
});
