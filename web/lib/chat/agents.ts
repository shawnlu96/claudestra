import { api } from "@/lib/api/client";

/** 值守（src/lib/missions.ts 的 Mission 子集，bridge GET /agents 的 mission 字段）：until / resumeAt 是 ISO */
export interface MissionInfo {
  goal: string;
  until: string;
  nudges: number;
  resumeAt?: string;
  lastNudgeAt?: string;
}

/** 台账里它正在执行的任务（bridge agent-info-routes.ts ledgerField，只给能读台账的凭据）→ 侧栏行尾阶段小标（features/chat/ledger-stage.ts） */
export interface LedgerTaskRef {
  id: string;
  stage: string;
  round: number;
}

/** GET /agents 的 ledgerTask 原样不可信（老 / 新 bridge、手改的库）：id 和 stage 不是字符串就当没挂任务，round 不是整数按 0 */
export function parseLedgerTask(raw: unknown): LedgerTaskRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.stage !== "string" || !r.stage) return null;
  return { id: r.id, stage: r.stage, round: Number.isInteger(r.round) ? (r.round as number) : 0 };
}

/** 大总管的前端保留名 ↔ API 的 "master"。 */
export const MASTER_AGENT_NAME = "__master__";

/** 前端会话名 → /api/v1 的 agent 名（__master__ → master，其余原样）。 */
export function apiAgentName(agent: string): string {
  return agent === MASTER_AGENT_NAME ? "master" : agent;
}

/** bridge 侧 agent 名（master / agent-xxx / xxx）→ 前端会话名 */
export function uiAgentName(name: string): string {
  return name === "master" ? MASTER_AGENT_NAME : name.replace(/^agent-/, "");
}

/**
 * Web 会话 = claudestra 的一个 agent。列表来源是 bridge 的 GET /api/v1/agents（凭据 grant 过滤；
 * master 在 grant 内时由 bridge 置入列表）。此前这段映射在 BFF（lib/chat/agents.ts 的服务端版）——托管前端后搬进浏览器，逻辑原样。
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
  /** 未读回复数（bridge 计数，跨设备一致）；0 / 缺省 = 无未读 */
  unread?: number;
  /** external 闸门（registry）：开了才能共享给 peer；详情弹窗 / Peer 面板用 */
  external?: boolean;
  /** 显示名（registry label，默认空）与共享给几个 peer——侧栏「显示名 | name」、顶栏 external 徽章角标 */
  label?: string | null;
  /** 全权 token 才有：共享给几个 / 哪些 peer */
  sharedPeers?: number;
  sharedWith?: string[];
  updateHint?: UpdateHint | null;
  /** 进行中的值守（bridge GET /agents 的 mission 字段）：侧栏图标 / 顶栏「截止 11:00」、菜单「开始 / 结束值守」 */
  mission?: MissionInfo | null;
  /** 别的 agent 发来、它还在回合里没收到的消息数（等回合结束或它调 check_inbox）→ 侧栏小标 */
  queued?: number;
  /** 派发者（前端会话名，大总管 = __master__）：侧栏把它挂在派发者下面（sidebar-entries.ts 构树）；调用方看不到派发者时 bridge 不下发 */
  parent?: string | null;
  /** 任务短名（≤40 字）→ 侧栏名字后的压淡小标 */
  task?: string | null;
  ledgerTask?: LedgerTaskRef | null;
}

interface ApiAgent {
  name: string;
  status?: string;
  /** 工作目录（registry.cwd）：侧栏标「所在仓」用（features/chat/agent-repo.ts） */
  cwd?: string;
  idle?: boolean;
  purpose?: string;
  lastActivityTs?: number | null;
  busy?: boolean;
  compacting?: boolean;
  contextTokens?: number | null;
  model?: string | null;
  runtime?: string | null;
  effort?: string | null;
  /** agent 创建时间（ISO，registry.created）——新建但还没说过话的 agent 靠它排序 */
  created?: string;
  projectId?: string | null;
  unread?: number;
  archived?: boolean;
  /** external 闸门（registry）：开了才能共享给 peer；详情弹窗 / Peer 面板用 */
  external?: boolean;
  /** 显示名（registry label，默认空）与共享给几个 peer——侧栏「显示名 | name」、顶栏 external 徽章角标 */
  label?: string | null;
  sharedPeers?: number;
  sharedWith?: string[];
  updateHint?: UpdateHint | null;
  mission?: MissionInfo | null;
  /** 派发者的裸名（大总管 = master）与任务短名（bridge agent-info-routes.ts teamField） */
  parent?: string | null;
  task?: string | null;
  /** 原样不可信，mapAgent 经 parseLedgerTask 过一遍 */
  ledgerTask?: unknown;
}

