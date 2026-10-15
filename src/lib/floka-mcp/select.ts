/**
 * 一次启动该用哪个 MCP 服务名（纯函数，不读写文件；落盘见 store.ts，接线见 launch.ts）。
 * - 显式 MCP_NAME 永远生效（与改造前同一语义）；旧族名与从本系统启动前缀继承来的族名不算显式（explicitMcpName）。
 *   显式的若是新族 floka，同样按会话记下（含续接），覆盖去掉后续接仍认 floka；自定义名不属于任何族，不记。
 * - 续接 / 分叉：沿用该会话记下的族，没记过的（rename.mcp 打开前就有的会话）一律旧族——不随档位变，回滚也不改。
 * - 全新会话：on 用新族，off / observe 用旧族（observe 另报 on 会用什么）。
 * - 新族而启动前不知道会话 id 的（分叉、无 id 的全新启动）：launch.ts 现取一个 id 用 --session-id 钉住再记，
 *   记录永远绑在真正起出来的那个会话上；不按 agent 名「待认领」，续接别的旧会话不会被认成新族。
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
}

type McpSource = "explicit" | "session" | "legacy" | "default";

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
  /** 新族但会话 id 要等 CC 起来才知道（分叉、无 id 全新）：由 launch.ts 先取 id 钉住再记 */
  needsSessionId?: true;
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
    return i.stored ? { name: i.stored, family: i.stored, source: "session" } : { name: LEGACY_FAMILY, family: LEGACY_FAMILY, source: "legacy" };
  }
  // 分叉出来的是新会话，id 由 CC 现取：新族要先钉住 id
  if (i.kind === "fork") return withRecord({ name: i.stored ?? LEGACY_FAMILY, family: i.stored ?? LEGACY_FAMILY, source: i.stored ? "session" : "legacy" });
  const f = mode === "on" ? NEW_FAMILY : LEGACY_FAMILY;
  return withRecord({ name: f, family: f, source: "default" }, i.sessionId);
}

/** 新族才要记：知道 id 就记它，不知道就让 launch.ts 取一个 */
function withRecord(c: McpChoice, sessionId?: string): McpChoice {
  if (c.family === LEGACY_FAMILY || c.family === null) return c;
  return sessionId ? { ...c, recordSession: { sessionId, family: c.family } } : { ...c, needsSessionId: true };
}

export function selectMcpName(i: McpSelectInput): McpChoice {
  if (i.explicit) {
    // 显式 floka 起的也是新族工具目录：照样按会话记下（分叉的新 id 现取），去掉覆盖后续接不会掉回旧族，bridge 也据此认前缀
    const c: McpChoice = { name: i.explicit, family: isMcpFamily(i.explicit) ? i.explicit : null, source: "explicit" };
    return withRecord(c, i.kind === "fork" ? undefined : i.sessionId);
  }
  if (i.mode === "on") return decide(i, "on");
  const actual = decide(i, "off");
  return i.mode === "observe" ? { ...actual, would: decide(i, "on").family ?? undefined } : actual;
}
