/**
 * Claude Code 启动命令里与 MCP 服务名有关的那几截（lib/claude-launch.ts buildClaudeCommand 一行调用）。
 * 旧族 / 自定义显式名：与改造前逐字节相同——服务来自用户级 `claude mcp add` 注册，命令里只有名字。
 * 新族（含显式指定的 floka）：用户级注册的仍是旧族，CC 会照样起它，所以本会话
 *   ① --settings 带 deniedMcpServers 拒掉其它族名（CC 2.1.299 实测：--settings 里的拒绝名单对用户级注册生效），
 *   ② --mcp-config 带一份新族名的 channel-server（有启动凭据时就是凭据那份，同一项不重复给），
 *   ③ permissions.allow 加新族通配（非 bypass 的会话不为新名弹授权；用户级旧族 allow 不动）。
 * 每个 agent 因此只起一个可注册的 channel-server。改档位不碰在跑的会话：旧 stdio 服务不退出、不替换，只影响之后的启动。
 */
import { randomUUID } from "node:crypto";
import { readConfigSync } from "../config-store.js";
import { resolveBunPath } from "../bun-path.js";
import { ccCallerCredArgs } from "../caller-cred-launch.js";
import { SRC_DIR } from "../repo-root.js";
import { channelServerEntry } from "../sandbox-env.js";
import { LEGACY_FAMILY, MCP_FAMILIES, mcpToolPrefix, parseRenameMcpMode, type McpFamily, type RenameMcpMode } from "./families.js";
import { explicitMcpName, selectMcpName, type LaunchKind, type McpChoice } from "./select.js";
import { readSessionFamily, writeObserveReport, writeSessionFamily } from "./store.js";

export interface McpLaunchRequest {
  /** agent-settings 用的名字（registry 名 / master）：observe 报告挂在它名下，会话记录里留作元数据 */
  agent?: string;
  sessionId?: string;
  resumeId?: string;
  forkSession?: boolean;
}

export interface McpLaunchDeps {
  mode: () => RenameMcpMode;
  env: Record<string, string | undefined>;
  readSession: (id: string | undefined) => McpFamily | null;
  writeSession: (id: string, family: McpFamily, agent: string | undefined) => void;
  newSessionId: () => string;
  observe: (agent: string, report: Record<string, unknown>) => void;
  log: (line: string) => void;
}

const liveMcpLaunchDeps: McpLaunchDeps = {
  mode: () => parseRenameMcpMode(readConfigSync()),
  env: process.env,
  readSession: (id) => readSessionFamily(id),
  writeSession: (id, family, agent) => writeSessionFamily(id, family, agent),
  newSessionId: () => randomUUID(),
  observe: (agent, report) => writeObserveReport(agent, report),
  log: (line) => console.error(line),
};

export type McpLaunchPlan = McpChoice & { mode: RenameMcpMode; assignedSessionId?: string };

const kindOf = (r: McpLaunchRequest): LaunchKind => (r.resumeId ? (r.forkSession ? "fork" : "resume") : "new");

/**
 * 选名并落盘。新族的会话 id 启动前未知（分叉、无 id 全新）时现取一个，经 mcpSessionIdArgs 用 --session-id 钉住，
 * 记录因此只绑在真正起出来的会话上。记不下来就退回旧族：不能起了新名、下次续接却认不出它。
 */
export function planMcpLaunch(r: McpLaunchRequest, d: McpLaunchDeps = liveMcpLaunchDeps): McpLaunchPlan {
  const mode = d.mode();
  const kind = kindOf(r);
  const sessionId = r.resumeId ?? r.sessionId;
  const explicit = explicitMcpName(d.env);
  const c = selectMcpName({ mode, explicit, kind, sessionId, stored: kind === "new" || explicit ? null : d.readSession(sessionId) });
  const assignedSessionId = c.needsSessionId ? d.newSessionId() : undefined;
  const record = c.recordSession ?? (assignedSessionId && c.family ? { sessionId: assignedSessionId, family: c.family } : undefined);
  try {
    if (record) d.writeSession(record.sessionId, record.family, r.agent);
  } catch (e) {
    d.log(`⚠ [rename.mcp] ${r.agent ?? "?"} 的命名族记不下来，本次按 ${LEGACY_FAMILY} 启动：${(e as Error).message}`);
    return { mode, name: LEGACY_FAMILY, family: LEGACY_FAMILY, source: "legacy" };
  }
  if (mode === "observe" && r.agent) {
    try {
      d.observe(r.agent, { kind, session: sessionId ?? null, actual: c.name, source: c.source, would: c.would ?? c.name });
    } catch (e) {
      d.log(`⚠ [rename.mcp] observe 报告没写成（${r.agent}），启动不受影响：${(e as Error).message}`);
    }
  }
  return { ...c, mode, ...(assignedSessionId ? { assignedSessionId } : {}) };
}

/** 本模块替新族会话取的会话 id（分叉接在 --fork-session 后，全新启动单独给）；没取就空，命令与改造前相同 */
export const mcpSessionIdArgs = (c: McpLaunchPlan): string[] => (c.assignedSessionId ? ["--session-id", c.assignedSessionId] : []);

/**
 * 这次是否由本模块接管服务配置：服务名是新族就接管，显式指定的 floka 也算——用户级注册的仍是旧族，不拒掉它就会起两个
 * channel-server（tests/floka-mcp.test.ts「explicit-floka」）。旧族 / 自定义显式名不接管，命令与改造前相同。
 */
const ownsServer = (c: McpChoice): boolean => c.family !== null && c.family !== LEGACY_FAMILY;

/**
 * 启动前缀里 MCP_NAME 之后追加的来源（explicitMcpName 认它）：新族会话标 family，会话里再起的 manager 不把继承的 floka 当显式；
 * on 档的显式名标 explicit，钉住的族名传给子启动。旧族 / off 档的显式名不加，命令与改造前相同。
 */
export function mcpEnvSuffix(c: McpLaunchPlan): string {
  if (c.source === "explicit") return c.mode === "on" ? " MCP_NAME_SOURCE=explicit" : "";
  return ownsServer(c) ? " MCP_NAME_SOURCE=family" : "";
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
