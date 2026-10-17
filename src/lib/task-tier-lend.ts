/**
 * 出借协议里的任务类型档位（TIER3b）。两端各自看自己的 taskTierModels 恢复键（task-tier-models.ts taskTierMode），任一端都不替对端开：
 * - A（借入方）：claim 给建议时，键 on 就用「类型 × 角色」有效值（resolveTierModel）替换旧的角色格值，并在本机 claim 事件里记类型信息（suggestTier）；
 *   过不了 TIER3 security 下限就不给建议。键不是 on = 旧 roleModel 路径一字不变（role-model-settings-lend.ts claimSuggest）。
 *   wire 形状不变（{ model | effort, source }，仍在 suggestDigest 里），旧 B 收到的仍是它认得的建议。
 * - B（出借方）：本机键 on + 「接受降档建议」开（task-tier-lend-settings.ts，缺省开）+ 建议对得上家族 + 能从 A 的派单全文（claim 时已核 sha256）
 *   核出唯一的任务类型时，才在授权内选档：只等于或低于授权档，不升档；Claude 授权没写上限时以 Opus 为上限；Codex 用授权 effort 与 CODEX_EFFORT_LEVELS
 *   有序表比，授权没写档 / 排不出位置不猜。security 不接受降档，最终值再过 tierFloorProblem，证明不了下限就拒绝启动。
 *   任一条件不满足 = 授权原参数（与改前逐字一致），active 的才给偏离原因。
 * tests/task-tier-lend.test.ts。
 */
import type { Database } from "bun:sqlite";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getMeta, setMeta } from "./lend-journal.js";
import type { ModelSuggest } from "./lend-wire-types.js";
import type { CardRole, RoleModelRead } from "./role-model-settings.js";
import { roleModelOf } from "./role-model-settings.js";
import { parseModelSuggest, suggestFamilyProblem } from "./role-model-settings-wire.js";
import { isOpusGrade, type CodexEffort } from "./task-tier-model-settings.js";
import { resolveTierModel, taskTierMode, tierFloorProblem } from "./task-tier-models.js";
import { isTaskTier, tierAtLaunch, type TaskTier } from "./task-tier-spec.js";
import { readTierLendSettings, TIER_LEND_SETTINGS_PATH } from "./task-tier-lend-settings.js";

/** B 起出借 worker 时挂的本机项目（lend-deps.ts LEND_PROJECT）：B 的恢复键按它读 */
const LEND_LOCAL_PROJECT = "lend";

// ── A：类型 × 角色的建议 ──

/** 记进 claim 事件 data.lend.suggestTier 的类型信息（可在 A 的台账上核对建议从哪来） */
export interface SuggestTierInfo { tier: TaskTier; role: CardRole; source: string }
export type TierSuggest = { suggest: ModelSuggest; info: SuggestTierInfo } | { diagnostic: string };

/**
 * A 的 taskTierModels 不是 on = null（调用方走旧角色格路径）。on 时按卡上存的流程模板定类型（tierAtLaunch，不在领单事务里读规格卡），
 * 解析有效值并过 security 下限；类型核对不过 / 下限不过 = 不给建议并给诊断。
 */
export function tierLendSuggest(db: Database, o: { project: string; taskId: string; family: "claude" | "codex" }, role: CardRole,
  read: RoleModelRead): TierSuggest | null {
  if (taskTierMode(o.project).mode !== "on") return null;
  const w = getWorkflow(db, o.taskId);
  const at = tierAtLaunch(w ? { template: w.template, specRev: w.specRev ?? 0 } : null, null);
  if (!at.ok) return { diagnostic: `任务类型核对不过，不给建议：${at.error}` };
  const r = resolveTierModel(read, at.tier, role, o.family);
  const base = o.family === "codex" ? roleModelOf(read, role, "codex").value as CodexEffort | null : undefined;
  const floor = tierFloorProblem(at.tier, role, o.family, r.value, base);
  if (floor) return { diagnostic: `${floor}，不给建议` };
  const source = r.source === "tier-settings" || r.source === "role-settings" ? "settings" : "default";
  if (o.family === "claude" && typeof r.value !== "string") return { diagnostic: "类型解析没有得出 Claude 模型，不给建议" };
  const suggest: ModelSuggest = o.family === "claude" ? { model: r.value as string, source } : { effort: r.value, source };
  return { suggest, info: { tier: at.tier, role, source: r.source } };
}

