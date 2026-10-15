/**
 * `team onboard`：把已登记的项目接入自动流程（docs/team/orchestration-team.md「接入编排」）。逐项核对、只补缺：
 *   目录与 git —— 无 origin 的仓库必须带 --local-merge（PR 流程走不通）；
 *   scheduler.json —— 没有项目段就新增（带审计事件，lib/scheduler-config-write.ts addProject）；有但值不同只列差异，从不覆盖；
 *   编排班子 —— 没开班子 / PM 不在名单 / registry 角色没设，就出一份 team up 提案，owner 在卡片上确认（不直接写 pms）。
 * --dry-run 什么都不写（网页「接入编排」打开时读的就是它）；重跑幂等：段已在、提案已在等确认都不再写。
 * 规划是纯函数 planOnboard，执行是 runOnboard（依赖注入）；tests/team-onboard.test.ts。
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { LedgerError, LEDGER_PATH, getMeta, openLedger, type LedgerMeta } from "../lib/ledger-store.js";
import { roleOf } from "../lib/ledger-stages.js";
import { isRealPmRole } from "../lib/ledger-team-config.js";
import { parseRequiredChecks, SCHEDULER_CONFIG_PATH } from "../lib/scheduler-config.js";
import { addProject, type NewProjectSegment } from "../lib/scheduler-config-write.js";
import { readProposals, type ProposalDraft, type TeamProposal } from "../lib/team-proposal.js";
import { normalizeName, output } from "./core.js";
import { intFlag } from "./ledger-identity.js";
import { planUp, propose, teamContext, type Agents, type ProposeOpts } from "./team-up.js";

/** 新项目段的缺省并发（PM 缺省定 2） */
export const DEFAULT_MAX_WORKERS = 2;

export type GitState = "origin" | "no-origin" | "not-git";
export type ItemKey = "project" | "git" | "scheduler" | "team";
/** ok = 已就绪；todo = 提交时会补；diff = 已有但和这次参数不同（不覆盖）；blocked = 拦住整次接入；done = 这次补上了 */
export type ItemStatus = "ok" | "todo" | "diff" | "blocked" | "done";
export interface OnboardItem { key: ItemKey; status: ItemStatus; text: string }

export interface OnboardFlags {
  localMerge: boolean;
  checks?: string[];
  maxWorkers?: number;
  pm?: string;
}

export interface OnboardFacts {
  project: string;
  dir: string | null;
  git: GitState;
  actor: string;
  /** null = scheduler.json 不存在；segment null = 文件里没有这个项目 */
  scheduler: { segment: Record<string, unknown> | null } | null;
  meta: Pick<LedgerMeta, "pms" | "team">;
  agents: Agents;
  /** 本项目还在等 owner 点的 team up 提案 id */
  pendingProposal: string | null;
}

export interface OnboardPlan { items: OnboardItem[]; segment: NewProjectSegment | null; draft: ProposalDraft | null }

const show = (v: unknown) => (v === undefined ? "（没有）" : JSON.stringify(v));

function gitItem(f: OnboardFacts, flags: OnboardFlags): OnboardItem {
  if (!f.dir) return { key: "git", status: "blocked", text: `项目 ${f.project} 在 projects.json 里没有目录` };
  if (f.git === "not-git") return { key: "git", status: "blocked", text: `${f.dir} 不是 git 仓库` };
  if (f.git === "origin") return { key: "git", status: "ok", text: flags.localMerge ? "有 origin，按 --local-merge 走本地合并" : "有 origin，走 PR 合并" };
  if (!flags.localMerge) return { key: "git", status: "blocked", text: "仓库没有 origin：纯本地仓库要带 --local-merge（合进本地 main）" };
  return { key: "git", status: "ok", text: "没有 origin，走本地合并" };
}

/** 这次参数想要的值：没写的旗标不参与比较（已有段只对照你写了的那几项） */
function wanted(f: OnboardFacts, flags: OnboardFlags): Record<string, unknown> {
  return { ...(f.dir ? { repoDir: f.dir } : {}), ...(flags.localMerge || f.git === "no-origin" ? { localMerge: true } : {}),
    ...(flags.checks ? { requiredChecks: flags.checks } : {}), ...(flags.maxWorkers !== undefined ? { maxActiveWorkers: flags.maxWorkers } : {}) };
}

