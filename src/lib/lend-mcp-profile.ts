/**
 * channel-server 的 lend 档（i28-W4）：出借 worker（agent-lend-*）只看得见、也只调得了派单那几个工具和 whoami，别的工具不列、调用一律拒。
 * 开档看两样，任一成立就开：`CLAUDESTRA_MCP_PROFILE=lend`（ACP clean 宿主设的，lib/acp/adapter-proc.ts），或 agent 名是出借 worker 的前缀——
 * 档位变量在哪一环被丢了也不会退回全量工具。档位变量是别的值 = 认不出的档，一个工具都不给（fail closed）。
 * 这是第一层；回环代理（lib/acp/tool-proxy.ts）和 bridge（bridge/lend-tools.ts）各自再拦一次。tests/lend-mcp-profile.test.ts。
 */
import { isLendWorkerName } from "./runtimes/clean-env.js";

export const MCP_PROFILE_ENV = "CLAUDESTRA_MCP_PROFILE";
export const LEND_PROFILE = "lend";

/** lend 档能用的工具：派单五个（bridge 侧再按单子的步骤收窄）+ 只读身份探针 */
export const LEND_ORDER_TOOLS: readonly string[] = ["take_order", "deliver", "ask", "take_review", "submit_verdict"];
export const LEND_MCP_TOOLS: ReadonlySet<string> = new Set([...LEND_ORDER_TOOLS, "whoami"]);

type Env = Record<string, string | undefined>;
type Profile = "full" | "lend" | "none";

export function mcpProfile(env: Env = process.env): Profile {
  const p = env[MCP_PROFILE_ENV]?.trim() ?? "";
  if (p && p !== LEND_PROFILE) return "none";
  return p === LEND_PROFILE || isLendWorkerName(env.CLAUDESTRA_AGENT) ? "lend" : "full";
}

/** lend 档里 submit_verdict 的 reportPath 是工作副本里的报告（不是本机 ledger/reviews/），描述跟着改，别的字段原样 */
const LEND_REPORT_PATH = "报告文件的路径：当前目录（这张单的工作副本）里的普通文件，相对路径或副本内的绝对路径，非空、≤ 64 KiB，不能是软链";

function forLend<T extends { name: string }>(t: T): T {
  if (t.name !== "submit_verdict") return t;
  const schema = (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema;
  const props = schema?.properties;
  if (!props?.reportPath) return t;
  return { ...t, inputSchema: { ...schema, properties: { ...props, reportPath: { type: "string", description: LEND_REPORT_PATH } } } };
}

/** tools/list 的过滤：全量档原样，lend 档只留白名单，认不出的档什么都不给 */
export function profileTools<T extends { name: string }>(tools: T[], env: Env = process.env): T[] {
  const p = mcpProfile(env);
  if (p === "full") return tools;
  return p === "lend" ? tools.filter((t) => LEND_MCP_TOOLS.has(t.name)).map(forLend) : [];
}

/** tools/call 的拦截：这个档不给的工具回一条 isError（不抛错：模型看得见原因，也不会当成连接坏了重试）；给的返回 null */
export function profileRefusal(name: string, env: Env = process.env): { content: { type: "text"; text: string }[]; isError: true } | null {
  const p = mcpProfile(env);
  if (p === "full" || (p === "lend" && LEND_MCP_TOOLS.has(name))) return null;
  const text = p === "lend"
    ? `出借 worker 只能用 ${[...LEND_MCP_TOOLS].join(" / ")}，不提供 ${name.slice(0, 60)}`
    : `认不出的工具档 ${MCP_PROFILE_ENV}，一个工具都不给`;
  return { content: [{ type: "text", text }], isError: true };
}