// ── B：授权内选档 ──

/** A 派单全文里规格卡首的「模板:X」声明（原文行可能带「」引号）；没有、多个不同、或不认识 = null（核不出就不降档） */
export function tierFromMaterial(text: string | null | undefined): TaskTier | null {
  if (typeof text !== "string") return null;
  const found = new Set<string>();
  for (const m of text.matchAll(/^[ \t]*「?[ \t]*模板[ \t]*[:：][ \t]*([A-Za-z]+)[ \t]*」?[ \t]*$/gm)) found.add(m[1]!.toLowerCase());
  const [only] = [...found];
  return found.size === 1 && isTaskTier(only) ? only : null;
}

const CLAUDE_GRADES = ["haiku", "sonnet", "opus"] as const;
/** Claude 型号档：haiku < sonnet < opus；认不出 = -1（排不出位置） */
const claudeGrade = (model: string | null | undefined): number =>
  typeof model === "string" ? CLAUDE_GRADES.findIndex((g) => new RegExp(`^claude-${g}-[a-z0-9.-]+$`).test(model)) : -1;
const effortRank = (e: unknown): number => CODEX_EFFORT_LEVELS.indexOf(e as CodexEffort);
const argAfter = (args: readonly string[], flag: string): string | null => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1]! : null; };

export interface LendChoiceInput {
  family: string;
  role: CardRole | null;
  /** A 的派单全文（B 在 claim 时已核过 sha256） */
  text: string | null;
  suggest: ModelSuggest | null | undefined;
  /** 授权原参数（lend-grant-spawn.ts choiceArgs）：codex 的 --model / --effort，claude 恒为 [] */
  grantArgs: readonly string[];
  /** Claude 授权上限（完整模型 id）；不写 = Opus */
  claudeCap?: string | null;
}
export interface LendGate { on: boolean; acceptDowngrade: boolean }
/**
 * active = 走了本卡的选择（键 on、开关开、带了建议）；false 时 args 就是授权原参数，调用方不得记任何新东西。
 * accepted = 用了建议；reason = 没用 / 偏离的原因；refuse = 证明不了 security 下限，不启动。
 */
export interface LendChoice { args: string[]; active: boolean; accepted: boolean; tier: TaskTier | null; reason?: string; refuse?: string }

const keep = (i: LendChoiceInput, tier: TaskTier | null, reason: string): LendChoice => ({ args: [...i.grantArgs], active: true, accepted: false, tier, reason });

function claudeChoice(i: LendChoiceInput, tier: TaskTier, want: string): LendChoice {
  const cap = i.claudeCap ?? null;
  const capGrade = cap ? claudeGrade(cap) : CLAUDE_GRADES.indexOf("opus");
  const g = claudeGrade(want);
  const c: LendChoice = g < 0 || capGrade < 0 ? keep(i, tier, `核不出 ${want} 与授权上限 ${cap ?? "Opus"} 的排序，不猜档`)
    : g > capGrade ? (cap ? { args: ["--model", cap], active: true, accepted: false, tier, reason: `建议的 ${want} 高于授权上限 ${cap}，不升档，用上限` }
      : keep(i, tier, `建议的 ${want} 高于授权上限，不升档`))
    : tier === "security" && !isOpusGrade(want) ? keep(i, tier, `security 不接受降档建议（建议 ${want}）`)
    : { args: ["--model", want], active: true, accepted: true, tier };
  // 最终值过 TIER3 下限：security 带不出 Opus 档的 --model（照本机默认起）= 证明不了，不启动
  const floor = tierFloorProblem(tier, i.role!, "claude", argAfter(c.args, "--model"), undefined);
  return floor ? { ...c, refuse: `${floor}，不启动` } : c;
}

