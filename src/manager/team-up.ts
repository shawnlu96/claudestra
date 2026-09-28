/**
 * `team up|down|status`：一条命令拉起 / 撤下编排班子（docs/team/orchestration-team.md）。
 *   up     生成提案（PM 名单、可选的调度助理、巡检开关）并贴出确认按钮——改 PM 名单要 owner 身份，所以这里什么都不直接改
 *   down   同上，提案内容是关事件路由、把调度助理移出 PM 名单
 *   status 只读：班子配置、每个进行中任务现在谁在接（currentHandler）、待确认的提案；执行者超过 SUGGEST_AT 个时建议开调度助理
 * 提案生效在 bridge（bridge/team-confirm.ts）；规划是纯函数（planUp / planDown / statusView），tests/team-up.test.ts。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { bridgeRequest } from "../lib/bridge-client.js";
import { repoEnvVar } from "../lib/env-file.js";
import { currentHandler, type Handler } from "../lib/ledger-handler.js";
import { TERMINAL_STAGES } from "../lib/ledger-stages.js";
import { getMeta, LEDGER_PATH, listEvents, listTasks, openLedger, type LedgerMeta } from "../lib/ledger-store.js";
import { readProjects } from "../lib/projects.js";
import { buttonIds, newProposal, proposalText, readProposals, updateProposals, type ProposalDraft, type TeamProposal } from "../lib/team-proposal.js";
import { loadRegistry, normalizeName, output } from "./core.js";
import { parseLedgerArgs, resolveActor } from "./ledger-identity.js";

/** 执行者超过这么多个、又没开调度助理，status 建议开（PM 一个人接不过来） */
export const SUGGEST_AT = 5;

type Agents = Record<string, { channelId?: string; projectId?: string; status?: string }>;

export interface UpInput {
  project: string;
  /** 项目第一个目录（新建调度助理的工作目录） */
  dir: string | null;
  actor: string;
  pm?: string;
  /** "new" = 新建 <project>-dispatch；其它 = 已有 agent 名；undefined = 不开 */
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
  if (i.dispatcher === "new") {
    const agent = normalizeName(`${i.project}-dispatch`);
    if (i.agents[agent]) return { error: `${agent} 已存在：要复用它就写 --dispatcher-agent ${agent.replace(/^agent-/, "")}` };
    if (!i.dir) return { error: `项目 ${i.project} 没有目录，建不了调度助理` };
    dispatcher = { agent, create: true, dir: i.dir };
  } else if (i.dispatcher) {
    const agent = normalizeName(i.dispatcher);
    if (!i.agents[agent]) return { error: `registry 里没有 ${agent}` };
    if (agent === pm) return { error: "调度助理和 PM 不能是同一个 agent" };
    dispatcher = { agent, create: false };
  }
  const old = i.meta.team?.dispatcher;
  const kept = i.meta.pms.filter((p) => p !== old || p === dispatcher?.agent);
  const pms = uniq([...kept, pm, ...(dispatcher ? [dispatcher.agent] : [])]);
  return { kind: "up", project: i.project, proposer: i.actor, pm, pms, dispatcher, audit: i.audit };
}

export function planDown(project: string, actor: string, meta: Pick<LedgerMeta, "pms" | "team">): ProposalDraft | { error: string } {
  if (!meta.team) return { error: `项目 ${project} 没开编排班子` };
  const d = meta.team.dispatcher;
  return { kind: "down", project, proposer: actor, pm: null, pms: meta.pms.filter((p) => p !== d), dispatcher: d ? { agent: d, create: false } : null, audit: false };
}

export interface StatusView {
  project: string;
  pms: string[];
  team: LedgerMeta["team"];
  executors: number;
  suggestion: string | null;
  tasks: { id: string; title: string; stage: string; round: number; agent: string | null; handler: Handler | null }[];
  proposals: Pick<TeamProposal, "id" | "kind" | "status" | "note" | "expiresAt">[];
}

