/**
 * 编排班子提案的卡片与 owner 确认（lib/team-proposal.ts），都不经 LLM。
 *   贴卡片：CLI 记下提案后经 ws `team_proposal_post` 请 bridge 贴；bridge 按提案文件渲染文字和按钮，按钮 id 带进程内密钥的 HMAC，
 *          贴出的频道 / 消息记进提案。agent 自己贴不了这类按钮（lib/reserved-buttons.ts 在 deliver 里拦）。
 *   Discord 点击：management.ts 的免 LLM 按钮（discord-interactions 已按 ALLOWED_USER_IDS 拦过），核对 HMAC、频道和那条消息
 *   网页点击：往 agent 发一条 `[button:team_ok:…]`（web chat-store），在 /api/v1 扩展路由里先截下，只认 owner 本人的设备凭据
 *          （全 scope Bearer token 和 guest / peer 一律 403），核对 HMAC 与频道（网页点击不带消息 id）
 * 这里只把提案标成 confirmed，生效靠 runManager 调 CLI：台账由 `ledger team-apply <id>` 自己核对后写，bridge 对台账仍只读。
 * tests/team-confirm.test.ts。
 */
import { canAdministerPairing, OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import type { Principal } from "../lib/principals.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  applyPlan, buttonIds, parseTeamButton, proposalMac, proposalText, refuseReason, updateProposals, type TeamProposal,
} from "../lib/team-proposal.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { apiJson } from "./api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { emitEvent, getAgentStatus, isBusyStatus } from "./event-bus.js";
import { newMessageId, newThreadId, type Delivery, type Envelope } from "./router.js";

/** 按钮校验码的密钥：只在 bridge 进程内存里，不落盘（落盘的话同一用户的 agent 读得到）；重启后旧卡片作废 */
const MAC_KEY = randomBytes(32);

export interface ConfirmDeps {
  runManager(...args: string[]): Promise<{ ok?: boolean; error?: string } | null | undefined>;
  now(): number;
  /** 单测换路径 / 密钥 */
  path?: string;
  key?: Uint8Array;
}

/** 点在哪儿：频道（Discord 频道 / 网页里那个 agent 的频道）；Discord 还带被点的那条消息 id */
export interface ClickOrigin {
  chatId: string;
  messageId?: string;
}

const macOk = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 校验码、频道、消息都对得上 bridge 贴出的那张卡片；null = 对得上 */
function originRefusal(p: TeamProposal, mac: string, o: ClickOrigin, key: Uint8Array): string | null {
  const bad = "按钮校验不过：不是 bridge 贴出的那张卡片（可能是伪造的按钮，或 bridge 重启过、旧卡片作废），什么都没改；请重新提议";
  if (!p.posted || p.posted.chatId !== o.chatId || !macOk(proposalMac(key, p, o.chatId), mac)) return bad;
  if (o.messageId !== undefined && !p.posted.messageIds.includes(o.messageId)) return bad;
  return null;
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

/** 先在锁里把提案从 pending 挪走（confirmed / rejected），双击、Discord 与网页同时点都只生效一次 */
async function claim(id: string, mac: string, origin: ClickOrigin, approve: boolean, who: string, d: ConfirmDeps): Promise<TeamProposal | string> {
  return updateProposals((all) => {
    const p = all[id];
    const why = refuseReason(p, d.now()) ?? (p ? originRefusal(p, mac, origin, d.key ?? MAC_KEY) : null);
    if (why || !p) return why ?? "提案不存在";
    p.status = approve ? "confirmed" : "rejected";
    if (approve) p.confirmedAt = d.now();
    p.note = `${who} ${approve ? "确认" : "拒绝"}`;
    return { ...p };
  }, d.now(), d.path);
}

/** 补结案说明；失败时标 failed，但 team-apply 已写过台账（applied）就保留 applied——台账确实改了 */
async function finish(id: string, failed: boolean, note: string, d: ConfirmDeps): Promise<void> {
  await updateProposals((all) => {
    const p = all[id];
    if (!p) return;
    p.note = note;
    if (failed && p.status !== "applied") p.status = "failed";
  }, d.now(), d.path);
}

/** 按 applyPlan 逐条跑；第一条失败就停（已执行的不回滚，失败点写进提案 note，team status 能看到） */
async function apply(p: TeamProposal, who: string, d: ConfirmDeps): Promise<string> {
  const steps = applyPlan(p);
  for (const [i, args] of steps.entries()) {
    const r = await d.runManager(...args).catch((e: Error) => ({ ok: false, error: e.message }));
    if (!r || r.ok === false || r.error) {
      const why = `第 ${i + 1}/${steps.length} 步（manager ${args.slice(0, 3).join(" ")}）失败：${r?.error ?? "无输出"}`;
      await finish(p.id, true, `${who} 确认；${why}`, d);
      const left = i === 0 ? "什么都没改" : "前面的步骤已执行（不回滚）";
      return `❌ 班子提案 ${p.id} 没有生效：${why}。${left}，请按现状重新提议`;
    }
  }
  await finish(p.id, false, `${who} 确认，已生效`, d);
  const names = p.pms.map((a) => a.replace(/^agent-/, "")).join("、") || "（空）";
  const done = { up: "编排班子已生效", down: "编排班子已撤下", pms: `PM 名单已改为 ${names}` } as const;
  return `✅ 项目「${p.project}」的${done[p.kind]}（提案 ${p.id}）`;
}

/** 按钮 id → 处理结果文本；不是班子按钮 → null（调用方接着走别的分支） */
export async function handleTeamButton(buttonId: string, who: string, origin: ClickOrigin, d: ConfirmDeps): Promise<string | null> {
  const b = parseTeamButton(buttonId);
  if (!b) return null;
  const got = await claim(b.id, b.mac, origin, b.approve, who, d);
  if (typeof got === "string") return `⚠️ ${got}`;
  if (!b.approve) return `🚫 已拒绝班子提案 ${b.id}，什么都没改`;
  return apply(got, who, d);
}

const BUTTON_WIRE = /^\s*\[button:(team_(?:ok|no):[0-9a-f]{8}:[0-9a-f]{16})\]\s*$/;

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
    const chat = chatOfAgent(decodeURIComponent(url.pathname.match(/\/agents\/([^/]+)\/messages$/)?.[1] ?? ""));
    const text = (await handleTeamButton(m[1], `网页 ${principal.name ?? principal.id}`, { chatId: chat?.chatId ?? "" }, deps())) ?? "";
    if (chat) showOnWeb(chat, text);
    return apiJson(200, { ok: true, handled: "team-proposal", text });
  };
}

