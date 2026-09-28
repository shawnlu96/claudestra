/**
 * `team up|down|status`：一条命令拉起 / 撤下编排班子（docs/team/orchestration-team.md）。
 *   up     生成提案（PM 名单、调度助理、巡检开关、角色变动）并请 bridge 贴确认卡片——改 PM 名单要 owner 身份，所以这里什么都不直接改；
 *          已开着调度助理时默认保留它，`--no-dispatcher` 才撤
 *   down   同上，提案内容是关事件路由、把调度助理移出 PM 名单、撤下班子角色
 *   status 只读：班子配置、每个进行中任务现在谁在接（currentHandler，读规格卡）、registry 里的角色、待确认的提案
 * up / down 只有项目的 PM / master / owner 能提议（和 `ledger meta --pms` 同一道检查）。
 * 提案生效在 bridge（bridge/team-confirm.ts）；规划是纯函数（planUp / planDown / statusView），tests/team-confirm.test.ts。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { bridgeRequest } from "../lib/bridge-client.js";
import { repoEnvVar } from "../lib/env-file.js";
import { currentHandler, type Handler } from "../lib/ledger-handler.js";
import { roleOf, TERMINAL_STAGES } from "../lib/ledger-stages.js";
import { getMeta, LEDGER_PATH, listEvents, listTasks, openLedger, type LedgerMeta } from "../lib/ledger-store.js";
import { readProjects } from "../lib/projects.js";
import { specPolicyOf } from "../lib/task-spec.js";
import { newProposal, planRoles, proposalText, readProposals, teamBaseOf, updateProposals, type ProposalDraft, type TeamProposal } from "../lib/team-proposal.js";
import { loadRegistry, normalizeName, output } from "./core.js";
import { parseLedgerArgs, resolveActor } from "./ledger-identity.js";

/** 执行者超过这么多个、又没开调度助理，status 建议开（PM 一个人接不过来） */
export const SUGGEST_AT = 5;

export type Agents = Record<string, { channelId?: string; projectId?: string; status?: string; role?: string }>;

export interface UpInput {
  project: string;
  /** 项目第一个目录（新建调度助理的工作目录） */
  dir: string | null;
  actor: string;
  pm?: string;
  /** "new" = 新建 <project>-dispatch；"none" = 不开 / 撤掉；其它 = 已有 agent 名；undefined = 保留现在的（没有就不开） */
  dispatcher?: string;
  audit: boolean;
  meta: Pick<LedgerMeta, "pms" | "team">;
  agents: Agents;
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function planUp(i: UpInput): ProposalDraft | { error: string } {
  const pm = i.pm ? normalizeName(i.pm) : i.actor.startsWith("agent-") ? i.actor : null;
  if (!pm) return { error: "要用 --pm <agent> 指定 PM（在终端里跑时推不出是谁）" };
  if (!i.agents[pm]) return { error: `registry 里没有 PM ${pm}` };
  let dispatcher: ProposalDraft["dispatcher"] = null;
  const cur = i.meta.team?.dispatcher;
  if (i.dispatcher === undefined && cur && i.agents[cur] && cur !== pm) {
    dispatcher = { agent: cur, create: false };
  } else if (i.dispatcher === "new") {
    const agent = normalizeName(`${i.project}-dispatch`);
    if (i.agents[agent]) return { error: `${agent} 已存在：要复用它就写 --dispatcher-agent ${agent.replace(/^agent-/, "")}` };
    if (!i.dir) return { error: `项目 ${i.project} 没有目录，建不了调度助理` };
    dispatcher = { agent, create: true, dir: i.dir };
  } else if (i.dispatcher && i.dispatcher !== "none") {
    const agent = normalizeName(i.dispatcher);
    if (!i.agents[agent]) return { error: `registry 里没有 ${agent}` };
    if (i.agents[agent].status && i.agents[agent].status !== "active") return { error: `${agent} 状态是 ${i.agents[agent].status}，调度助理要 active 的 agent` };
    if (agent === pm) return { error: "调度助理和 PM 不能是同一个 agent" };
    dispatcher = { agent, create: false };
  }
  const kept = i.meta.pms.filter((p) => p !== cur || p === dispatcher?.agent);
  const pms = uniq([...kept, pm, ...(dispatcher ? [dispatcher.agent] : [])]);
  const base = teamBaseOf(i.meta);
  const roles = planRoles({ pms, dispatcher: dispatcher?.agent ?? null, on: true }, base, i.agents);
  return { kind: "up", project: i.project, proposer: i.actor, pm, pms, dispatcher, audit: i.audit, base, roles };
}

export function planDown(project: string, actor: string, meta: Pick<LedgerMeta, "pms" | "team">, agents: Agents): ProposalDraft | { error: string } {
  if (!meta.team) return { error: `项目 ${project} 没开编排班子` };
  const d = meta.team.dispatcher;
  const pms = meta.pms.filter((p) => p !== d);
  const base = teamBaseOf(meta);
  const roles = planRoles({ pms, dispatcher: null, on: false }, base, agents);
  return { kind: "down", project, proposer: actor, pm: null, pms, dispatcher: d ? { agent: d, create: false } : null, audit: false, base, roles };
}

export interface StatusView {
  project: string;
  pms: string[];
  team: LedgerMeta["team"];
  executors: number;
  suggestion: string | null;
  tasks: { id: string; title: string; stage: string; round: number; agent: string | null; handler: Handler | null }[];
  /** registry 里名单成员与调度助理的角色（和台账对不上时一眼能看出来） */
  roles: Record<string, string | null>;
  proposals: Pick<TeamProposal, "id" | "kind" | "status" | "note" | "expiresAt">[];
}

export function statusView(db: Database, project: string, proposals: TeamProposal[], agents: Agents = {}): StatusView {
  const meta = getMeta(db, project);
  const team = { pms: meta.pms, dispatcher: meta.team?.dispatcher ?? null };
  const open = listTasks(db, project).filter((t) => !TERMINAL_STAGES.includes(t.stage));
  // 规格卡的审查策略和路由读同一份（lib/task-spec.ts），「谁在接」才和通知一致
  const tasks = open.map((t) => ({
    id: t.id, title: t.title, stage: t.stage, round: t.round, agent: t.agent,
    handler: currentHandler(t, listEvents(db, { project, target: t.id }), team, specPolicyOf(t, meta.docsDir)),
  }));
  const members = [...new Set([...meta.pms, ...(team.dispatcher ? [team.dispatcher] : [])])];
  const roles = Object.fromEntries(members.map((a) => [a, agents[a]?.role ?? null]));
  const executors = new Set(open.map((t) => t.agent).filter((a): a is string => !!a && !meta.pms.includes(a))).size;
  const suggestion = executors > SUGGEST_AT && !meta.team?.dispatcher
    ? `执行者已有 ${executors} 个，建议开调度助理：team up --project ${project} --dispatcher（owner 在界面上确认一次）`
    : null;
  const mine = proposals.filter((p) => p.project === project).map(({ id, kind, status, note, expiresAt }) => ({ id, kind, status, note, expiresAt }));
  return { project, pms: meta.pms, team: meta.team, executors, suggestion, tasks, roles, proposals: mine };
}

/**
 * 请 bridge 贴卡片：文字和按钮由 bridge 按提案文件渲染（按钮带只有 bridge 知道的校验码），贴到提议者的频道或控制频道。
 * 贴不出去不作废提案，提示去哪儿找。
 */
async function postCard(p: TeamProposal): Promise<string | null> {
  try {
    await bridgeRequest({ type: "team_proposal_post", id: p.id });
    return null;
  } catch (e) {
    return `卡片没贴出去（${(e as Error).message}）`;
  }
}

async function context(args: string[]) {
  const p = parseLedgerArgs(args.slice(1), ["project", "pm", "dispatcher-agent"], ["dispatcher", "no-dispatcher", "no-audit"]);
  if ("error" in p) return { error: p.error };
  const reg = await loadRegistry();
  const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, reg.agents);
  if (!who.ok) return { error: who.error };
  const project = p.flags.project ?? reg.agents[who.actor]?.projectId;
  const def = (await readProjects()).projects.find((x) => x.id === project);
  if (!project || !def) return { error: project ? `projects.json 里没有项目 ${project}` : "要带 --project <项目 id>" };
  return { p, agents: reg.agents as Agents, actor: who.actor, project, dir: def.dirs[0] ?? null };
}

