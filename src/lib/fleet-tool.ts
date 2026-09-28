/**
 * channel-server 的 `fleet` MCP 工具：定义、参数整理、结果排版。执行全在 bridge（ws fleet_state / fleet_run，bridge/fleet/），
 * 谁能调也由 bridge 按连接上注册的频道判（lib/fleet-caller.ts），这里不做权限判断、也不带任何身份字段。
 * 用例见 tests/fleet-tool.test.ts。
 */
import { MCP_TEXT_MAX } from "./fleet-caller.js";
import { bareName } from "./fleet-plan.js";

type BridgeRequest = (msg: any, timeoutMs?: number) => Promise<any>;

/** 每个 agent 最长约 25 秒、4 路并发；和 manager fleet 的超时一致 */
const RUN_TIMEOUT_MS = 10 * 60_000;
const STATE_TIMEOUT_MS = 60_000;

const ACTION_KIND: Record<string, string> = {
  lp_on: "lp-on",
  lp_off: "lp-off",
  lp_compact: "lp-compact",
  compact: "compact",
  save_compact: "save-compact",
  text: "text",
};

const FLEET_DESCRIPTION = `批量管理其他 agent 的会话：看状态、开关 low-priority（LP）、压缩上下文、统一下发一段指令。
**只有大总管和 PM（台账 pms 名单上的 agent，只能动自己项目里的 agent）能用**，其他 agent 调用会被 bridge 拒绝。大总管和你自己永远不会被选中。

什么时候用：
- 额度撞墙后，批量开 LP 再压缩：action=lp_compact, select={walled:true, ...}
- 额度恢复后，把还开着 LP 的批量关掉：action=lp_off
- 上下文超线时批量压缩：action=compact, select={ctxOver: 200000, ...}（执行者 agent-task-* 的 save_compact 一律按 compact 执行）
- 统一下发一段指令：action=text, text="..."（走消息投递，不敲键；对方看到的来源头写着你的名字；不超过 ${MCP_TEXT_MAX} 字）

用法：先 op=state 看清楚，再 op=run 预演（dryRun 默认就是 true，返回「会对谁做什么、跳过谁、为什么」），确认后再传 dryRun:false 真执行。
压缩用 config 里统一的保留清单，不能自定义。真执行会逐个 agent 发键复核，可能要几分钟，结果逐个列出（已执行 / 已排队 / 已跳过 / 失败）。`;

export const FLEET_TOOL = {
  name: "fleet",
  description: FLEET_DESCRIPTION,
  inputSchema: {
    type: "object" as const,
    properties: {
      op: { type: "string", enum: ["state", "run"], description: "state = 看各 agent 状态；run = 执行（默认预演）" },
      action: { type: "string", enum: Object.keys(ACTION_KIND), description: "op=run 必填" },
      select: {
        type: "object",
        description: "op=run 必填。agents / all / project 至少一个（取并集），walled / ctxOver 是附加条件（取交集）",
        properties: {
          agents: { type: "array", items: { type: "string" }, description: "agent 名，带不带 agent- 前缀都行" },
          all: { type: "boolean", description: "全部（PM 只展开到自己的项目）" },
          project: { type: "string", description: "项目 id" },
          walled: { type: "boolean", description: "只要撞墙等待中的" },
          ctxOver: { type: "number", description: "只要上下文超过这么多 token 的" },
        },
      },
      dryRun: { type: "boolean", description: "默认 true（只预演）；传 false 才真执行" },
      text: { type: "string", description: `action=text 时的正文，不超过 ${MCP_TEXT_MAX} 字` },
    },
    required: ["op"],
  },
};

type Built = { ok: true; msg: Record<string, unknown>; timeoutMs: number } | { ok: false; error: string };

