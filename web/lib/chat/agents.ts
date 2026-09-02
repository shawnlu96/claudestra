import { bridgeGet, MASTER_AGENT_NAME } from "./bridge-api";

export { MASTER_AGENT_NAME };

/**
 * Web 会话 = claudestra 的一个 agent。
 *
 * 2026-07-10 迁移：列表来源从「BFF 直读 registry.json + /web/master」换成
 * Bridge 的 GET /api/v1/agents（token scope 过滤；master 显式列入 scope 时
 * 由 Bridge 置入列表，fork 增强）。BFF 不再碰 registry / 文件系统。
 */
export interface AgentSession {
  /** agent 名，作为会话 id（大总管用保留名 __master__） */
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  status: "active" | "stopped";
  /** 大总管置顶入口——不可 kill/restart，列表第一位。 */
  pinnedMaster?: boolean;
  /** 遗留字段（mock 模式已随 /api/v1 迁移移除，恒为 undefined）。 */
  mock?: boolean;
  /** 最近活动时间（session jsonl mtime，ms epoch）；列表按它降序。 */
  lastActivityTs?: number | null;
  /** 正在干活（tmux 非空闲）——列表状态点显黄色（2026-07-13 owner 需求）。 */
  busy?: boolean;
  /** v2.21.2+ 正在压缩上下文。 */
  compacting?: boolean;
  /** 当前上下文占用 token 数（TopBar 超标提示） */
  contextTokens?: number | null;
  /** 当前模型 id */
  model?: string | null;
  /** 当前 effort 档位 */
  effort?: string | null;
  /** v2.21+ 归属 project id（master 无；侧栏按它分组） */
  projectId?: string | null;
}

interface ApiAgent {
  name: string;
  status?: string;
  idle?: boolean;
  purpose?: string;
  /** agent 当前 session jsonl 的 mtime（ms epoch），Bridge fork 字段；无 session 为 null */
  lastActivityTs?: number | null;
  /** 正在回合中（Bridge hook 驱动的 agent_status，比 tmux idle 探测可靠） */
  busy?: boolean;
  /** v2.21.2+ 正在压缩上下文（agent_status=compacting） */
  compacting?: boolean;
  /** 当前上下文占用 token 数（最近一条 assistant 的 usage 合计） */
  contextTokens?: number | null;
  /** 当前模型 id（jsonl 实测 → registry → 全局默认） */
  model?: string | null;
  /** 当前 effort 档位（同上兜底链） */
  effort?: string | null;
  /** agent 创建时间（ISO，registry.created）——新建但还没说过话的 agent 靠它排序 */
  created?: string;
  /** v2.21+ 归属 project id */
  projectId?: string | null;
}

/**
 * 读取 agent 列表（GET /api/v1/agents）。
 * master（token scope 显式含 "master" 时 Bridge 会置入）映射为置顶的 __master__。
 * Bridge 不可达时抛错（由路由层转成 5xx；不再有 mock 回退）。
 */
export async function loadAgents(): Promise<AgentSession[]> {
  // include=stopped：已停止的 agent 也入列（保留入口，历史经归档 API 仍可读）
  const json = await bridgeGet<{ ok: boolean; agents: ApiAgent[] }>(
    "/agents?include=stopped",
    { timeoutMs: 5000 }
  );
  const list = (json.agents || []).map((a): AgentSession => {
    if (a.name === "master") {
      return {
        name: MASTER_AGENT_NAME,
        displayName: "大总管",
        purpose: a.purpose || "调度员：管理/派发多个 agent",
        cwd: "",
        status: a.status === "stopped" ? "stopped" : "active",
        pinnedMaster: true,
        lastActivityTs: a.lastActivityTs ?? null,
        busy: a.busy === true,
        compacting: a.compacting === true,
        contextTokens: a.contextTokens ?? null,
        model: a.model ?? null,
        effort: a.effort ?? null,
      };
    }
    const bare = a.name.replace(/^agent-/, "");
    return {
      name: bare,
      displayName: bare,
      purpose: a.purpose || "",
      cwd: "",
      status: a.status === "stopped" ? "stopped" : "active",
      // 刚建出来的 agent 还没说过话，jsonl 没内容 → lastActivityTs 为 null，
      // 而排序用 `?? 0` 兜底，于是新 agent 直接沉到列表最底下（owner 2026-07-25
      // 报「新建的能不能放最前面」）。用创建时间兜底：没活动过就按建的时间排，
      // 刚建的自然在最上面，一旦说过话就被真实活动时间接管。
      lastActivityTs: a.lastActivityTs ?? (a.created ? Date.parse(a.created) || null : null),
      // Bridge 的 busy（hook 驱动）优先；老 bridge 无此字段时退回 idle 探测
      busy: a.status !== "stopped" && (a.busy ?? a.idle === false),
      compacting: a.status !== "stopped" && a.compacting === true,
      contextTokens: a.contextTokens ?? null,
      model: a.model ?? null,
      effort: a.effort ?? null,
      projectId: a.projectId ?? null,
    };
  });
  // 排序：master 置顶 → 其余按最近活动降序（无时间戳的沉底，registry 序兜底稳定）
  return list.sort((a, b) => {
    const pin = Number(!!b.pinnedMaster) - Number(!!a.pinnedMaster);
    if (pin) return pin;
    return (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0);
  });
}