/** 提案存哪、按钮怎么贴；单测注入（tests/team-apply.test.ts） */
export interface ProposeOpts {
  path?: string;
  post?(p: TeamProposal): Promise<string | null>;
}

/** 记下提案并贴按钮；team up / down 与 `ledger meta --pms` 共用 */
export async function propose(draft: ProposalDraft, o: ProposeOpts = {}): Promise<Record<string, unknown>> {
  const proposal = newProposal(draft, Date.now());
  await updateProposals((all) => void (all[proposal.id] = proposal), Date.now(), o.path);
  const postError = await (o.post ?? postCard)(proposal);
  return {
    ok: !postError, proposal: proposal.id, status: "pending", expiresAt: new Date(proposal.expiresAt).toISOString(),
    ...(postError ? { error: `${postError}；提案已记下，可在有按钮的会话里重跑一次` } : { note: "已贴出确认按钮，等 owner 在界面上点确认（30 分钟内有效）" }),
    text: proposalText(proposal),
  };
}

export async function cmdTeam(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (!["up", "down", "status"].includes(sub)) {
    output({ ok: false, error: "usage: team up|down|status --project <id> [--pm <agent>] [--dispatcher | --dispatcher-agent <agent> | --no-dispatcher] [--no-audit]" });
    return;
  }
  const c = await context(args);
  if ("error" in c) return output({ ok: false, error: c.error });
  if (!existsSync(LEDGER_PATH)) return output({ ok: false, error: "还没有台账库：先用 ledger 建任务" });
  const db = openLedger();
  if (sub === "status") return output({ ok: true, ...statusView(db, c.project, Object.values(await readProposals()), c.agents) });
  const meta = getMeta(db, c.project);
  const role = roleOf(c.actor, { agent: null }, meta.pms);
  if (role === null || role === "executor") return output({ ok: false, error: `team ${sub} 要项目 ${c.project} 的 PM / master / owner 提议（你是 ${c.actor}）` });
  const flag = c.p.flags["dispatcher-agent"] ?? (c.p.bools.has("dispatcher") ? "new" : c.p.bools.has("no-dispatcher") ? "none" : undefined);
  const draft =
    sub === "down"
      ? planDown(c.project, c.actor, meta, c.agents)
      : planUp({ project: c.project, dir: c.dir, actor: c.actor, pm: c.p.flags.pm, audit: !c.p.bools.has("no-audit"), meta, agents: c.agents, dispatcher: flag });
  if ("error" in draft) return output({ ok: false, error: draft.error });
  output(await propose(draft));
}
