/**
 * 按任务类型选本机模型（TIER3）。同家族按「类型 × 角色格 → 角色格 → 产品默认」解析：tiers 里没写 = 用下面 TIER_DEFAULTS，写 inherit = 显式继承角色格。
 * 门 = RecoveryPolicyPort 的 taskTierModels 键（缺省 on，与旧 roleModel 键互不要求）：
 * - off：decideTierLaunch 一进来就回 off，调用方整段走旧角色路径，不读表、不记事件、不调扩展点；调用点在建上下文 / 读规格卡之前就分流，bindTierSession 也不绑。
 * - observe：启动参数不变，只记一条 would-use（recordObserved）。
 * - on：按有效值传 --model / --effort；显式参数照旧优先，但 security 写、审不得低于 Opus，Codex 不降原档——冲突就拒绝并给原因。
 * 开卡用哪个流程模板：tierStartTemplate（on 下按规格卡首声明，start_node 预检调用）。Codex 的 security 下限与类型解析同一原档：baseEffort 优先，缺省取角色格。
 * 扩展点（缺省空、off 不调用）：registerAuthorTierOverride（建作者前按项目 + 卡号问覆盖值）、task-tier-spec.ts 的模板注册（带流程定义）与校验钩子（tierCheckGate）。
 * tests/task-tier-models.test.ts、tests/task-tier-recovery.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { appendEvent } from "./ledger-write.js";
import { getTask } from "./ledger-store.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readRoleModels, roleModelOf, type CardRole, type RoleModelRead } from "./role-model-settings.js";
import { isOpusGrade, type CodexEffort } from "./task-tier-model-settings.js";
import { isTaskTier, parseTaskTier, runTierChecks, tierAtLaunch, tierLaunchable, type TaskTier, type TierCheckCtx, type TierCheckPhase } from "./task-tier-spec.js";
import { bindLaunchSession, ledgerWriter, newLaunchId, type LaunchPlan } from "./task-tier-launch-events.js";

const TASK_TIER_KEY = "taskTierModels" as const;
const TIER_MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;
type Family = "claude" | "codex";
type DefaultCell = { claude: string; codex: "inherit" | "down1" };

const row = (author: DefaultCell, review: DefaultCell, pm: DefaultCell): Record<CardRole, DefaultCell> =>
  ({ author, reviewer: review, "adversarial-reviewer": review, "pm-reviewer": pm });
const INHERIT: DefaultCell = { claude: "inherit", codex: "inherit" };
/** 产品默认（规格表原样）：security 全 Opus、Codex 沿用；ui / docs 作者降档；pm-reviewer 非 security 用 Sonnet */
export const TIER_DEFAULTS: Record<TaskTier, Record<CardRole, DefaultCell>> = {
  security: row({ claude: TIER_MODELS.opus, codex: "inherit" }, { claude: TIER_MODELS.opus, codex: "inherit" }, { claude: TIER_MODELS.opus, codex: "inherit" }),
  code: row({ claude: TIER_MODELS.opus, codex: "inherit" }, INHERIT, { claude: TIER_MODELS.sonnet, codex: "inherit" }),
  ui: row({ claude: TIER_MODELS.sonnet, codex: "down1" }, INHERIT, { claude: TIER_MODELS.sonnet, codex: "inherit" }),
  docs: row({ claude: TIER_MODELS.haiku, codex: "down1" }, INHERIT, { claude: TIER_MODELS.sonnet, codex: "inherit" }),
};

const isEffort = (v: unknown): v is CodexEffort => CODEX_EFFORT_LEVELS.includes(v as CodexEffort);
const rank = (e: CodexEffort) => CODEX_EFFORT_LEVELS.indexOf(e);
/** 已知档降一档；最低档不再降 */
const downgradeEffort = (e: CodexEffort): CodexEffort => CODEX_EFFORT_LEVELS[Math.max(0, rank(e) - 1)];

type TierSource = "tier-settings" | "tier-default" | "role-settings" | "role-default" | "override" | "explicit";
export interface TierResolved { value: string | null; source: TierSource; note?: string }