/** 工具参数 → 发给 bridge 的 ws 请求；带 via:"mcp" 让 bridge 走调用方判定（没注册的连接直接拒，不落 CLI 分支） */
export function buildFleetRequest(args: Record<string, unknown> = {}): Built {
  if (args.op === "state") return { ok: true, msg: { type: "fleet_state", via: "mcp" }, timeoutMs: STATE_TIMEOUT_MS };
  if (args.op !== "run") return { ok: false, error: "op 只能是 state 或 run" };
  if (args.keep !== undefined) return { ok: false, error: "fleet 工具不接受 keep：压缩统一用 config 里的保留清单" };
  const kind = typeof args.action === "string" ? ACTION_KIND[args.action] : undefined;
  if (!kind) return { ok: false, error: `action 只能是 ${Object.keys(ACTION_KIND).join(" / ")}` };
  if (!args.select || typeof args.select !== "object" || Array.isArray(args.select)) return { ok: false, error: "select 要是对象：agents / all / project 至少一个" };
  const action: Record<string, unknown> = { kind };
  if (kind === "text") {
    if (typeof args.text !== "string" || !args.text.trim()) return { ok: false, error: "action=text 要带非空的 text" };
    if (args.text.length > MCP_TEXT_MAX) return { ok: false, error: `text 不能超过 ${MCP_TEXT_MAX} 字（现在 ${args.text.length}）` };
    action.text = args.text;
  }
  return { ok: true, msg: { type: "fleet_run", via: "mcp", action, select: args.select, dryRun: args.dryRun !== false }, timeoutMs: RUN_TIMEOUT_MS };
}

interface StateAgent {
  name: string;
  project?: string;
  runtime?: string;
  online?: boolean;
  busy?: boolean;
  lowPriority?: string;
  walled?: boolean;
  contextTokens?: number;
  lp?: { resetsAt?: string; allowancePct?: number; offer?: boolean };
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function stateLine(a: StateAgent): string {
  const bits: string[] = [a.online ? "在线" : "离线"];
  if (a.runtime && a.runtime !== "claude-code") bits.push(a.runtime);
  if (a.busy !== undefined && a.online) bits.push(a.busy ? "忙" : "闲");
  if (a.walled) bits.push(`撞墙等待${a.lp?.resetsAt ? `（${a.lp.resetsAt} 恢复）` : ""}${a.lp?.offer ? "，可开 LP" : ""}`);
  if (a.lowPriority === "on") bits.push(`LP 开${a.lp?.resetsAt ? `（到 ${a.lp.resetsAt}）` : ""}${a.lp?.allowancePct !== undefined ? `，LP 额度余 ${a.lp.allowancePct}%` : ""}`);
  else if (a.lowPriority === "unknown" && a.online && a.runtime === "claude-code") bits.push("LP 状态看不清");
  if (typeof a.contextTokens === "number" && a.contextTokens > 0) bits.push(`上下文 ${kTokens(a.contextTokens)}`);
  return `- ${bareName(a.name)}${a.project ? ` [${a.project}]` : ""}：${bits.join(" · ")}`;
}

export function formatFleetState(r: { agents?: StateAgent[] }): string {
  const agents = r.agents ?? [];
  if (!agents.length) return "你能操作的范围里没有 agent。";
  return [`你能操作的 ${agents.length} 个 agent：`, ...agents.map(stateLine)].join("\n");
}

interface RunReport {
  dryRun?: boolean;
  summary?: string;
  excluded?: { name: string; reason: string }[];
  targets?: string[];
}

export function formatFleetRun(r: RunReport): string {
  if (!r.dryRun) return r.summary ?? "执行完了（bridge 没给汇总）";
  const ex = (r.excluded ?? []).map((e) => `- ${e.name}：不做（${e.reason}）`);
  const next = r.targets?.length ? "确认无误后，同样的参数加 dryRun:false 真执行。" : "没有选中任何 agent，不用执行。";
  return [r.summary ?? "预演完成", ...ex, next].join("\n");
}

/** channel-server 的 case "fleet"：bridge 报错（没权限、参数不对）原样当工具错误返回，调用方看得到原因 */
export async function fleetTool(bridgeRequest: BridgeRequest, args: Record<string, unknown> = {}) {
  const b = buildFleetRequest(args);
  if (!b.ok) return { content: [{ type: "text" as const, text: b.error }], isError: true };
  try {
    const r = await bridgeRequest(b.msg, b.timeoutMs);
    return { content: [{ type: "text" as const, text: b.msg.type === "fleet_state" ? formatFleetState(r ?? {}) : formatFleetRun(r ?? {}) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}
