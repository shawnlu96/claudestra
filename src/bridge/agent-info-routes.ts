/**
 * /api/v1/agents/:name/info（GET）、/external（POST）、/label（POST，显示名）——web「会话详情」弹窗的后端
 * （owner 2026-09-27）。只给全权且非 peer 的 token：详情里有本机路径 / sessionId / Discord 频道，peer 不该看到
 * （老版本能给 peer 签 "*" scope，只看 isFullScope 会把这种历史 token 放进来）。
 * 关闭 external 时若该 agent 正在某个 peer 的 scope 里，必须带 confirm=<会话名>（逐字符相等）才执行，
 * 否则 409 并回 sharedWith 让前端弹确认。改动本身走 runManager("external")，bridge 不直写 registry。
 * registry / principals 的读取可注入：tests/agent-info-routes.test.ts 用假数据覆盖鉴权与确认分支。
 */
import { existsSync } from "node:fs";
import { USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import type { Principal, PrincipalsFile } from "../lib/principals.js";
import { agentInScope, canRunFleet, readPrincipals } from "../lib/principals.js";
import { isMasterName, readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { missionKey, readMissions, type MissionMap } from "../lib/missions.js";
import { peersSharingAgent } from "../lib/peer-scope-gate.js";
import { heldAgentCounts } from "./held-queue.js";
import { canReadLedger } from "../lib/devices.js";
import { activeTasksByAgent, type LedgerTaskRef } from "../lib/ledger-read.js";
import { ledgerDb } from "./ledger-feed.js";
import { lpField } from "./fleet/lp-monitor.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody } from "./api-respond.js";

type RunManager = (...args: string[]) => Promise<any>;

export interface AgentInfoIo {
  readRegistryAgents: () => Promise<RegistryAgent[]>;
  readPrincipals: () => Promise<PrincipalsFile>;
  /** Autopilot 状态（lib/missions.ts）；单测不给 = 没有 Autopilot */
  readMissions?: () => Promise<MissionMap>;
  /** 各频道排队中的 agent 消息数（bridge/held-queue.ts）；单测不给 = 都没排队 */
  heldCounts?: () => Record<string, number>;
  /** 裸名 → 执行中的台账任务（lib/ledger-read.ts）；单测不给 = 台账里没有 */
  ledgerTasks?: () => Map<string, LedgerTaskRef>;
}
const defaultIo: AgentInfoIo = {
  readRegistryAgents: () => readRegistryAgents(), readPrincipals: () => readPrincipals(), readMissions: () => readMissions(), heldCounts: () => heldAgentCounts(),
  ledgerTasks: () => {
    const db = ledgerDb();
    return db ? activeTasksByAgent(db) : new Map();
  },
};

/** GET /agents 每一行的附加字段：external 闸门、显示名、已归档；「共享给几个 peer」只给全权非 peer（与详情同一道门） */
export type AgentListExtras = (name: string, r?: Pick<RegistryAgent, "external" | "label" | "channelId" | "parent" | "task" | "kind">) => Record<string, unknown>;

/**
 * 已归档：归档区里有这个 agent 的目录 ⇒ 网页把它从工作列表隐藏（归档 = 收起来，不是删掉；恢复时目录被清掉，自然回到列表）。
 * 不靠 kill：列表本来就包含已停止的 agent（灰点），光停窗口移不出去。sharedPeers 对 peer / 受限 token 不给——谁在共享是 owner 的事。
 */
export async function agentListExtras(principal: Principal, io: Pick<AgentInfoIo, "readPrincipals" | "readMissions" | "heldCounts" | "ledgerTasks"> = defaultIo): Promise<AgentListExtras> {
  const full = isFullScope(principal) && !principal.peer;
  const principals = full ? (await io.readPrincipals()).principals : [];
  const missions = principal.peer ? {} : ((await io.readMissions?.()) ?? {});
  const held = principal.peer ? {} : (io.heldCounts?.() ?? {}); // 排队几条：本机的事，不给 peer
  const ledger = canReadLedger(principal) ? readLedgerTasks(io) : null; // 台账同一道门：部分 scope / guest / peer 连库都不查
  const archived = (name: string) => existsSync(`${USER_ARCHIVE_ROOT}/${name.replace(/^agent-/, "")}`);
  return (name, r) => {
    const sharedWith = full ? peersSharingAgent(principals, name) : null;
    return {
      external: r?.external === true,
      kind: r?.kind ?? null,
      label: r?.label ?? null,
      archived: archived(name),
      // 顶栏徽章的数字 + 悬停时的 peer 名单（owner 2026-09-28）
      ...(sharedWith ? { sharedPeers: sharedWith.length, sharedWith } : {}),
      ...missionField(missions, name),
      // 别的 agent 发来、它还在回合里没收到的消息（等回合结束或它调 check_inbox 才到）
      ...(r?.channelId && held[r.channelId] ? { queued: held[r.channelId] } : {}),
      ...teamField(principal, r),
      ...ledgerField(ledger, name),
      ...(canRunFleet(principal) ? lpField(name) : {}), // low-priority 状态（fleet/lp-monitor.ts 的缓存）：和批量管理同一道门，只给 owner 的全权设备
    };
  };
}

/**
 * 派发关系（manager/team.ts）：侧栏把执行者挂在派发者下面。parent 只在调用方 scope 里看得到派发者时给（裸名，大总管 = master），
 * 否则名字本身就泄露了 scope 外的 agent；peer 两项都不给（和 Autopilot 一样是本机的事）。展示用，不参与授权。
 */
function teamField(principal: Principal, r?: Pick<RegistryAgent, "parent" | "task">): { parent?: string; task?: string } {
  if (principal.peer || !r) return {};
  const parent = r.parent && agentInScope(principal, r.parent) ? r.parent.replace(/^agent-/, "") : undefined;
  return { ...(parent ? { parent } : {}), ...(r.task ? { task: r.task } : {}) };
}

/** 上一次读台账任务是否失败：日志只在「正常 → 出错」和恢复时各打一次，库坏着时每次刷列表不重复报 */
let ledgerFailing = false;

/** 执行者行尾的阶段小标（docs 10-ledger §4；与 T4 的 task 字符串不同名）。台账读不了只是少了小标，列表照常出 */
function readLedgerTasks(io: Pick<AgentInfoIo, "ledgerTasks">): Map<string, LedgerTaskRef> | null {
  try {
    const r = io.ledgerTasks?.() ?? null;
    if (ledgerFailing) console.log("📒 GET /agents 读台账任务恢复");
    ledgerFailing = false;
    return r;
  } catch (e) {
    if (!ledgerFailing) console.error(`⚠️ GET /agents 读台账任务失败（列表先不带 ledgerTask，恢复前不再重复报）: ${(e as Error).message}`);
    ledgerFailing = true;
    return null;
  }
}

function ledgerField(ledger: Map<string, LedgerTaskRef> | null, name: string): { ledgerTask?: LedgerTaskRef } {
  const t = ledger?.get(name.replace(/^agent-/, ""));
  return t ? { ledgerTask: t } : {};
}

/** 进行中的 Autopilot（侧栏 / 顶栏「Autopilot → 11:00」、菜单切换「开启 / 关闭 Autopilot」）；peer 看不到 */
function missionField(missions: MissionMap, name: string): { mission?: Record<string, unknown> } {
  const m = missions[missionKey(name)];
  if (!m || m.status !== "active") return {};
  return { mission: { goal: m.goal, until: m.until, nudges: m.nudges, ...(m.resumeAt ? { resumeAt: m.resumeAt } : {}), ...(m.lastNudgeAt ? { lastNudgeAt: m.lastNudgeAt } : {}) } };
}

export async function handleAgentInfoRoutes(
  req: Request,
  path: string,
  principal: Principal,
  runManager: RunManager,
  io: AgentInfoIo = defaultIo,
): Promise<Response | null> {
  const m = path.match(/^\/agents\/([^/]+)\/(info|external|label)$/);
  if (!m) return null;
  if (!isFullScope(principal) || principal.peer) return forbidden(`agent ${m[2]} requires a full-scope (non-peer) token`);
  const bare = decodeURIComponent(m[1]).replace(/^agent-/, "");
  if (isMasterName(bare)) return apiJson(400, { ok: false, error: "master has no registry details" });
  const [agents, pf] = await Promise.all([io.readRegistryAgents(), io.readPrincipals()]);
  const a = agents.find((x) => x.name === `agent-${bare}` || x.name === bare);
  if (!a) return apiJson(404, { ok: false, error: `agent "${bare}" not found` });
  const sharedWith = peersSharingAgent(pf.principals, bare);
  if (m[2] === "info" && req.method === "GET") {
    const raw = a as unknown as Record<string, unknown>;
    return apiJson(200, {
      ok: true,
      agent: {
        name: bare,
        displayName: a.displayName ?? null,
        label: a.label ?? null,
        purpose: a.purpose ?? "",
        cwd: a.cwd ?? null,
        status: a.status ?? null,
        sessionId: a.sessionId ?? null,
        channelId: a.channelId ?? null,
        projectId: a.projectId ?? null,
        kind: a.kind ?? null,
        runtime: a.runtime ?? "claude-code",
        model: a.model ?? null,
        effort: a.effort ?? null,
        created: typeof raw.created === "string" ? raw.created : null,
        external: a.external === true,
        sharedWith,
      },
    });
  }
  if (m[2] === "external" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const on = body?.on === true;
    if (!on && sharedWith.length && String(body?.confirm ?? "") !== bare) {
      return apiJson(409, { ok: false, error: `agent "${bare}" 正共享给 peer：${sharedWith.join(", ")}——关闭需输入会话名确认`, sharedWith, needConfirm: true });
    }
    const r = await runManager("external", bare, on ? "on" : "off");
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  if (m[2] === "label" && req.method === "POST") {
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    if (typeof body?.label !== "string") return apiJson(400, { ok: false, error: '"label" (string) required' });
    const r = await runManager("label", bare, body.label);
    return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}
