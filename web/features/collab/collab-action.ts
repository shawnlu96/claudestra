/**
 * 「此刻动作」：bridge /events 的 agent_status / tool_start / tool_done → 每个 agent 一行（思考中 / 运行工具 · Edit · x.ts / 空闲）。
 * 历史不留，只要最新一条（ux.md：「历史是噪音」）。
 * detail 按工具白名单取、宁缺毋滥：命令行里常有 token、环境变量、私有路径（审查 #144 P1-2），首页和截图都会拿去给人看。
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
/** jsonl-watcher.formatToolDetail 给 Bash 拼的分隔：description\n───\ncommand（没有 description 就只有 command） */
const BASH_SEP = "\n───\n";

function clip(s: string): string {
  const cps = [...s.trim()];
  return cps.length > DETAIL_MAX ? `${cps.slice(0, DETAIL_MAX).join("")}…` : cps.join("");
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** 自由文本（Bash 的 description）里的路径只留文件名，形似密钥的整段打码 */
function scrub(s: string): string {
  return s
    .replace(/(?:~|\.{0,2})?\/[^\s"'`]*\/([^\s"'`/]+)/g, "$1")
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|xox[bap]-|AKIA)[\w-]{6,}/g, "•••")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS))=\S+/g, "$1=•••");
}

/** 命令没有 description 时只报程序名：跳过 cd、环境变量赋值，取第一个真正的程序（路径只留文件名） */
function programOf(command: string): string {
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
    if (words[0] && words[0] !== "cd") return basename(words[0]);
  }
  return "";
}

/** tool_start 的 detail → 首页那一行；只给 Read / Edit / Write（文件名）和 Bash（description 或程序名），其余工具不显示 */
export function shortDetail(tool: string, detail: string): string {
  if (tool === "Read" || tool === "Edit" || tool === "Write") return clip(basename(detail.split("\n")[0]));
  if (tool !== "Bash") return "";
  const sep = detail.indexOf(BASH_SEP);
  return sep >= 0 ? clip(scrub(detail.slice(0, sep).split("\n")[0])) : clip(programOf(detail.split("\n")[0]));
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
    const raw = String(d.name ?? "?");
    // MCP 工具名 mcp__<server>__<tool> 太长，工位卡只放得下最后一段
    const tool = raw.startsWith("mcp__") ? raw.slice(raw.lastIndexOf("__") + 2) : raw;
    const detail = typeof d.detail === "string" ? shortDetail(raw, d.detail) : "";
    next = { kind: "tool", tool, ...(detail ? { detail } : {}), ts: now };
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

/**
 * 「对它说」能不能发（审查 #144 P0）：web 发的是人类消息，Claude Code 忙时 bridge 会先 C-c 再投递——也就是打断。
 * 第一版只许在它空闲时发；真正的「等这步做完再送达」要 T13a 的投递语义。
 */
export function sayGate(working: boolean, text: string, sending: boolean): { canSend: boolean; blockedByWork: boolean } {
  return { canSend: !working && !sending && text.trim().length > 0, blockedByWork: working };
}
