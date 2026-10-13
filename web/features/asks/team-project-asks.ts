/**
 * 团队项目确认卡（UXASK2）在全站收件箱里的识别与分组（单测 tests/web-team-project-asks.test.ts）。
 * 规则只有一处：lib/shared-projects-source.ts projectSourceCards，这里只复用、不重抄；它也保证 bind.params 不进 React。
 */
import type { ProjectCard } from "@/lib/shared-projects-model";
import { projectSourceCards, TEAM_PROJECT_CARD_BUTTONS } from "@/lib/shared-projects-source";
import type { WebAsk } from "./asks-model";

/** createdBy 命中两种团队项目确认卡之一（不论格式对不对）；格式由 teamProjectCardOf 判 */
export const isTeamProjectAsk = (a: Pick<WebAsk, "createdBy">): boolean =>
  typeof a.createdBy === "string" && Object.hasOwn(TEAM_PROJECT_CARD_BUTTONS, a.createdBy);

/** 规则认的卡 → 公开卡面（按钮 id / 文案、选择行）；规则不认的（按钮被改过、选择行不合法、已过期）→ null */
export function teamProjectCardOf(ask: WebAsk, now: number): ProjectCard | null {
  return projectSourceCards({ asks: [ask] }, now)[0] ?? null;
}

/** 「等你处理」分两组：team = 所有团队项目确认卡（含规则不认的，单列后不出作答控件），rest = 其余，顺序都不变 */
export function splitTeamProject(asks: WebAsk[]): { team: WebAsk[]; rest: WebAsk[] } {
  const team: WebAsk[] = [], rest: WebAsk[] = [];
  for (const a of asks) (isTeamProjectAsk(a) ? team : rest).push(a);
  return { team, rest };
}
