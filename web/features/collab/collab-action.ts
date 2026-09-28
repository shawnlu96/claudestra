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

const basename = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

/** 形似密钥：常见前缀（OpenAI/Anthropic、GitHub、GitLab、Slack、AWS、Google、Stripe）、JWT、或 16 位以上字母数字混排的长串 */
const SECRET_RE = /^(?:sk-|sk_|rk_|pk_live|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-|AKIA|AIza|eyJ)/;
const looksSecret = (w: string) => SECRET_RE.test(w) || (w.length >= 16 && /\d/.test(w) && /[A-Za-z]/.test(w) && /^[\w\-.~+/=]+$/.test(w) && !w.includes("/"));
/** 后面跟着秘密值的词：Bearer / Basic / token / API_KEY: / password: … */
const SECRET_LEAD_RE = /^(?:bearer|basic|token|[\w.-]*(?:key|token|secret|pass(?:word)?|pwd|auth)[\w.-]*:)$/i;

/** description 里的一个词：URL 只留主机名，key=value 只留 key，路径只留像文件名的最后一段（目录名、半截路径直接丢） */
function scrubWord(w: string): string {
  const url = /^[a-z][\w+.-]*:\/\/(?:[^@/\s]*@)?([^/:?#\s]+)/i.exec(w);
  if (url) return url[1];
  const kv = /^([A-Za-z_][\w.-]*)=/.exec(w);
  if (kv) return `${kv[1]}=•••`;
  if (looksSecret(w.replace(/^["'(]+|["'),.;]+$/g, ""))) return "•••";
  if (/[/\\]/.test(w) || /^~/.test(w)) {
    const base = basename(w).replace(/["'),;]+$/, "");
    return /\.\w{1,8}$/.test(base) && !looksSecret(base) ? base : "";
  }
  return w;
}

/** 自由文本（Bash 的 description）按词清洗；跟在 Bearer / token / API_KEY: 后面的那个词整个打码 */
function scrub(s: string): string {
  const out: string[] = [];
  let maskNext = false;
  for (const w of s.split(/\s+/)) {
    if (!w) continue;
    if (maskNext) {
      out.push("•••");
      maskNext = false;
      continue;
    }
    const clean = scrubWord(w);
    if (clean) out.push(clean);
    maskNext = SECRET_LEAD_RE.test(w);
  }
  return out.join(" ");
}

const SKIP_WORDS = new Set(["export", "env", "sudo", "exec", "time", "nohup", "command", "builtin"]);
const SEPARATORS = new Set([";", "&&", "||", "|", "&"]);

/**
 * 命令没有 description 时只报程序名（Pi / Codex 的 bash 都走这里）：先去掉 $(…) / `…`，按引号分词，
 * 跳过环境变量赋值、export / sudo 这类前缀、cd 和它的参数，取第一个真正的程序；只放行像程序名的词。
 */
function programOf(command: string): string {
  const flat = command.replace(/\$\([^)]*\)|`[^`]*`/g, " ");
  const words = flat.match(/(?:"[^"]*"|'[^']*'|[^\s"';&|]+)+|&&|\|\||[;&|]/g) ?? [];
  let skipArg = false;
  for (const raw of words) {
    if (SEPARATORS.has(raw)) {
      skipArg = false;
      continue;
    }
    if (skipArg) continue;
    const w = raw.replace(/^\(+|\)+$/g, "").replace(/["']/g, "");
    if (!w || /^[A-Za-z_]\w*=/.test(w) || SKIP_WORDS.has(w)) continue;
    if (w === "cd" || w === "pushd") {
      skipArg = true;
      continue;
    }
    const prog = basename(w);
    return /^[\p{L}\p{N}._+-]{1,40}$/u.test(prog) && !looksSecret(prog) ? prog : "";
  }
  return "";
}

/** tool_start 的 detail → 首页那一行；只给 Read / Edit / Write（文件名）和 Bash（description 或程序名），其余工具不显示 */
export function shortDetail(tool: string, detail: string): string {
  const first = detail.split("\n")[0].trim();
  if (tool === "Read" || tool === "Edit" || tool === "Write") return first && !first.startsWith("─") ? clip(basename(first)) : "";
  if (tool !== "Bash") return "";
  const sep = detail.indexOf(BASH_SEP);
  return sep >= 0 ? clip(scrub(detail.slice(0, sep).split("\n")[0])) : clip(programOf(first));
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
 * 工位卡上的那一行。流里的动作优先，但流会丢（页面隐藏 / 断线期间的事件不补发）：流里只剩一条旧的「空闲」
 * 而 /agents 轮询说 busy 时按在干活显示，不让陈旧的空闲盖住真实的忙（审查 #144 第 2 轮 P1）。
 * 空闲又处在等人阶段时，直接写在等什么（「等待 · 等 PM 放行」），比「空闲」有信息量。
 */
export function actionLine(a: AgentAction | undefined, busy: boolean | undefined, waitLabel: string | null): { kind: ActionKind | "waiting"; text: string } {
  if (a?.kind === "tool") return { kind: "tool", text: a.detail ? `${a.tool} · ${a.detail}` : a.tool ?? "" };
  if (a?.kind === "thinking" || a?.kind === "compacting") return { kind: a.kind, text: "" };
  if (busy) return { kind: "thinking", text: "" };
  if (waitLabel) return { kind: "waiting", text: waitLabel };
  return { kind: "idle", text: "" };
}

/**
 * 「对它说」闸门用的「在不在干活」：取保守值，事件流说忙或 /agents 说 busy 都算忙。
 * 两路都可能陈旧（流会丢事件、轮询有 15s 滞后），放错一次就是 C-c 打断它，所以宁可多拦。
 */
export function isWorking(a: AgentAction | undefined, busy: boolean | undefined): boolean {
  return (a !== undefined && a.kind !== "idle") || busy === true;
}

/** 点发送前实时查的 GET /agents/:name/pending：thinking 为 true = 回合进行中；查不到（null）按忙处理，不冒险 */
export function liveIdle(pending: { thinking?: boolean; compacting?: boolean } | null): boolean {
  return pending !== null && pending.thinking !== true && pending.compacting !== true;
}

/**
 * 「对它说」能不能发（审查 #144 P0）：web 发的是人类消息，Claude Code 忙时 bridge 会先 C-c 再投递——也就是打断。
 * 第一版只许在它空闲时发；真正的「等这步做完再送达」要 T13a 的投递语义。
 */
export function sayGate(working: boolean, text: string, sending: boolean): { canSend: boolean; blockedByWork: boolean } {
  return { canSend: !working && !sending && text.trim().length > 0, blockedByWork: working };
}