export function statusView(db: Database, project: string, proposals: TeamProposal[]): StatusView {
  const meta = getMeta(db, project);
  const team = { pms: meta.pms, dispatcher: meta.team?.dispatcher ?? null };
  const open = listTasks(db, project).filter((t) => !TERMINAL_STAGES.includes(t.stage));
  const tasks = open.map((t) => ({
    id: t.id, title: t.title, stage: t.stage, round: t.round, agent: t.agent,
    handler: currentHandler(t, listEvents(db, { project, target: t.id }), team),
  }));
  const executors = new Set(open.map((t) => t.agent).filter((a): a is string => !!a && !meta.pms.includes(a))).size;
  const suggestion = executors > SUGGEST_AT && !meta.team?.dispatcher
    ? `执行者已有 ${executors} 个，建议开调度助理：team up --project ${project} --dispatcher（owner 在界面上确认一次）`
    : null;
  const mine = proposals.filter((p) => p.project === project).map(({ id, kind, status, note, expiresAt }) => ({ id, kind, status, note, expiresAt }));
  return { project, pms: meta.pms, team: meta.team, executors, suggestion, tasks, proposals: mine };
}

/** 提案贴到提议者自己的频道（通常是 PM 的），终端里的 owner / 大总管贴控制频道；贴不出去不作废提案，提示去哪儿找 */
async function post(p: TeamProposal, actor: string, agents: Agents): Promise<string | null> {
  const ch = agents[actor]?.channelId ?? repoEnvVar("CONTROL_CHANNEL_ID");
  if (!ch) return "找不到能贴按钮的频道（不在 agent 会话里、也没配控制频道）";
  const ids = buttonIds(p);
  const components = [{ type: "buttons", buttons: [{ id: ids.ok, label: "确认", style: "success" }, { id: ids.no, label: "拒绝", style: "secondary" }] }];
  try {
    await bridgeRequest({ type: "reply", chatId: ch, fromChannelId: ch, text: proposalText(p), components });
    return null;
  } catch (e) {
    return `按钮没贴出去（${(e as Error).message}）`;
  }
}

async function context(args: string[]) {
  const p = parseLedgerArgs(args.slice(1), ["project", "pm", "dispatcher-agent"], ["dispatcher", "no-audit"]);
  if ("error" in p) return { error: p.error };
  const reg = await loadRegistry();
  const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, reg.agents);
  if (!who.ok) return { error: who.error };
  const project = p.flags.project ?? reg.agents[who.actor]?.projectId;
  const def = (await readProjects()).projects.find((x) => x.id === project);
  if (!project || !def) return { error: project ? `projects.json 里没有项目 ${project}` : "要带 --project <项目 id>" };
  return { p, agents: reg.agents as Agents, actor: who.actor, project, dir: def.dirs[0] ?? null };
}

async function propose(draft: ProposalDraft, actor: string, agents: Agents): Promise<void> {
  const proposal = newProposal(draft, Date.now());
  await updateProposals((all) => void (all[proposal.id] = proposal));
  const postError = await post(proposal, actor, agents);
  output({
    ok: !postError, proposal: proposal.id, status: "pending", expiresAt: new Date(proposal.expiresAt).toISOString(),
    ...(postError ? { error: `${postError}；提案已记下，可在有按钮的会话里重跑一次` } : { note: "已贴出确认按钮，等 owner 在界面上点确认（30 分钟内有效）" }),
    text: proposalText(proposal),
  });
}

export async function cmdTeam(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (!["up", "down", "status"].includes(sub)) {
    output({ ok: false, error: "usage: team up|down|status --project <id> [--pm <agent>] [--dispatcher | --dispatcher-agent <agent>] [--no-audit]" });
    return;
  }
  const c = await context(args);
  if ("error" in c) return output({ ok: false, error: c.error });
  if (!existsSync(LEDGER_PATH)) return output({ ok: false, error: "还没有台账库：先用 ledger 建任务" });
  const db = openLedger();
  if (sub === "status") return output({ ok: true, ...statusView(db, c.project, Object.values(await readProposals())) });
  const meta = getMeta(db, c.project);
  const draft =
    sub === "down"
      ? planDown(c.project, c.actor, meta)
      : planUp({
          project: c.project, dir: c.dir, actor: c.actor, pm: c.p.flags.pm, audit: !c.p.bools.has("no-audit"), meta, agents: c.agents,
          dispatcher: c.p.flags["dispatcher-agent"] ?? (c.p.bools.has("dispatcher") ? "new" : undefined),
        });
  if ("error" in draft) return output({ ok: false, error: draft.error });
  await propose(draft, c.actor, c.agents);
}
