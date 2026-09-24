import { bridgeGet, MASTER_AGENT_NAME } from "./bridge-api";

export { MASTER_AGENT_NAME };

/**
 * Web 会话 = claudestra 的一个 agent。
 *
 * 2026-07-10 迁移：列表来源从「BFF 直读 registry.json + /web/master」换成
 * Bridge 的 GET /api/v1/agents（token scope 过滤；master 显式列入 scope 时
 * 由 Bridge 置入列表，fork 增强）。BFF 不再碰 registry / 文件系统。
 */
/** 会话级「该重启 / 该 pi update」提示（bridge lib/update-hints.ts 算好透传） */
export type UpdateHint =
  | { kind: "restart"; running: string; installed: string }
  | { kind: "pi-update"; installed: string; latest: string };

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
  /** v2.23+ 运行时："pi" = Pi 会话（模型/effort 走 provider 配置，不给 CC 的切换面板） */
  runtime?: string | null;
  /** 当前 effort 档位 */
  effort?: string | null;
  /** v2.21+ 归属 project id（master 无；侧栏按它分组） */
  projectId?: string | null;
  updateHint?: UpdateHint | null;
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
  /** v2.23+ 运行时（同上） */
  runtime?: string | null;
  /** 当前 effort 档位（同上兜底链） */
  effort?: string | null;
  /** agent 创建时间（ISO，registry.created）——新建但还没说过话的 agent 靠它排序 */
  created?: string;
  /** v2.21+ 归属 project id */
  projectId?: string | null;
  updateHint?: UpdateHint | null;
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
  const list = (json.agents || [])
    // 大总管在桥接侧有**多个来源**（注册表历史条目 `agent-master`、api-routes 的
    // master 注入、cmdList 的补条目）——不去重时侧栏会冒出「大总管卡片 + 一条
    // 分组里的 master」（owner 2026-09-14 手机截图实报）。这里收敛成一条：
    // 丢掉 `agent-master` 这种带前缀的历史条目，同名只保留**第一个带 runtime 的**
    .filter((a) => !/^agent-master$/.test(String(a.name || "")))
    .filter((a) => {
      const bare = String(a.name || "").replace(/^agent-/, "");
      if (bare !== "master") return true;
      if (typeof a.runtime === "string" && a.runtime) return true;
      // runtime 为空的 master 条目（旧注入路径）在有带 runtime 的那条时丢弃
      return !(json.agents || []).some(
        (b) => String(b.name || "").replace(/^agent-/, "") === "master" && typeof b.runtime === "string" && b.runtime,
      );
    })
    // 已归档的 agent 不进工作列表（owner 2026-09-14「被归档，但是还是在列表里」）：
    // 归档区里有它的目录 = 被收起来了；恢复（清掉归档目录）后自动回来。
    .filter((a) => (a as { archived?: boolean }).archived !== true)
    .map((a): AgentSession => {
    if (a.name === "master") {
      return {
        // ⚠ 展开桥接的原始字段再覆盖 —— 这个映射此前是**逐项挑字段**的，桥接新增
        // 一个字段（runtime / contextTokens …）忘了在这里加，网页就永远读不到
        // （2026-09-14 一天内踩了两次：Pi 徽章不显示、Pi 只读模型面板不生效）。
        // 展开之后新字段自动流过，只有需要**改名/兜底**的才在后面显式写。
        ...a,
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
        runtime: a.runtime ?? null,
        effort: a.effort ?? null,
      };
    }
    const bare = a.name.replace(/^agent-/, "");
    return {
      ...a, // 同上：新字段自动流过，别改回逐项挑
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
      runtime: a.runtime ?? null,
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