function mapAgent(a: ApiAgent): AgentSession {
  if (a.name === "master") {
    return {
      // ⚠ 展开原始字段再覆盖：逐项挑字段时 bridge 新增一个字段（runtime / contextTokens …）忘了加，网页就永远读不到
      // （2026-09-14 一天内踩了两次）。展开之后新字段自动流过，只有需要改名 / 兜底的才显式写。
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
      ledgerTask: parseLedgerTask(a.ledgerTask),
    };
  }
  const bare = a.name.replace(/^agent-/, "");
  return {
    ...a,
    name: bare,
    displayName: bare,
    purpose: a.purpose || "",
    cwd: a.cwd || "",
    status: a.status === "stopped" ? "stopped" : "active",
    // 刚建出来的 agent 还没说过话 → lastActivityTs 为 null 会沉底；用创建时间兜底，刚建的自然在最上面
    lastActivityTs: a.lastActivityTs ?? (a.created ? Date.parse(a.created) || null : null),
    // bridge 的 busy（hook 驱动）优先；老 bridge 无此字段时退回 idle 探测
    busy: a.status !== "stopped" && (a.busy ?? a.idle === false),
    compacting: a.status !== "stopped" && a.compacting === true,
    contextTokens: a.contextTokens ?? null,
    model: a.model ?? null,
    runtime: a.runtime ?? null,
    effort: a.effort ?? null,
    projectId: a.projectId ?? null,
    parent: a.parent ? uiAgentName(a.parent) : null,
    ledgerTask: parseLedgerTask(a.ledgerTask),
  };
}

/**
 * 读取 agent 列表（include=stopped：已停止的也入列，历史经归档 API 仍可读）。
 * 大总管在桥接侧有多个来源（历史条目 agent-master、注入的 master、cmdList 补条目）——只留一条：丢掉带前缀的历史条目，
 * 同名只保留第一个带 runtime 的（注入条目排最前、带实测字段）。已归档的不进工作列表。bridge 不可达时抛错（无 mock 回退）。
 */
export async function loadAgents(): Promise<AgentSession[]> {
  const json = await api<{ ok: boolean; agents: ApiAgent[] }>("/agents?include=stopped", { timeoutMs: 5000 });
  const all = (json.agents || []).filter((a) => !/^agent-master$/.test(String(a.name || "")));
  const isMaster = (a: ApiAgent) => String(a.name || "") === "master";
  const keepMaster = all.find((a) => isMaster(a) && typeof a.runtime === "string" && a.runtime) ?? all.find(isMaster);
  const list = all
    .filter((a) => !isMaster(a) || a === keepMaster)
    .filter((a) => a.archived !== true)
    .map(mapAgent);
  // 排序：master 置顶 → 其余按最近活动降序（无时间戳的沉底）
  return list.sort((a, b) => {
    const pin = Number(!!b.pinnedMaster) - Number(!!a.pinnedMaster);
    if (pin) return pin;
    return (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0);
  });
}

const ledgerSig = (lt?: LedgerTaskRef | null) => (lt ? `|${lt.id}:${lt.stage}:${lt.round}` : "");

/**
 * agentsSignature（features/chat/chat-store.ts）里不断新增的字段拼在这里：chat-store 只许缩，新字段加一处就好。
 * 漏掉的字段 = 列表轮询判「没变」、界面不更新（external / 显示名、值守标记都踩过）。
 */
export function agentExtraSig(a: AgentSession): string {
  const hint = a.updateHint ? JSON.stringify(a.updateHint) : "";
  const m = a.mission ? `${a.mission.until}|${a.mission.nudges}|${a.mission.resumeAt ?? ""}` : "";
  return hint + m + (a.queued ? `q${a.queued}` : "") + `|${a.parent ?? ""}|${a.task ?? ""}` + ledgerSig(a.ledgerTask);
}