/**
 * 有效值（纯函数）。baseEffort = 调用方原本就带的 Codex 档（原档）；不给就以角色格为原档。原档是 null / 核实不了时 down1 不猜，照原样。
 * 读表坏了（invalid / unreadable）时 read.table 是默认表、tiers 不用。
 */
export function resolveTierModel(read: RoleModelRead, tier: TaskTier, role: CardRole, family: Family, baseEffort?: CodexEffort | null): TierResolved {
  const stored = read.status === "ok" ? read.table.tiers?.[tier]?.[role]?.[family] : undefined;
  const spec = stored !== undefined ? stored : TIER_DEFAULTS[tier][role][family];
  const own: TierSource = stored !== undefined ? "tier-settings" : "tier-default";
  const cell = roleModelOf(read, role, family);
  const roleSource: TierSource = cell.source === "settings" ? "role-settings" : "role-default";
  if (family === "claude") return spec === "inherit" ? { value: cell.value, source: roleSource } : { value: spec, source: own };
  const base = baseEffort !== undefined ? baseEffort : cell.value;
  const baseSource = baseEffort !== undefined ? own : roleSource;
  if (spec === "inherit") return { value: base, source: baseSource };
  if (spec === "down1") {
    return isEffort(base) ? { value: downgradeEffort(base), source: own } : { value: base, source: baseSource, note: "原档不可核实，不猜降档" };
  }
  return { value: spec, source: own };
}

/** security 下限：Claude 要 Opus 档；Codex 不低于已知原档（原档不可核实时无从比较，不拒） */
export function tierFloorProblem(tier: TaskTier, role: CardRole, family: Family, value: string | null, baseEffort: CodexEffort | null | undefined): string | null {
  if (tier !== "security") return null;
  if (family === "claude") return isOpusGrade(value) ? null : `security 卡的 ${role} 不得低于 Opus（要用 ${value ?? "未指定模型"}）`;
  if (!isEffort(baseEffort)) return null;
  return isEffort(value) && rank(value) >= rank(baseEffort) ? null : `security 卡的 ${role}（Codex）不得低于原档 ${baseEffort}（要用 ${value ?? "Codex 自己的配置"}）`;
}

/** Codex 原档（security 下限的比较基准）：调用方自带的档优先，不给就用角色格——与 resolveTierModel 同一口径；Claude 不用 */
function originalEffort(read: RoleModelRead, role: CardRole, family: Family, baseEffort: CodexEffort | null | undefined): CodexEffort | null | undefined {
  if (family !== "codex") return undefined;
  return baseEffort !== undefined ? baseEffort : roleModelOf(read, role, "codex").value as CodexEffort | null;
}

/** 扩展点 1：建作者会话前按项目 + 卡号问覆盖值（TIER3c 自动升档）；null = 不覆盖 */
export type AuthorTierOverride = (q: { project: string; card: string; tier: TaskTier; family: Family }) => string | null;
let override: AuthorTierOverride | null = null;
export function registerAuthorTierOverride(fn: AuthorTierOverride | null): void { override = fn; }

export interface TaskTierPort { policy: RecoveryPolicyPort; read: () => RoleModelRead; now: () => number }
const PRODUCTION: TaskTierPort = { policy: recoveryPolicy, read: () => readRoleModels(), now: Date.now };
let port = PRODUCTION;
/** Tests only: swap the production port (undefined = back to the file backed one). */
export function useTaskTierPort(p?: Partial<TaskTierPort>): void { port = p ? { ...PRODUCTION, ...p } : PRODUCTION; }

/** 共用门控：这个项目的 taskTierModels 现在是哪一档（后续卡同一个入口读） */
export function taskTierMode(project: string, p: TaskTierPort = port): { mode: "on" | "observe" | "off"; diagnostic?: string } {
  const policy = p.policy(project, TASK_TIER_KEY);
  const d = decideRecovery(policy);
  const mode = d.kind === "act" ? "on" : d.kind === "observe" ? "observe" : "off";
  return { mode, ...(policy.diagnostic ? { diagnostic: policy.diagnostic } : {}) };
}

