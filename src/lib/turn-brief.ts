/**
 * 目标 agent「当前在做什么」的短摘要（≤ BRIEF_MAX 字）：开启本回合的那条消息 + 最近几次工具 + 在等的问题。
 * 给入站路由判定（打断 / 排队 / 合并）当 state 用，只描述、不判定；没数据的段落省掉，全空返回 ""（= 不知道在做什么）。
 * 取数在 bridge/turn-brief.ts；单测 tests/turn-brief.test.ts。
 */
import { turnStart, type CutEvent, type TurnTrigger } from "./turn-cuts.js";

export const BRIEF_MAX = 300;
const TRIGGER_MAX = 120;
const TOOL_MAX = 40;
const QUESTION_MAX = 60;
const TOOLS_KEEP = 3;
const QUESTIONS_KEEP = 2;

export interface BriefTool {
  title: string;
  running: boolean;
}

export interface BriefInput {
  /** 本回合送到的消息，按先后（TurnCuts 记的；Stop / 打断后清空） */
  inbound: readonly TurnTrigger[];
  tools: readonly BriefTool[];
  /** 这个 agent 开着、在等人答的问题（标题） */
  questions: readonly string[];
}

/** 按码点截断（中文 / emoji 不切半个），压掉换行和连续空白 */
export function clip(s: string, max: number): string {
  const cps = Array.from(s.replace(/\s+/g, " ").trim());
  return cps.length <= max ? cps.join("") : `${cps.slice(0, max - 1).join("")}…`;
}

const shortName = (name: string) => name.replace(/^mcp__.+?__/, "");

/** 本回合（最后一次 done 之后）的工具，按开始先后取最后 n 个；没 tool_done 的算进行中 */
export function recentTools(events: readonly CutEvent[], n = TOOLS_KEEP): BriefTool[] {
  const order: string[] = [];
  const byId = new Map<string, BriefTool>();
  for (const e of events.slice(turnStart(events))) {
    const id = typeof e.data.toolId === "string" ? e.data.toolId : "";
    if (!id) continue;
    if (e.type === "tool_start" && !byId.has(id)) {
      const name = shortName(String(e.data.name ?? ""));
      const summary = String(e.data.summary ?? "").trim();
      order.push(id);
      byId.set(id, { title: summary && summary !== name ? `${name} ${summary}` : name, running: true });
    } else if (e.type === "tool_done" && byId.has(id)) {
      byId.set(id, { ...byId.get(id)!, running: false });
    }
  }
  return order.slice(-n).map((id) => byId.get(id)!);
}

/** 开启本回合的那条：人 / agent 发来的优先，bridge 自己的通知只在没有别的时才算（和打断记录的取法一致） */
function opener(inbound: readonly TurnTrigger[]): TurnTrigger | undefined {
  return inbound.find((t) => t.fromKind !== "bridge") ?? inbound[0];
}

export function turnBriefText(i: BriefInput): string {
  const parts: string[] = [];
  const o = opener(i.inbound);
  if (o) parts.push(`本回合起因：${o.fromName}（${o.fromKind}）「${clip(o.excerpt, TRIGGER_MAX)}」`);
  if (i.tools.length) parts.push(`最近工具：${i.tools.map((t) => `${clip(t.title, TOOL_MAX)}${t.running ? "（进行中）" : ""}`).join("；")}`);
  const qs = i.questions.filter((q) => q.trim()).slice(0, QUESTIONS_KEEP);
  if (qs.length) parts.push(`在等回答：${qs.map((q) => `「${clip(q, QUESTION_MAX)}」`).join("、")}`);
  return clip(parts.join("。"), BRIEF_MAX);
}