/** URL 里的 agent 名 → 它的频道（网页点击就点在这个频道的聊天里）；master = 控制频道 */
function chatOfAgent(agentParam: string, proposer?: string): { agent: string; chatId: string } | null {
  const want = proposer ?? agentParam;
  const hit = readRegistryAgentsSync().find((a) => a.name === want || a.name === `agent-${want}`);
  if (hit?.channelId) return { agent: hit.name, chatId: hit.channelId };
  const control = process.env.CONTROL_CHANNEL_ID ?? "";
  return (want === "master" || proposer !== undefined) && control ? { agent: "master", chatId: control } : null;
}

/**
 * ws `team_proposal_post {id}`：bridge 按提案文件渲染并贴出卡片（贴到提议者的频道，终端里提议的贴控制频道），记下贴在哪。
 * 只贴还在等确认、没过期、内容没被改过的提案；同一份可以重贴（CLI 提示「贴不出去就重跑」），贴出的消息都算数。
 */
export async function postProposalCard(
  id: string,
  deliver: (env: Envelope) => Promise<Delivery>,
  d: Partial<Pick<ConfirmDeps, "path" | "key" | "now">> = {},
): Promise<{ result: unknown } | { error: string }> {
  const now = (d.now ?? Date.now)();
  const all = await updateProposals((m) => ({ ...m }), now, d.path);
  const p = all[id];
  const why = refuseReason(p, now);
  if (why || !p) return { error: why ?? "提案不存在" };
  const chat = chatOfAgent("", p.proposer);
  if (!chat) return { error: "找不到能贴卡片的频道（提议者不在 registry、也没配控制频道）" };
  const ids = buttonIds(p, proposalMac(d.key ?? MAC_KEY, p, chat.chatId));
  const components = [{ type: "buttons", buttons: [{ id: ids.ok, label: "确认", style: "success" }, { id: ids.no, label: "拒绝", style: "secondary" }] }];
  const text = proposalText(p);
  const meta = { messageId: newMessageId("team"), triggerKind: "bridge_synth" as const, ts: new Date(now).toISOString(), threadId: newThreadId(), components };
  const r = await deliver({ from: { kind: "bridge", label: "team-proposal" }, to: { kind: "user", userId: "", channelId: chat.chatId }, intent: "notification", content: text, meta });
  if (r.outcome.kind !== "sent") return { error: `卡片没贴出去：${r.outcome.kind === "dropped" ? r.outcome.reason : (r.outcome as { error?: Error }).error?.message ?? "未知"}` };
  const messageIds = r.outcome.discordMessageIds ?? [];
  await updateProposals((m) => {
    const q = m[id];
    if (q) q.posted = { chatId: chat.chatId, messageIds: [...(q.posted?.chatId === chat.chatId ? q.posted.messageIds : []), ...messageIds] };
  }, now, d.path);
  emitEvent({ agent: chat.agent, chatId: chat.chatId, type: "chat_message", data: { direction: "out", from: "⚙️ 编排班子", text, threadId: meta.threadId, components } });
  return { result: { posted: chat.chatId, messageIds } };
}

/**
 * 网页点按钮会先进「正在回复」态、等这个 agent 的回合结束事件：结果以一条 ⚙️ 系统消息推回，
 * agent 此刻空闲就补一个 done 解锁（它在忙时不发，免得把真在跑的回合显示成已完成）。
 */
function showOnWeb({ agent, chatId }: { agent: string; chatId: string }, text: string): void {
  emitEvent({ agent, chatId, type: "chat_message", data: { direction: "out", from: "⚙️ 编排班子", text } });
  if (!isBusyStatus(getAgentStatus(agent))) emitEvent({ agent, chatId, type: "agent_status", data: { status: "done", trigger: "team-proposal" } });
}