/**
 * 开卡（start_node 预检）用哪个流程模板。on：按规格卡首唯一声明定类型，显式 template 参数只做核对（与声明不同 = 冲突拒）；
 * 声明坏 / 类型未注册拒；两边都没有 = code。off / observe：与旧路径一样只看参数（缺省 code），不读规格卡。
 * specText 是取规格正文的函数（只在 on 下调用；拿不到 = null，按没有声明）。
 */
export function tierStartTemplate(project: string, explicit: string | undefined, specText: () => string | null,
  p: TaskTierPort = port): { ok: true; template: string } | { ok: false; error: string } {
  if (taskTierMode(project, p).mode !== "on") return { ok: true, template: explicit ?? "code" };
  const text = specText();
  const decl = typeof text === "string" ? parseTaskTier(text) : null;
  if (decl && !decl.ok) return { ok: false, error: `规格卡首类型声明不对：${decl.error}` };
  const declared = decl?.ok && decl.source === "spec" ? decl.tier : null;
  if (explicit !== undefined && declared && explicit !== declared) {
    return { ok: false, error: `template 参数 ${explicit.slice(0, 40)} 与规格卡首声明 ${declared} 冲突，不按任何一边猜` };
  }
  const template = explicit ?? declared ?? "code";
  if (isTaskTier(template) && !tierLaunchable(template)) return { ok: false, error: `类型 ${template} 还没有注册流程模板，不能开卡` };
  return { ok: true, template };
}

/** 一次本机建会话的上下文：tier = 卡上存的流程模板；specText 给了就核对卡首声明；baseEffort = argv 里调用方自带的那一档（不当显式覆盖） */
export interface TierLaunchCtx {
  db?: Database; project: string; card: string; tier: string; specText?: string | null; specRev?: number; round?: number; baseEffort?: CodexEffort;
}

export type TierDecision =
  | { mode: "off" }
  | { mode: "observe"; diagnostic?: string }
  | { mode: "on"; value: string | null; plan: LaunchPlan }
  | { mode: "on"; error: string; plan: LaunchPlan };

/**
 * 这次 create 该用什么（不写盘，记事件由 card-role-definitions.ts 的包装做）。explicit = argv 里调用方显式给的 --model / --effort（不含 baseEffort）。
 * on 下优先级：显式 > 覆盖扩展点（只作者）> 类型解析；无论哪个来源，security 下限都要过，过不了就拒。
 */
export function decideTierLaunch(ctx: TierLaunchCtx, role: CardRole, family: Family, explicit: string | null, agent: string | null,
  p: TaskTierPort = port): TierDecision {
  const gate = taskTierMode(ctx.project, p);
  if (gate.mode === "off") return { mode: "off" };
  const at = tierAtLaunch(ctx.tier ? { template: ctx.tier, specRev: ctx.specRev ?? 0 } : null, ctx.specText);
  const tier: TaskTier = at.ok ? at.tier : isTaskTier(ctx.tier) ? ctx.tier : "code";
  const read = p.read();
  const bad = read.status === "invalid" || read.status === "unreadable" ? `模型档位表${read.status === "invalid" ? "内容不合法" : "读不了"}：${read.error}` : null;
  const r = resolveTierModel(read, tier, role, family, ctx.baseEffort);
  const base = originalEffort(read, role, family, ctx.baseEffort);
  if (gate.mode === "observe") {
    observe(ctx, role, family, tier, r, p);
    return { mode: "observe", ...(bad || !at.ok ? { diagnostic: bad ?? (at as { error: string }).error } : {}) };
  }
  const ov = role === "author" && override ? override({ project: ctx.project, card: ctx.card, tier, family }) : null;
  const ovBlocked = ov !== null ? tierFloorProblem(tier, role, family, ov, base) : null;
  const pick: TierResolved = explicit !== null ? { value: explicit, source: "explicit" }
    : ov !== null && !ovBlocked ? { value: ov, source: "override" } : r;
  const note = [r.note, ovBlocked ? `覆盖值 ${ov} 低于安全下限，不用` : null, bad].filter(Boolean).join("；") || undefined;
  const plan: LaunchPlan = { project: ctx.project, card: ctx.card, role, tier, family, round: ctx.round ?? 0, launchId: newLaunchId(ctx.card, role, ctx.round ?? 0),
    agent, suggested: r.value, final: family === "claude" ? { model: pick.value, effort: null } : { model: null, effort: pick.value }, source: pick.source,
    ...(note ? { note } : {}) };
  if (!at.ok) return { mode: "on", error: `类型核对不过：${at.error}`, plan };
  if (bad && tier === "security") return { mode: "on", error: `${bad}；security 卡核实不了下限，不启动`, plan };
  const floor = tierFloorProblem(tier, role, family, pick.value, base);
  if (floor) return { mode: "on", error: floor, plan };
  return { mode: "on", value: pick.value, plan };
}