function schedulerItem(f: OnboardFacts, flags: OnboardFlags): { item: OnboardItem; segment: NewProjectSegment | null } {
  const at = (status: ItemStatus, text: string) => ({ item: { key: "scheduler" as const, status, text }, segment: null });
  if (!f.scheduler) return at("blocked", "scheduler.json 不存在：先配置调度服务（onboard 不新建这个文件，也不碰全局开关）");
  const cur = f.scheduler.segment;
  if (cur) {
    const diffs = Object.entries(wanted(f, flags)).filter(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v));
    if (!diffs.length) return at("ok", "调度项目段已在");
    return at("diff", `调度项目段已在，和这次参数不同（不覆盖，要改请手动核对）：${diffs.map(([k, v]) => `${k} 现在 ${show(cur[k])}，这次 ${show(v)}`).join("；")}`);
  }
  if (!f.dir) return at("blocked", "没有目录，建不了调度项目段");
  if (!flags.checks) return at("blocked", "新增调度项目段要带 --checks（本地合并 = 要跑的命令，PR 项目 = CI 检查名；多条用逗号分）");
  if (!parseRequiredChecks(flags.checks)) return at("blocked", "--checks 要 1..20 条、每条 1..80 字、不含逗号和控制字符");
  const max = flags.maxWorkers ?? DEFAULT_MAX_WORKERS;
  if (!Number.isInteger(max) || max < 0 || max > 32) return at("blocked", `--max-workers 要是 0..32 的整数，收到 ${max}`);
  // supervise:false：刚接入时 agent 监护先不管这个项目里已经在干活的 agent（PM 缺省定）；以后要开改 scheduler.json
  const segment: NewProjectSegment = { maxActiveWorkers: max, requiredChecks: flags.checks, repoDir: f.dir, supervise: false,
    ...(wanted(f, flags).localMerge ? { localMerge: true } : {}) };
  return { item: { key: "scheduler", status: "todo", text: `新增调度项目段：${JSON.stringify(segment)}` }, segment };
}

function teamItem(f: OnboardFacts, flags: OnboardFlags): { item: OnboardItem; draft: ProposalDraft | null } {
  const at = (status: ItemStatus, text: string) => ({ item: { key: "team" as const, status, text }, draft: null });
  const pm = flags.pm ? normalizeName(flags.pm) : f.meta.pms[0] ?? (f.actor.startsWith("agent-") ? f.actor : null);
  if (!pm) return at("blocked", "项目还没有 PM：用 --pm <agent> 指定");
  if (f.pendingProposal) return at("todo", `已有 team up 提案 ${f.pendingProposal} 在等 owner 确认，不再重复提议`);
  const draft = planUp({ project: f.project, dir: f.dir, actor: f.actor, pm, audit: f.meta.team?.audit ?? true, meta: f.meta, agents: f.agents });
  if ("error" in draft) return at("blocked", draft.error);
  if (f.meta.team && f.meta.pms.includes(pm) && !draft.roles.length) return at("ok", `编排班子已开，PM ${pm} 已在名单、角色已设`);
  const why = [!f.meta.team && "班子没开", !f.meta.pms.includes(pm) && `PM ${pm} 不在名单`, draft.roles.length && "registry 角色没设"].filter(Boolean).join("、");
  return { item: { key: "team", status: "todo", text: `出 team up 提案（${why}），owner 在卡片上确认后生效；角色下次重启 PM 生效` }, draft };
}

export function planOnboard(f: OnboardFacts, flags: OnboardFlags): OnboardPlan {
  const project: OnboardItem = { key: "project", status: f.dir ? "ok" : "blocked", text: f.dir ? `目录 ${f.dir}` : "projects.json 里没有目录" };
  const sched = schedulerItem(f, flags);
  const team = teamItem(f, flags);
  return { items: [project, gitItem(f, flags), sched.item, team.item], segment: sched.segment, draft: team.draft };
}

export interface OnboardDeps {
  db: Database;
  now: number;
  /** scheduler.json 路径（测试用临时文件） */
  schedulerPath?: string;
  proposals?: ProposeOpts;
}
export interface OnboardInput extends Omit<OnboardFacts, "scheduler" | "meta" | "pendingProposal"> { flags: OnboardFlags; dryRun: boolean }

function readSegment(path: string, project: string): OnboardFacts["scheduler"] {
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, "utf8")) as { projects?: Record<string, unknown> };
  const seg = doc.projects && Object.hasOwn(doc.projects, project) ? doc.projects[project] : null;
  return { segment: seg && typeof seg === "object" ? (seg as Record<string, unknown>) : null };
}

