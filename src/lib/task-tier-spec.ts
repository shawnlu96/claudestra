/**
 * 任务类型（TIER3）：security / code / ui / docs。类型只认规格卡首唯一的「模板：」声明（spec-lint-head.ts scanSpecHead，与调度模板选择同一段），
 * 缺声明 = code，重复 / 不认识 = 明确诊断，不猜。开卡时类型与规格版本随 task_workflows（template + specRev）存下，启动时 tierAtLaunch 再核对。
 * docs 只在模型表里有：注册表（registerTierTemplate）里没有它之前，tierLaunchable 拒、dag-tools-start 也拒开卡（TIER3e 注册后才可达）。
 * 派单前 / 交付时的校验钩子（registerTierChecks）缺省为空；门控（taskTierModels off 不调用）在 task-tier-models.ts tierCheckGate。
 * tests/task-tier-spec.test.ts。
 */
import { scanSpecHead } from "./spec-lint-head.js";

export const TASK_TIERS = ["security", "code", "ui", "docs"] as const;
export type TaskTier = (typeof TASK_TIERS)[number];
export const isTaskTier = (v: unknown): v is TaskTier => TASK_TIERS.includes(v as TaskTier);

export type TierDecl = { ok: true; tier: TaskTier; source: "spec" | "default" } | { ok: false; code: "duplicate" | "unknown"; error: string };

/** 卡首的类型声明：不扫正文，标题前的文字不算（与 scheduler-autostart.ts parseSpecHead 同一份扫描） */
export function parseTaskTier(text: string): TierDecl {
  const { decls } = scanSpecHead(text);
  if (decls.length > 1) return { ok: false, code: "duplicate", error: `卡首写了 ${decls.length} 行模板声明，只能有一行` };
  if (!decls.length) return { ok: true, tier: "code", source: "default" };
  const v = decls[0].toLowerCase();
  if (!isTaskTier(v)) return { ok: false, code: "unknown", error: `模板「${decls[0].slice(0, 40)}」不认识（只认 ${TASK_TIERS.join(" / ")}）` };
  return { ok: true, tier: v, source: "spec" };
}

/** 已有流程模板的三种天生可开卡；docs 等新类型要由新模块注册（TIER3e） */
const BUILTIN: readonly TaskTier[] = ["code", "ui", "security"];
const registered = new Set<TaskTier>();

/** 注册一个可开卡 / 可启动的类型；返回撤销函数（测试用）。内建的三种重复注册无副作用 */
export function registerTierTemplate(tier: TaskTier): () => void {
  if (BUILTIN.includes(tier) || registered.has(tier)) return () => undefined;
  registered.add(tier);
  return () => { registered.delete(tier); };
}
export const tierLaunchable = (tier: TaskTier): boolean => BUILTIN.includes(tier) || registered.has(tier);

export interface StoredTier { template: string; specRev: number }
export type TierAtLaunch = { ok: true; tier: TaskTier; source: "workflow" | "spec" | "default" } | { ok: false; code: string; error: string };

/**
 * 启动核对：卡上存的流程模板（开卡时的类型）与现在规格卡首的声明一致才起；声明坏、与已存流程冲突、类型未注册一律拒并给原因。
 * specText 不给（读不到规格卡）= 只认已存流程；都没有 = code。
 */
export function tierAtLaunch(stored: StoredTier | null, specText: string | null | undefined): TierAtLaunch {
  const decl = typeof specText === "string" ? parseTaskTier(specText) : null;
  if (decl && !decl.ok) return { ok: false, code: decl.code, error: decl.error };
  if (stored && !isTaskTier(stored.template)) return { ok: false, code: "unknown", error: `卡上流程模板「${stored.template.slice(0, 40)}」不是已知类型` };
  const fromStore = stored?.template as TaskTier | undefined;
  // 缺声明不算声明（缺省 code 不与已存流程冲突）；只有卡首明写了另一类型才算冲突
  if (fromStore && decl?.ok && decl.source === "spec" && decl.tier !== fromStore) {
    return { ok: false, code: "conflict", error: `规格卡首声明 ${decl.tier} 与卡上已存流程 ${fromStore}（规格第 ${stored!.specRev} 版开卡）冲突，不按任何一边猜` };
  }
  const tier = fromStore ?? (decl?.ok ? decl.tier : "code");
  if (!tierLaunchable(tier)) return { ok: false, code: "unregistered", error: `类型 ${tier} 还没有注册流程模板，不能启动` };
  return { ok: true, tier, source: fromStore ? "workflow" : decl?.ok && decl.source === "spec" ? "spec" : "default" };
}

/** 派单前 / 交付时校验的输入：文件范围是 fileGlobs 快照，files 是交付时实际改到的文件（派单前不给） */
export interface TierCheckCtx { project: string; taskId: string; tier: TaskTier; fileGlobs: readonly string[]; files?: readonly string[] }
/** 返回拒绝原因 = 停派 / 不收交付；null = 放行 */
export type TierCheck = (ctx: TierCheckCtx) => string | null;
export type TierCheckPhase = "dispatch" | "delivery";
const checks: Record<TierCheckPhase, TierCheck[]> = { dispatch: [], delivery: [] };

/** 新模块挂校验钩子；返回撤销函数。缺省两边都是空表，放行 */
export function registerTierChecks(c: Partial<Record<TierCheckPhase, TierCheck>>): () => void {
  const added = (Object.keys(c) as TierCheckPhase[]).map((phase) => { checks[phase].push(c[phase]!); return [phase, c[phase]!] as const; });
  return () => { for (const [phase, fn] of added) checks[phase].splice(checks[phase].indexOf(fn), 1); };
}

/** 依次跑这一阶段的钩子，第一条拒绝原因即结论；钩子抛错也算拒绝（校验不了不放行） */
export function runTierChecks(phase: TierCheckPhase, ctx: TierCheckCtx): string | null {
  for (const fn of checks[phase]) {
    let why: string | null;
    try { why = fn(ctx); } catch (e) { why = `校验钩子出错：${(e as Error).message}`; }
    if (why) return why.slice(0, 300);
  }
  return null;
}