/** observe：记一条 would-use（同卡同角色同值一条）；没有台账或卡不在这本台账就不记，记不上不挡建卡 */
function observe(ctx: TierLaunchCtx, role: CardRole, family: Family, tier: TaskTier, r: TierResolved, p: TaskTierPort): void {
  if (!ctx.db || getTask(ctx.db, ctx.card)?.project !== ctx.project) return;
  const value = r.value ?? "codex-config";
  try {
    recordObserved(ledgerWriter(ctx.db), { project: ctx.project, mechanism: TASK_TIER_KEY, target: ctx.card, actionKey: `task-tier:${tier}:${role}:${family}:${value}`,
      action: `按任务类型 ${tier} 给 ${role}（${family}）用 ${r.value ?? "Codex 自己的配置"}（来源 ${r.source}）`,
      data: { tier, role, family, wouldUse: r.value, source: r.source, ...(r.note ? { note: r.note } : {}) } }, p.now());
  } catch (e) { console.error(`[task-tier] 记 ${ctx.card} 的 would-use 失败（建卡照旧）：${(e as Error).message}`); }
}

/**
 * 扩展点 2 的门：派单前 / 交付时跑 task-tier-spec.ts 注册的校验钩子。off 不调用；observe 只记会拒的原因、放行；on 返回拒绝原因并记事件。
 * 事件挂卡上（卡还没建就挂项目，target ""）。
 */
export function tierCheckGate(db: Database | null, phase: TierCheckPhase, ctx: TierCheckCtx, p: TaskTierPort = port): string | null {
  const { mode } = taskTierMode(ctx.project, p);
  if (mode === "off") return null;
  const why = runTierChecks(phase, ctx);
  if (!why) return null;
  if (db) {
    const target = getTask(db, ctx.taskId)?.project === ctx.project ? ctx.taskId : "";
    try {
      // 预检每轮都会重跑：同一卡、同一阶段、同一原因只记一条
      const dedupKey = `task-tier-check:${createHash("sha256").update(JSON.stringify([ctx.project, ctx.taskId, phase, mode, why])).digest("hex").slice(0, 24)}`;
      appendEvent(ledgerWriter(db), { actor: "scheduler", now: p.now(), dedupKey }, { project: ctx.project, target, kind: "note",
        text: `类型校验（${phase === "dispatch" ? "派单前" : "交付时"}）${mode === "on" ? "拒绝" : "本会拒绝"} ${ctx.taskId}：${why}`.slice(0, 600),
        data: { op: "task_tier_check", phase, taskId: ctx.taskId, tier: ctx.tier, mode, reason: why } });
    } catch (e) { console.error(`[task-tier] 记 ${ctx.taskId} 的类型校验事件失败：${(e as Error).message}`); }
  }
  return mode === "on" ? why : null;
}

/**
 * 调用点用的绑定层：会话已证实（有 session id）才绑；taskTierModels off 一律不绑（off 不增加事件，旧的未绑尝试留着，历史只读照查）。
 * 记不上只少一条事实，不改建会话的结论。
 */
export function bindTierSession(db: Database, task: { project: string; id: string }, agent: string, sessionId: string, role: string, p: TaskTierPort = port): void {
  try {
    if (taskTierMode(task.project, p).mode === "off") return;
    bindLaunchSession(db, { project: task.project, card: task.id, role, agent, sessionId });
  } catch (e) {
    console.error(`[task-tier] ${task.id} ${role} 的启动事实没绑上会话：${(e as Error).message}`);
  }
}
