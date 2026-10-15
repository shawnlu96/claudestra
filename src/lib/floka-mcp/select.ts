/**
 * 一次启动该用哪个 MCP 服务名（纯函数，不读写文件；落盘见 store.ts，接线见 launch.ts）。
 * - 显式 MCP_NAME 永远生效（与改造前同一语义）；旧族名与从本系统启动前缀继承来的族名不算显式（explicitMcpName）。
 * - 续接 / 分叉：沿用该会话记下的族，没记过的（rename.mcp 打开前就有的会话）一律旧族——不随档位变，回滚也不改。
 * - 全新会话：on 用新族，off / observe 用旧族（observe 另报 on 会用什么）。
 * - 会话 id 启动前不知道的（分叉、无 id 的全新启动）记在 agent 名下，只给该 agent 下一次启动认领一次。
 */
import { LEGACY_FAMILY, NEW_FAMILY, isMcpFamily, type McpFamily, type RenameMcpMode } from "./families.js";

export type LaunchKind = "new" | "resume" | "fork";

export interface McpSelectInput {
  mode: RenameMcpMode;
  /** explicitMcpName 的结果：有值 = 运维显式指定的服务名 */
  explicit: string | null;
  kind: LaunchKind;
  /** new：本次的会话 id（launcher 起全新大总管时没有）；resume / fork：被续接 / 被分叉的会话 id */
  sessionId?: string;
  /** sessionId 记过的族（new 时不看） */
  stored: McpFamily | null;
  /** 该 agent 名下待认领的族（上一次启动不知道会话 id） */
  pending: McpFamily | null;
}

type McpSource = "explicit" | "session" | "pending" | "legacy" | "default";

export interface McpChoice {
  /** 本次真正用的服务名 */
  name: string;
  /** 显式指定的自定义名不属于任何族 → null */
  family: McpFamily | null;
  source: McpSource;
  /** observe：on 档这次会用的族 */
  would?: McpFamily;
  /** 要落盘的：会话记录（只记新族；旧族是没记录时的缺省，不用记） */
  recordSession?: { sessionId: string; family: McpFamily };
  /** agent 名下待认领：族 = 写新的；null = 清掉旧的；undefined = 不动（显式名的启动不碰） */
  pending?: McpFamily | null;
}

/**
 * 运维显式指定的服务名。旧族名 claudestra 不算：setup 向导把这个缺省值写进 .env（Bun 自动加载），旧会话的启动前缀也带它，
 * 算显式就等于 on 档永远不生效。新族会话的前缀带 MCP_NAME_SOURCE=family，会话里再起的 manager 继承到 floka 也不算；
 * 真要钉住某个族名，另设 MCP_NAME_SOURCE=explicit。其余自定义名照旧生效（与改造前同一语义）。
 */
export function explicitMcpName(env: Record<string, string | undefined>): string | null {
  const v = (env.MCP_NAME || "").trim();
  if (!v || env.MCP_NAME_SOURCE === "family") return null;
  if (env.MCP_NAME_SOURCE === "explicit") return v;
  return v === LEGACY_FAMILY ? null : v;
}

function decide(i: McpSelectInput, mode: "on" | "off"): McpChoice {
  if (i.kind === "resume") {
    if (i.stored) return { name: i.stored, family: i.stored, source: "session", pending: null };
    if (i.pending) return { name: i.pending, family: i.pending, source: "pending", pending: null, ...rec(i.sessionId, i.pending) };
    return { name: LEGACY_FAMILY, family: LEGACY_FAMILY, source: "legacy", pending: null };
  }
  if (i.kind === "fork") {
    const f = i.stored ?? LEGACY_FAMILY;
    return { name: f, family: f, source: i.stored ? "session" : "legacy", pending: f === LEGACY_FAMILY ? null : f };
  }
  const f = mode === "on" ? NEW_FAMILY : LEGACY_FAMILY;
  const known = !!i.sessionId;
  return { name: f, family: f, source: "default", pending: known || f === LEGACY_FAMILY ? null : f, ...rec(i.sessionId, f) };
}

function rec(sessionId: string | undefined, family: McpFamily): Pick<McpChoice, "recordSession"> {
  return sessionId && family !== LEGACY_FAMILY ? { recordSession: { sessionId, family } } : {};
}

export function selectMcpName(i: McpSelectInput): McpChoice {
  if (i.explicit) return { name: i.explicit, family: isMcpFamily(i.explicit) ? i.explicit : null, source: "explicit" };
  if (i.mode === "on") return decide(i, "on");
  const actual = decide(i, "off");
  return i.mode === "observe" ? { ...actual, would: decide(i, "on").family ?? undefined } : actual;
}
