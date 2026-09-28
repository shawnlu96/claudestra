/**
 * 编排班子提案的 owner 确认（lib/team-proposal.ts）：两条入口，都不经 LLM。
 *   Discord：management.ts 的免 LLM 按钮（discord-interactions 已按 ALLOWED_USER_IDS 拦过）
 *   网页：点按钮是往 agent 发一条 `[button:team_ok:…]`（web chat-store），这里在 /api/v1 扩展路由里先截下，
 *        只认 owner 本人的设备凭据——老的全 scope Bearer token（agent 自己 `token-add` 就能拿到）和 guest / peer 一律 403
 * 生效靠 runManager 调 CLI（bridge 进程没有 DISCORD_CHANNEL_ID → CLI 身份是 owner），bridge 对台账仍只读。tests/team-confirm.test.ts。
 */
import { canAdministerPairing, OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import type { Principal } from "../lib/principals.js";
import { applyPlan, parseTeamButton, refuseReason, updateProposals, type TeamProposal } from "../lib/team-proposal.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { apiJson } from "./api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { emitEvent, getAgentStatus, isBusyStatus } from "./event-bus.js";

export interface ConfirmDeps {
  runManager(...args: string[]): Promise<{ ok?: boolean; error?: string } | null | undefined>;
  now(): number;
  /** 单测换路径 */
  path?: string;
}

/** 真实依赖：生效步骤里有 create（要等 Claude Code 起来），给足 3 分钟 */
export const confirmDeps = (): ConfirmDeps => ({
  runManager: (...args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: 180_000 }),
  now: () => Date.now(),
});

/** 网页端能替 owner 点确认的：owner 本人的设备凭据（有管理权、全 scope、非 peer） */
export function canConfirmTeam(p: Principal): boolean {
  return canAdministerPairing(p) && p.id === OWNER_PRINCIPAL_ID && p.agents.includes("*") && !p.peer;
}

/** 先在锁里把提案从 pending 挪走（applying / rejected），双击、Discord 与网页同时点都只生效一次 */
async function claim(id: string, hash: string, approve: boolean, who: string, d: ConfirmDeps): Promise<TeamProposal | string> {
  return updateProposals((all) => {
    const p = all[id];
    const why = refuseReason(p, hash, d.now());
    if (why || !p) return why ?? "提案不存在";
    p.status = approve ? "applying" : "rejected";
    p.note = `${who} ${approve ? "确认" : "拒绝"}`;
    return { ...p };
  }, d.now(), d.path);
}

async function finish(id: string, status: TeamProposal["status"], note: string, d: ConfirmDeps): Promise<void> {
  await updateProposals((all) => {
    const p = all[id];
    if (p) Object.assign(p, { status, note });
  }, d.now(), d.path);
}

/** 按 applyPlan 逐条跑；第一条失败就停（已执行的不回滚，失败点写进提案 note，team status 能看到） */
async function apply(p: TeamProposal, who: string, d: ConfirmDeps): Promise<string> {
  const steps = applyPlan(p);
  for (const [i, args] of steps.entries()) {
    const r = await d.runManager(...args).catch((e: Error) => ({ ok: false, error: e.message }));
    if (!r || r.ok === false || r.error) {
      const why = `第 ${i + 1}/${steps.length} 步（manager ${args.slice(0, 3).join(" ")}）失败：${r?.error ?? "无输出"}`;
      await finish(p.id, "failed", `${who} 确认；${why}`, d);
      return `❌ 班子提案 ${p.id} 没有全部生效：${why}。前面的步骤已执行，修好后重新 team up / down`;
    }
  }
  await finish(p.id, "applied", `${who} 确认，已生效`, d);
  return p.kind === "up" ? `✅ 项目「${p.project}」的编排班子已生效（提案 ${p.id}）` : `✅ 项目「${p.project}」的编排班子已撤下（提案 ${p.id}）`;
}

/** 按钮 id → 处理结果文本；不是班子按钮 → null（调用方接着走别的分支） */
export async function handleTeamButton(buttonId: string, who: string, d: ConfirmDeps): Promise<string | null> {
  const b = parseTeamButton(buttonId);
  if (!b) return null;
  const got = await claim(b.id, b.hash, b.approve, who, d);
  if (typeof got === "string") return `⚠️ ${got}`;
  if (!b.approve) return `🚫 已拒绝班子提案 ${b.id}，什么都没改`;
  return apply(got, who, d);
}

const BUTTON_WIRE = /^\s*\[button:(team_(?:ok|no):[0-9a-f]{8}:[0-9a-f]{12})\]\s*$/;

/**
 * /api/v1 扩展路由：POST /agents/:name/messages 且正文恰好是班子按钮 → 在这里结案，不投给 agent。
 * 用 req.clone() 偷看正文，不是班子按钮就返回 null、原请求照常往下走。
 */
export function teamConfirmRoute(deps: () => ConfirmDeps) {
  return async (req: Request, url: URL, principal: Principal): Promise<Response | null> => {
    if (req.method !== "POST" || !/\/agents\/[^/]+\/messages$/.test(url.pathname)) return null;
    if (!(req.headers.get("Content-Type") ?? "").includes("application/json")) return null;
    const body = (await req.clone().json().catch(() => null)) as { text?: unknown } | null; // 不是 JSON 就不是按钮点击：交回原路由按它的规则报错
    const m = typeof body?.text === "string" ? body.text.match(BUTTON_WIRE) : null;
    if (!m) return null;
    if (!canConfirmTeam(principal)) return apiJson(403, { ok: false, error: "只有 owner 本人的设备能确认班子提案" });
    const text = (await handleTeamButton(m[1], `网页 ${principal.name ?? principal.id}`, deps())) ?? "";
    showOnWeb(decodeURIComponent(url.pathname.match(/\/agents\/([^/]+)\/messages$/)?.[1] ?? ""), text);
    return apiJson(200, { ok: true, handled: "team-proposal", text });
  };
}

/**
 * 网页点按钮会先进「正在回复」态、等这个 agent 的回合结束事件：结果以一条 ⚙️ 系统消息推回，
 * agent 此刻空闲就补一个 done 解锁（它在忙时不发，免得把真在跑的回合显示成已完成）。
 */
function showOnWeb(agentParam: string, text: string): void {
  const hit = readRegistryAgentsSync().find((a) => a.name === agentParam || a.name === `agent-${agentParam}`);
  const chatId = hit?.channelId ?? (agentParam === "master" ? (process.env.CONTROL_CHANNEL_ID ?? "") : "");
  if (!chatId) return;
  const agent = hit?.name ?? "master";
  emitEvent({ agent, chatId, type: "chat_message", data: { direction: "out", from: "⚙️ 编排班子", text } });
  if (!isBusyStatus(getAgentStatus(agent))) emitEvent({ agent, chatId, type: "agent_status", data: { status: "done", trigger: "team-proposal" } });
}