async function pendingOf(project: string, now: number, path?: string): Promise<string | null> {
  const open = (p: TeamProposal) => p.project === project && p.kind === "up" && (p.status === "pending" || p.status === "confirmed") && p.expiresAt > now;
  return Object.values(await readProposals(path)).find(open)?.id ?? null;
}

/** 核对 → （非 dry-run）补段 → 出提案。任何一项 blocked 就什么都不写。 */
export async function runOnboard(i: OnboardInput, d: OnboardDeps): Promise<Record<string, unknown>> {
  const meta = getMeta(d.db, i.project);
  if (!isRealPmRole(roleOf(i.actor, { agent: null }, meta.pms), i.actor, meta.team)) {
    return { ok: false, code: "forbidden", error: `team onboard 要项目 ${i.project} 的 PM（调度助理除外）/ master / owner（你是 ${i.actor}）` };
  }
  let scheduler: OnboardFacts["scheduler"];
  try { scheduler = readSegment(d.schedulerPath ?? SCHEDULER_CONFIG_PATH, i.project); }
  catch (e) { return { ok: false, code: "invalid", error: `scheduler.json 读不出：${(e as Error).message}` }; }
  const facts: OnboardFacts = { ...i, scheduler, meta, pendingProposal: await pendingOf(i.project, d.now, d.proposals?.path) };
  const plan = planOnboard(facts, i.flags);
  const head = { project: i.project, dryRun: i.dryRun, git: i.git };
  const blocked = plan.items.filter((x) => x.status === "blocked");
  if (blocked.length) return { ok: false, code: "blocked", error: blocked.map((x) => x.text).join("；"), ...head, items: plan.items };
  if (i.dryRun) return { ok: true, ...head, items: plan.items };
  const items = [...plan.items];
  const mark = (key: ItemKey, text: string) => { const at = items.findIndex((x) => x.key === key); items[at] = { key, status: "done", text }; };
  if (plan.segment) {
    try {
      const r = await addProject(d.db, { actor: i.actor, now: d.now }, { project: i.project, segment: plan.segment, reason: `team onboard ${i.project}` },
        { path: d.schedulerPath });
      mark("scheduler", r.changed ? `已新增调度项目段（审计事件 #${r.event}）` : "调度项目段已在（期间别人加上了，没覆盖）");
    } catch (e) {
      const code = e instanceof LedgerError ? e.code : "error";
      return { ok: false, code, error: `新增调度项目段没写成：${(e as Error).message}`, ...head, items };
    }
  }
  if (!plan.draft) return { ok: true, ...head, items };
  const r = await propose(plan.draft, d.proposals);
  mark("team", r.ok ? `已出 team up 提案 ${r.proposal}，等 owner 在卡片上确认` : `提案 ${r.proposal} 已记下，但${String(r.error)}`);
  return { ok: r.ok === true, ...head, items, proposal: r.proposal, ...(r.ok ? {} : { error: r.error }) };
}

/** --checks "a,b"：逗号分条（一条检查本身不许含逗号，见 parseRequiredChecks） */
export const splitChecks = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);

function gitState(dir: string | null): GitState {
  if (!dir) return "not-git";
  const r = Bun.spawnSync(["git", "-C", dir, "remote"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return "not-git";
  return r.stdout.toString().split("\n").map((s) => s.trim()).includes("origin") ? "origin" : "no-origin";
}

export async function cmdOnboard(args: string[]): Promise<void> {
  const c = await teamContext(args, ["project", "pm", "checks", "max-workers"], ["local-merge", "dry-run"]);
  if ("error" in c) return output({ ok: false, error: c.error });
  if (!existsSync(LEDGER_PATH)) return output({ ok: false, error: "还没有台账库：先用 ledger 建任务" });
  let max: number | undefined;
  try { max = intFlag(c.p, "max-workers"); }
  catch (e) { return output({ ok: false, error: (e as Error).message }); }
  const flags: OnboardFlags = { localMerge: c.p.bools.has("local-merge"), pm: c.p.flags.pm,
    ...(c.p.flags.checks !== undefined ? { checks: splitChecks(c.p.flags.checks) } : {}), ...(max !== undefined ? { maxWorkers: max } : {}) };
  const input: OnboardInput = { project: c.project, dir: c.dir, git: gitState(c.dir), actor: c.actor, agents: c.agents, flags, dryRun: c.p.bools.has("dry-run") };
  output(await runOnboard(input, { db: openLedger(), now: Date.now() }));
}