function codexChoice(i: LendChoiceInput, tier: TaskTier, want: string | null): LendChoice {
  const granted = argAfter(i.grantArgs, "--effort");
  if (want === null) return keep(i, tier, "建议不指定推理档，照授权");
  if (granted === null) return keep(i, tier, `授权没写推理档，核不出 ${want} 是否不高于授权，不猜档`);
  const w = effortRank(want), g = effortRank(granted);
  if (w < 0 || g < 0) return keep(i, tier, `核不出 ${want} 与授权档 ${granted} 的排序，不猜档`);
  if (w > g) return keep(i, tier, `建议的 ${want} 高于授权档 ${granted}，不升档，照授权`);
  if (w < g && tier === "security") return keep(i, tier, `security 不接受降档建议（建议 ${want}，授权 ${granted}）`);
  const floor = tierFloorProblem(tier, i.role!, "codex", want, granted as CodexEffort);
  if (floor) return { ...keep(i, tier, floor), refuse: `${floor}，不启动` }; // 上面已挡住 security 降档；留着兜住 TIER3 下限口径的变化
  const model = argAfter(i.grantArgs, "--model");
  return { args: [...(model ? ["--model", model] : []), "--effort", want], active: true, accepted: true, tier };
}

/** 纯函数：B 这一单最终带给 manager create 的 --model / --effort */
export function lendLaunchChoice(i: LendChoiceInput, gate: LendGate): LendChoice {
  if (!gate.on || !gate.acceptDowngrade || !i.suggest) return { args: [...i.grantArgs], active: false, accepted: false, tier: null };
  const s = parseModelSuggest(i.suggest);
  if (typeof s === "string" || suggestFamilyProblem(i.family, s)) return keep(i, null, `建议不可验证（${typeof s === "string" ? s : "与家族对不上"}），照授权`);
  if (!i.role) return keep(i, null, "这个节点不在档位表里，照授权");
  const tier = tierFromMaterial(i.text);
  if (!tier) return keep(i, null, "派单材料里核不出唯一的任务类型，不接受降档，照授权");
  return "model" in s ? claudeChoice(i, tier, s.model) : codexChoice(i, tier, s.effort);
}

/** B 本机的门：taskTierModels（项目 lend）是 on 且「接受降档建议」开；设置文件坏按关 */
export function tierLendGate(settingsPath = TIER_LEND_SETTINGS_PATH): LendGate {
  if (taskTierMode(LEND_LOCAL_PROJECT).mode !== "on") return { on: false, acceptDowngrade: false };
  return { on: true, acceptDowngrade: readTierLendSettings(settingsPath).settings.acceptDowngrade };
}

// ── B：选择记录（只 active 才写；启动事实仍由 role-model-settings-lend.ts recordLendLaunch 一处落） ──

const choiceKey = (orderId: string): string => `tier-lend-choice:${orderId}`;
export interface ChoiceNote { args: string[]; accepted: boolean; tier: TaskTier | null; reason?: string }

export function noteLendChoice(db: Database, orderId: string, c: LendChoice): void {
  if (!c.active) return;
  setMeta(db, choiceKey(orderId), JSON.stringify({ args: c.args, accepted: c.accepted, tier: c.tier, ...(c.reason ? { reason: c.reason } : {}) }));
}

/** 起 worker 时记下的选择；args 要和这次真正带的一致才算（否则是别的一次的，不认） */
export function lendChoiceFor(db: Database, orderId: string, args: readonly string[]): ChoiceNote | null {
  const raw = getMeta(db, choiceKey(orderId));
  if (!raw) return null;
  let v: ChoiceNote;
  try { v = JSON.parse(raw) as ChoiceNote; } catch { return null; /* 自己写的读不回来：当没记 */ }
  const flags = args.filter((a, k) => a === "--model" || a === "--effort" || args[k - 1] === "--model" || args[k - 1] === "--effort");
  return Array.isArray(v.args) && JSON.stringify(v.args) === JSON.stringify(flags) ? v : null;
}
