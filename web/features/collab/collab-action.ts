/**
 * 「此刻动作」：bridge /events 的 agent_status / tool_start / tool_done → 每个 agent 一行（思考中 / 运行工具 · Edit · x.ts / 空闲）。
 * 历史不留，只要最新一条（ux.md：「历史是噪音」）；detail 只露文件名或前 40 字，不显示绝对路径。
 * 单测 tests/web-collab-model.test.ts。
 */
import { bareAgent } from "./collab-model";

export type ActionKind = "thinking" | "tool" | "idle" | "compacting";

export interface AgentAction {
  kind: ActionKind;
  tool?: string;
  detail?: string;
  ts: number;
}

export type ActionMap = ReadonlyMap<string, AgentAction>;

const DETAIL_MAX = 40;

/** 路径只留最后一段；命令 / 其它文本截前 40 字（按码点，避免把 emoji 截成半个） */
export function shortDetail(detail: string): string {
  const one = detail.split("\n")[0].trim();
  const looksPath = /^[~./]?[\w.@-]*\/[^\s]*$/.test(one);
  const s = looksPath ? one.slice(one.lastIndexOf("/") + 1) : one;
  const cps = [...s];
  return cps.length > DETAIL_MAX ? `${cps.slice(0, DETAIL_MAX).join("")}…` : s;
}

interface BusEvent {
  agent: string;
  type: string;
  data?: Record<string, unknown>;
}

/** 收一条 bridge 事件，返回新表；和此刻动作无关的事件原样返回同一个表（调用方据此跳过重渲） */
export function reduceAction(map: ActionMap, evt: BusEvent, now: number): ActionMap {
  const name = bareAgent(evt.agent);
  if (!name) return map;
  const d = evt.data ?? {};
  let next: AgentAction | null = null;
  if (evt.type === "tool_start") {
    next = { kind: "tool", tool: String(d.name ?? "?"), ...(typeof d.detail === "string" && d.detail ? { detail: shortDetail(d.detail) } : {}), ts: now };
  } else if (evt.type === "tool_done") {
    // 工具跑完回到「思考中」，直到下一个工具或回合结束
    if (map.get(name)?.kind === "tool") next = { kind: "thinking", ts: now };
  } else if (evt.type === "agent_status") {
    next = d.status === "done" ? { kind: "idle", ts: now } : { kind: d.status === "compacting" ? "compacting" : "thinking", ts: now };
  }
  if (!next) return map;
  const out = new Map(map);
  out.set(name, next);
  return out;
}

/**
 * 工位卡上的那一行。流里没有这个 agent 的动作时，用 /agents 轮询的 busy 兜底（「工作中」/「空闲」）；
 * 空闲又处在等人阶段时，直接写在等什么（「等待 · 等 PM 放行」），比「空闲」有信息量。
 */
export function actionLine(a: AgentAction | undefined, busy: boolean | undefined, waitLabel: string | null): { kind: ActionKind | "waiting"; text: string } {
  if (a?.kind === "tool") return { kind: "tool", text: a.detail ? `${a.tool} · ${a.detail}` : a.tool ?? "" };
  if (a?.kind === "thinking" || a?.kind === "compacting") return { kind: a.kind, text: "" };
  if (!a && busy) return { kind: "thinking", text: "" };
  if (waitLabel) return { kind: "waiting", text: waitLabel };
  return { kind: "idle", text: "" };
}
