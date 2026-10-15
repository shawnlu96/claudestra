/**
 * Claude Code 启动命令里与 MCP 服务名有关的那几截（lib/claude-launch.ts buildClaudeCommand 一行调用）。
 * 旧族 / 显式名：与改造前逐字节相同——服务来自用户级 `claude mcp add` 注册，命令里只有名字。
 * 新族：用户级注册的仍是旧族，CC 会照样起它，所以本会话
 *   ① --settings 带 deniedMcpServers 拒掉其它族名（CC 2.1.299 实测：--settings 里的拒绝名单对用户级注册生效），
 *   ② --mcp-config 带一份新族名的 channel-server（有启动凭据时就是凭据那份，同一项不重复给），
 *   ③ permissions.allow 加新族通配（非 bypass 的会话不为新名弹授权；用户级旧族 allow 不动）。
 * 每个 agent 因此只起一个可注册的 channel-server。改档位不碰在跑的会话：旧 stdio 服务不退出、不替换，只影响之后的启动。
 */
import { readConfigSync } from "../config-store.js";
import { resolveBunPath } from "../bun-path.js";
import { ccCallerCredArgs } from "../caller-cred-launch.js";
import { SRC_DIR } from "../repo-root.js";
import { channelServerEntry } from "../sandbox-env.js";
import { LEGACY_FAMILY, MCP_FAMILIES, mcpToolPrefix, parseRenameMcpMode, type McpFamily, type RenameMcpMode } from "./families.js";
import { explicitMcpName, selectMcpName, type LaunchKind, type McpChoice } from "./select.js";
import { readPendingFamily, readSessionFamily, writeObserveReport, writePendingFamily, writeSessionFamily } from "./store.js";

export interface McpLaunchRequest {
  /** agent-settings 用的名字（registry 名 / master）：待认领记录与 observe 报告挂在它名下 */
  agent?: string;
  sessionId?: string;
  resumeId?: string;
  forkSession?: boolean;
}

export interface McpLaunchDeps {
  mode: () => RenameMcpMode;
  env: Record<string, string | undefined>;
  readSession: (id: string | undefined) => McpFamily | null;
  readPending: (agent: string | undefined) => McpFamily | null;
  writeSession: (id: string, family: McpFamily, agent: string | undefined) => void;
  writePending: (agent: string, family: McpFamily | null) => void;
  observe: (agent: string, report: Record<string, unknown>) => void;
  log: (line: string) => void;
}

const liveMcpLaunchDeps: McpLaunchDeps = {
  mode: () => parseRenameMcpMode(readConfigSync()),
  env: process.env,
  readSession: (id) => readSessionFamily(id),
  readPending: (agent) => readPendingFamily(agent),
  writeSession: (id, family, agent) => writeSessionFamily(id, family, agent),
  writePending: (agent, family) => writePendingFamily(agent, family),
  observe: (agent, report) => writeObserveReport(agent, report),
  log: (line) => console.error(line),
};

const kindOf = (r: McpLaunchRequest): LaunchKind => (r.resumeId ? (r.forkSession ? "fork" : "resume") : "new");

/** 选名并落盘。新族记不下来就退回旧族：不能起了新名、下次续接却认不出它 */
export function planMcpLaunch(r: McpLaunchRequest, d: McpLaunchDeps = liveMcpLaunchDeps): McpChoice & { mode: RenameMcpMode } {
  const mode = d.mode();
  const kind = kindOf(r);
  const sessionId = r.resumeId ?? r.sessionId;
  const explicit = explicitMcpName(d.env);
  const c = selectMcpName({
    mode, explicit, kind, sessionId,
    stored: kind === "new" || explicit ? null : d.readSession(sessionId),
    pending: kind === "resume" && !explicit ? d.readPending(r.agent) : null,
  });
  try {
    if (c.recordSession) d.writeSession(c.recordSession.sessionId, c.recordSession.family, r.agent);
    if (c.pending !== undefined && r.agent) d.writePending(r.agent, c.pending);
    else if (c.pending && !r.agent) throw new Error("没有 agent 名，分叉 / 无 id 启动的族没处记");
  } catch (e) {
    if (c.family !== LEGACY_FAMILY && c.source !== "explicit") {
      d.log(`⚠ [rename.mcp] ${r.agent ?? "?"} 的命名族记不下来，本次按 ${LEGACY_FAMILY} 启动：${(e as Error).message}`);
      return { mode, name: LEGACY_FAMILY, family: LEGACY_FAMILY, source: "legacy" };
    }
    d.log(`⚠ [rename.mcp] ${r.agent ?? "?"} 清待认领记录失败（本次照常按 ${c.name}）：${(e as Error).message}`);
  }
  if (mode === "observe" && r.agent) {
    try {
      d.observe(r.agent, { kind, session: sessionId ?? null, actual: c.name, source: c.source, would: c.would ?? c.name });
    } catch (e) {
      d.log(`⚠ [rename.mcp] observe 报告没写成（${r.agent}），启动不受影响：${(e as Error).message}`);
    }
  }
  return { ...c, mode };
}

/** 这次是否由本模块接管服务配置（新族且不是显式名）；否则命令与改造前相同 */
const ownsServer = (c: McpChoice): boolean => c.source !== "explicit" && c.family !== null && c.family !== LEGACY_FAMILY;

/** 启动前缀里 MCP_NAME 之后追加的一截：on 档的显式名带上来源，会话里再起的 manager 才认得出它是显式的 */
export function mcpEnvSuffix(c: McpChoice & { mode: RenameMcpMode }): string {
  return c.source === "explicit" && c.mode === "on" ? " MCP_NAME_SOURCE=explicit" : "";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 合进 --settings 的：拒掉其它族名 + 新族工具通配 allow；与已有键合并去重（已有的在前） */
export function withMcpFamilySettings(own: Record<string, unknown>, c: McpChoice): Record<string, unknown> {
  if (!ownsServer(c)) return own;
  const denied = Array.isArray(own.deniedMcpServers) ? own.deniedMcpServers : [];
  const deny = MCP_FAMILIES.filter((f) => f !== c.name && !denied.some((x) => isObj(x) && x.serverName === f)).map((serverName) => ({ serverName }));
  const perm = isObj(own.permissions) ? own.permissions : {};
  const allow = Array.isArray(perm.allow) ? perm.allow.filter((s): s is string => typeof s === "string") : [];
  return { ...own, deniedMcpServers: [...denied, ...deny], permissions: { ...perm, allow: [...new Set([...allow, `${mcpToolPrefix(c.name)}*`])] } };
}

/**
 * --mcp-config：有启动凭据 = 凭据那份（名字跟着本次服务名）；没凭据时新族自带一份；沙箱没凭据时由 sandboxLaunchArgs 给（严格模式）。
 * 旧族 / 显式名没凭据 → 空，与改造前相同。
 */
export function mcpConfigArgs(c: McpChoice, credFile: string | undefined, sandbox: boolean): string[] {
  if (credFile) return ccCallerCredArgs(credFile, c.name);
  if (sandbox || !ownsServer(c)) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers: { [c.name]: channelServerEntry(resolveBunPath(), SRC_DIR, false) } })];
}
